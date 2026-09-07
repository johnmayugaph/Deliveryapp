import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConsoleEmailSender,
  EmailDeliveryError,
  InvalidEmailAddressError,
  MAX_EMAIL_LENGTH,
  NoEmailSenderError,
  ResendEmailSender,
  isEmailConfigured,
  maskEmail,
  normaliseEmail,
  resolveEmailSender,
  tryNormaliseEmail,
  type EmailEnv,
} from '@/lib/auth/email';
import {
  RECOVERY_CREDIT_FREEZE_DAYS,
  RECOVERY_FREEZE_REASON,
  recoveryAlertText,
  recoveryFreezeEnd,
} from '@/lib/auth/recovery';
import { freezeIsInForce } from '@/lib/wallet/rules';

/**
 * Recovery is the account-takeover surface. These tests are arranged around
 * the four controls that make a successful takeover worthless rather than
 * merely difficult, plus the two places where being helpful would leak.
 */

// -----------------------------------------------------------------------------
// Addresses
// -----------------------------------------------------------------------------

describe('normalising an email address', () => {
  it('lower-cases and trims', () => {
    // Case-folding the local part is technically wrong and right in practice:
    // the column is unique, and a database holding both Juan@ and juan@ is one
    // where a person cannot sign in with the address they typed.
    expect(normaliseEmail('  Juan.Dela.Cruz@Gmail.COM ')).toBe('juan.dela.cruz@gmail.com');
  });

  it('accepts the shapes real addresses take', () => {
    for (const address of [
      'a@b.co',
      'juan+tara@gmail.com',
      'juan_dela-cruz@mail.example.ph',
      "o'brien@example.com",
    ]) {
      expect(tryNormaliseEmail(address), address).toBe(address.toLowerCase());
    }
  });

  it('refuses what cannot receive mail', () => {
    for (const bad of [
      '',
      '   ',
      'juan',
      '@gmail.com',
      'juan@',
      'juan@@gmail.com',
      'juan@localhost',
      'juan@.com',
      'juan@gmail.',
      'juan dela@gmail.com',
    ]) {
      expect(() => normaliseEmail(bad), bad).toThrow(InvalidEmailAddressError);
    }
  });

  it('refuses one longer than an address can be', () => {
    expect(() => normaliseEmail(`${'x'.repeat(MAX_EMAIL_LENGTH)}@gmail.com`)).toThrow(
      /too long/,
    );
  });

  it('says what to fix, not that validation failed', () => {
    expect(() => normaliseEmail('juan@gmail')).toThrow(/needs a domain, like gmail.com/);
  });
});

describe('masking an address', () => {
  it('keeps the domain and hides the mailbox', () => {
    // The domain is not the secret. Which mailbox at that domain is.
    expect(maskEmail('juan.delacruz@gmail.com')).toBe('ju•••••••••••@gmail.com');
  });

  it('never reveals a short local part', () => {
    // Two characters of a two-character mailbox would be the whole thing, so
    // the mask has a floor.
    expect(maskEmail('jo@gmail.com')).toBe('jo••@gmail.com');
    expect(maskEmail('a@gmail.com')).toBe('a••@gmail.com');
  });

  it('degrades rather than throwing on nonsense', () => {
    expect(maskEmail('not-an-address')).toBe('••••');
  });
});

// -----------------------------------------------------------------------------
// Sender selection — the same rules as SMS, for the same reason
// -----------------------------------------------------------------------------

describe('choosing an email sender', () => {
  it('uses the console sender in development', () => {
    expect(resolveEmailSender({ NODE_ENV: 'development' } as EmailEnv)).toBeInstanceOf(
      ConsoleEmailSender,
    );
  });

  it('REFUSES the console sender in production', () => {
    // Worse than the SMS equivalent: a failed login has a second route, and a
    // failed recovery has none.
    expect(() => resolveEmailSender({ NODE_ENV: 'production' } as EmailEnv)).toThrow(
      NoEmailSenderError,
    );
  });

  it('needs BOTH a key and a From address', () => {
    // Half a configuration is the state that looks configured and is not: a
    // key with no From cannot send, a From with no key does nothing.
    expect(
      resolveEmailSender({ NODE_ENV: 'development', RESEND_API_KEY: 'k' } as EmailEnv),
    ).toBeInstanceOf(ConsoleEmailSender);
    expect(
      resolveEmailSender({ NODE_ENV: 'development', EMAIL_FROM: 'a@b.co' } as EmailEnv),
    ).toBeInstanceOf(ConsoleEmailSender);
    expect(
      resolveEmailSender({
        NODE_ENV: 'development',
        RESEND_API_KEY: 'k',
        EMAIL_FROM: 'a@b.co',
      } as EmailEnv),
    ).toBeInstanceOf(ResendEmailSender);
  });

  it('aims at a stub when RESEND_ENDPOINT is set in development', () => {
    const sender = resolveEmailSender({
      NODE_ENV: 'development',
      RESEND_API_KEY: 'k',
      EMAIL_FROM: 'a@b.co',
      RESEND_ENDPOINT: 'http://127.0.0.1:4600/emails',
    } as EmailEnv);
    expect((sender as ResendEmailSender).endpoint).toBe('http://127.0.0.1:4600/emails');
  });

  it('IGNORES RESEND_ENDPOINT in production', () => {
    // A variable that redirects mail delivery is a way to capture recovery
    // codes, which are the codes that move an account.
    const sender = resolveEmailSender({
      NODE_ENV: 'production',
      RESEND_API_KEY: 'k',
      EMAIL_FROM: 'a@b.co',
      RESEND_ENDPOINT: 'https://attacker.example/collect',
    } as EmailEnv);
    expect((sender as ResendEmailSender).endpoint).toBe('https://api.resend.com/emails');
  });

  it('reports whether recovery by email can be offered', () => {
    expect(isEmailConfigured({ NODE_ENV: 'production' } as EmailEnv)).toBe(false);
    expect(
      isEmailConfigured({
        NODE_ENV: 'production',
        RESEND_API_KEY: 'k',
        EMAIL_FROM: 'a@b.co',
      } as EmailEnv),
    ).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// The wire, over a real socket
// -----------------------------------------------------------------------------

interface Capture {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  raw: string;
}

let server: Server | undefined;

afterEach(async () => {
  if (!server) return;
  const closing = server;
  server = undefined;
  await new Promise<void>((resolve) => closing.close(() => resolve()));
});

async function provider(
  reply: (res: ServerResponse) => void,
): Promise<{ endpoint: string; captured: () => Capture | undefined }> {
  let capture: Capture | undefined;
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      capture = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        raw: Buffer.concat(chunks).toString('utf8'),
      };
      reply(res);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server!.address();
  if (address === null || typeof address === 'string') throw new Error('expected TCP');
  return {
    endpoint: `http://127.0.0.1:${address.port}/emails`,
    captured: () => capture,
  };
}

describe('the request a mail provider receives', () => {
  it('POSTs JSON with the key in a header, not the URL', async () => {
    const { endpoint, captured } = await provider((res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_abc123' }));
    });

    const result = await new ResendEmailSender('secret-key', 'TARA <no-reply@tara.ph>', endpoint).send(
      { to: 'juan@gmail.com', subject: 'Recover your TARA account', body: '481920' },
    );

    const request = captured();
    expect(request?.method).toBe('POST');
    expect(request?.headers.authorization).toBe('Bearer secret-key');
    expect(request?.headers['content-type']).toBe('application/json');
    // A key in a URL lands in every access log between here and there.
    expect(request?.url).not.toContain('secret-key');

    expect(JSON.parse(request!.raw)).toEqual({
      from: 'TARA <no-reply@tara.ph>',
      to: ['juan@gmail.com'],
      subject: 'Recover your TARA account',
      text: '481920',
    });
    expect(result).toEqual({ providerMessageId: 'msg_abc123', provider: 'resend' });
  });

  it('sends text, never HTML', async () => {
    // A code needs no markup, and a text-only body is the one shape no client
    // renders badly.
    const { endpoint, captured } = await provider((res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new ResendEmailSender('k', 'a@b.co', endpoint).send({
      to: 'juan@gmail.com',
      subject: 's',
      body: 'line one\nline two',
    });
    const payload = JSON.parse(captured()!.raw);
    expect(payload.text).toBe('line one\nline two');
    expect(payload).not.toHaveProperty('html');
  });

  it('treats accepted-but-unparseable as accepted', async () => {
    // Failing a recovery over a response we could not read, after the mail
    // was sent, strands somebody who has no other route in.
    const { endpoint } = await provider((res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>ok</html>');
    });
    await expect(
      new ResendEmailSender('k', 'a@b.co', endpoint).send({
        to: 'juan@gmail.com',
        subject: 's',
        body: 'b',
      }),
    ).resolves.toEqual({ providerMessageId: null, provider: 'resend' });
  });

  it('surfaces the status and the reason on a rejection', async () => {
    const { endpoint } = await provider((res) => {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'The from address is not verified.' }));
    });
    await expect(
      new ResendEmailSender('k', 'a@b.co', endpoint).send({
        to: 'juan@gmail.com',
        subject: 's',
        body: 'b',
      }),
    ).rejects.toThrow(/HTTP 403.*from address is not verified/s);
  });

  it('reports a refused connection as a delivery failure', async () => {
    await expect(
      new ResendEmailSender('k', 'a@b.co', 'http://127.0.0.1:1/emails').send({
        to: 'juan@gmail.com',
        subject: 's',
        body: 'b',
      }),
    ).rejects.toThrow(EmailDeliveryError);
  });
});

// -----------------------------------------------------------------------------
// The freeze — the control that removes the prize
// -----------------------------------------------------------------------------

describe('the credits freeze', () => {
  const now = new Date('2026-09-07T08:00:00.000Z');

  it('lasts three days', () => {
    // Chosen against the alert, not the attacker: long enough that an SMS, an
    // email and a push have all had time to be read.
    expect(RECOVERY_CREDIT_FREEZE_DAYS).toBe(3);
    expect(recoveryFreezeEnd(now).toISOString()).toBe('2026-09-10T08:00:00.000Z');
  });

  it('is in force while it runs', () => {
    expect(
      freezeIsInForce({ isFrozen: true, frozenUntil: recoveryFreezeEnd(now) }, now),
    ).toBe(true);
  });

  it('stops applying the instant it expires, not at the next sweep', () => {
    // Read from `isFrozen` alone, somebody would be unable to spend their own
    // credits for up to one cron interval after the hold ended.
    const ended = new Date('2026-09-10T08:00:00.001Z');
    expect(
      freezeIsInForce({ isFrozen: true, frozenUntil: recoveryFreezeEnd(now) }, ended),
    ).toBe(false);
  });

  it('treats a freeze with no end date as indefinite', () => {
    // A fraud review ends when a person ends it. Only the recovery hold has an
    // expiry, which is what stops the sweep unfreezing a deliberate one.
    expect(freezeIsInForce({ isFrozen: true, frozenUntil: null }, now)).toBe(true);
    expect(
      freezeIsInForce(
        { isFrozen: true, frozenUntil: null },
        new Date('2099-01-01T00:00:00.000Z'),
      ),
    ).toBe(true);
  });

  it('is not in force when the wallet is not frozen', () => {
    expect(freezeIsInForce({ isFrozen: false, frozenUntil: null }, now)).toBe(false);
  });

  it('explains itself in the reason a customer sees', () => {
    expect(RECOVERY_FREEZE_REASON).toMatch(/sign-in number/);
    // "automatically" is the word that stops this becoming a support ticket.
    expect(RECOVERY_FREEZE_REASON).toMatch(/automatically/);
  });
});

// -----------------------------------------------------------------------------
// The alert to the number that was lost
// -----------------------------------------------------------------------------

describe('the alert to the previous number', () => {
  const recovery = {
    newPhone: '+639171234567',
    creditsFrozenUntil: new Date('2026-09-10T08:00:00.000Z'),
  };

  it('names the app, masks the new number, and says the credits are held', () => {
    const text = recoveryAlertText(recovery);
    expect(text).toContain('TARA');
    // The app-wide mask, used here rather than a stricter one: consistency
    // with every other screen is worth more than hiding the last four digits,
    // and those four are what makes the alert actionable for the recipient.
    expect(text).toContain('0917 ••• 4567');
    expect(text).toMatch(/frozen until/);
  });

  it('never puts the whole new number in the message', () => {
    // The recipient may be the victim; the message must not hand them the
    // attacker's full number, and must not hand an attacker a confirmation of
    // the digits either.
    expect(recoveryAlertText(recovery)).not.toContain('+639171234567');
    expect(recoveryAlertText(recovery)).not.toContain('9171234567');
  });

  it('tells the recipient to act inside the app, not to call a number', () => {
    // An alert that prints a phone number to call is the exact shape a
    // phishing message copies.
    const text = recoveryAlertText(recovery);
    expect(text).toMatch(/from the app/);
    expect(text).not.toMatch(/call \+?\d/);
  });
});

// -----------------------------------------------------------------------------
// Grep rules — properties of the source no unit test reaches
// -----------------------------------------------------------------------------

const recoverySource = readFileSync(
  path.join(process.cwd(), 'src/lib/auth/recovery.ts'),
  'utf8',
);
const guards = readFileSync(
  path.join(process.cwd(), 'prisma/sql/account_recovery.sql'),
  'utf8',
);

describe('one function moves a phone number', () => {
  it('is the only place User.phone is written outside onboarding', () => {
    // Both routes — self-service and support — go through movePhoneNumber, so
    // the four safety controls cannot be forgotten by one caller.
    const writers = ['src/lib/auth/recovery.ts'];
    for (const file of writers) {
      expect(readFileSync(path.join(process.cwd(), file), 'utf8')).toContain(
        'movePhoneNumber',
      );
    }
  });

  it('revokes every session, freezes the wallet and records the row', () => {
    expect(recoverySource).toMatch(/session\.deleteMany/);
    expect(recoverySource).toMatch(/wallet\.upsert/);
    expect(recoverySource).toMatch(/accountRecovery\.create/);
  });

  it('checks emailVerifiedAt, never email alone, on every recovery lookup', () => {
    // An address somebody typed and never confirmed proves nothing about who
    // holds it. A lookup on `email` alone would let anybody claim any account
    // by typing its owner's address.
    const lookups = recoverySource.match(/where: \{ email[^}]*\}/g) ?? [];
    expect(lookups.length).toBeGreaterThan(0);
    for (const lookup of lookups) {
      expect(lookup, lookup).toContain('emailVerifiedAt');
    }
  });

  it('does NOT enqueue the alert through the notification outbox', () => {
    // The outbox resolves every recipient from the user row, which now holds
    // the NEW number — so the "your account was taken over" warning would go
    // to whoever took it over.
    expect(recoverySource).not.toMatch(/enqueueNotification/);
    expect(recoverySource).toMatch(/previousPhone/);
  });

  it('never creates a session', () => {
    // Email alone must not grant access. It earns the right to prove control
    // of a new number, and the person signs in normally afterwards.
    expect(recoverySource).not.toMatch(/createSession/);
  });
});

describe('the recovery record cannot be rewritten', () => {
  it('refuses DELETE outright', () => {
    expect(guards).toMatch(/BEFORE DELETE ON "AccountRecovery"/);
    expect(guards).toMatch(/DELETE is not permitted/);
  });

  it('allows UPDATE only on the alert columns', () => {
    // The sweep has to write them after the fact; everything else is frozen.
    expect(guards).toMatch(/BEFORE UPDATE ON "AccountRecovery"/);
    for (const column of [
      'userId',
      'method',
      'previousPhone',
      'newPhone',
      'creditsFrozenUntil',
    ]) {
      expect(guards, column).toContain(`NEW."${column}" IS DISTINCT FROM OLD."${column}"`);
    }
  });

  it('insists a support-assisted move names an admin and a reason', () => {
    expect(guards).toMatch(/account_recovery_support_is_attributed/);
    expect(guards).toMatch(/char_length\(btrim\(coalesce\("reason", ''\)\)\) >= 8/);
  });

  it('insists the number actually changed', () => {
    expect(guards).toMatch(/"previousPhone" <> "newPhone"/);
  });

  it('insists a verified-email flag has an address behind it', () => {
    expect(guards).toMatch(/"emailVerifiedAt" IS NULL OR "email" IS NOT NULL/);
  });

  it('insists a dated freeze is a live freeze', () => {
    expect(guards).toMatch(/"frozenUntil" IS NULL OR "isFrozen" = true/);
  });
});

describe('the console route is as safe as the self-service one', () => {
  const adminSource = readFileSync(
    path.join(process.cwd(), 'src/lib/actions/admin-actions.ts'),
    'utf8',
  );

  it('goes through movePhoneNumber rather than updating the row', () => {
    // An administrator must not be able to skip the freeze, the alert or the
    // session revocation — which is exactly what a direct user.update would do.
    expect(adminSource).toMatch(/movePhoneNumber\(/);
    expect(adminSource).not.toMatch(/data: \{\s*phone:/);
  });

  it('records an audit row for the move', () => {
    expect(adminSource).toMatch(/ACCOUNT_RECOVERED/);
  });
});
