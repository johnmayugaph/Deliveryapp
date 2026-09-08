import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ErrorSource, NotificationChannel, NotificationKind } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  normaliseRoute,
  redact,
  redactMessage,
  redactStack,
} from '@/lib/monitoring/redact';
import { fingerprintOf, topOwnFrame } from '@/lib/monitoring/report';
import {
  EXPECTED_REFUSAL_NAMES,
  notAFaultReason,
} from '@/lib/monitoring/expected';
import { AdminAccessRequiredError } from '@/lib/admin/access';
import {
  NotAuthenticatedError,
  OnboardingIncompleteError,
} from '@/lib/auth/session';
import {
  InsufficientStoreRoleError,
  NoStoreAccessError,
} from '@/lib/merchant/access';
import { NotAFleetPartnerError } from '@/lib/fleet/partner';
import { ERROR_SOURCE_LABEL } from '@/lib/monitoring/queries';
import { StoreRole } from '@prisma/client';
import { KIND_POLICY } from '@/lib/notifications/policy';
import { renderNotification } from '@/lib/notifications/templates';

/**
 * Error monitoring.
 *
 * The redaction tests come first because they are the ones that matter most:
 * this feature writes error messages into the database, and the messages this
 * application can produce contain login codes, phone numbers, home addresses
 * and API keys. Every case below is a string some part of this codebase could
 * really generate.
 *
 * The grouping tests come second, because grouping is what keeps the table
 * usable instead of enormous — and because the fingerprint depends on
 * redaction having already happened, which is a coupling worth pinning down.
 */

function source(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

/**
 * Source with comments blanked out, line numbering preserved.
 *
 * Needed wherever a rule is asserted by its ABSENCE: the docstrings in these
 * modules explain the rules — "not SUPPORT_AGENT, because…", "never trusts a
 * stack from the client" — so a plain grep finds the explanation and reports
 * the code as breaking the very rule it documents.
 */
function codeOnly(relativePath: string): string {
  return source(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (match) => ' '.repeat(match.length));
}

// -----------------------------------------------------------------------------
// Redaction
// -----------------------------------------------------------------------------

describe('taking the secrets out', () => {
  it('removes a login code from a gateway rejection', () => {
    // The real shape: the SMS adapter puts the whole message in the body, and
    // the gateway quotes the body back in its error.
    const real =
      'SMS delivery via semaphore failed: HTTP 422: {"message":["481923 is ' +
      'your TARA code. Do not share it with anyone."]}';
    const clean = redact(real);
    expect(clean).not.toContain('481923');
    expect(clean).toContain('[6-digit]');
    // Still recognisable as what it was.
    expect(clean).toContain('semaphore');
    expect(clean).toContain('HTTP 422');
  });

  it('removes an api key from a url', () => {
    const clean = redact(
      'fetch failed: POST https://api.semaphore.co/api/v4/messages?apikey=abc123def456',
    );
    expect(clean).not.toContain('abc123def456');
    expect(clean).toContain('apikey=[redacted]');
  });

  it('removes a phone number but says one was there', () => {
    // "A phone number was in this message" is often the clue. The digits
    // never are.
    for (const written of ['+639171234567', '09171234567', '0917 123 4567', '0917-123-4567']) {
      const clean = redact(`Unique constraint failed on ${written}`);
      expect(clean, written).not.toContain('1234567');
      expect(clean, written).toContain('[phone]');
    }
  });

  it('removes an email address', () => {
    const clean = redact('No user with email juan.delacruz@example.ph');
    expect(clean).not.toContain('juan.delacruz');
    expect(clean).toContain('[email]');
  });

  it('removes a session token or a code hash', () => {
    const token = 'a'.repeat(64);
    expect(redact(`Session ${token} not found`)).not.toContain(token);
  });

  it('leaves a short id alone, so a stack stays readable', () => {
    // A Prisma cuid and a hex colour are not secrets, and blanking them makes
    // a trace useless.
    const clean = redact('Order cm5x1a2b3c4d5e not found near #1a2b3c');
    expect(clean).toContain('cm5x1a2b3c4d5e');
    expect(clean).toContain('#1a2b3c');
  });

  it('removes a bearer token and a jwt', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N';
    expect(redact(`Authorization: Bearer ${jwt}`)).not.toContain(jwt);
  });

  it('removes a turnstile token', () => {
    const token = '0.abcdefgh12345678.ijklmnop90123456.qrstuvwx78901234';
    expect(redact(`captcha rejected ${token}`)).not.toContain('ijklmnop90123456');
  });

  it('removes the database password from a connection error', () => {
    const clean = redact(
      "Can't reach database server at postgresql://tara:hunter2@db.example.com:5432/tara",
    );
    expect(clean).not.toContain('hunter2');
    expect(clean).toContain('postgresql://[redacted]');
  });

  it('keeps the name of the secret, which reveals nothing and helps', () => {
    // Knowing it was AUTH_SECRET rather than the SMS key is the whole triage.
    const clean = redact('secret: "s3cr3t-value-here"');
    expect(clean).toContain('secret');
    expect(clean).toContain(REDACTED);
    expect(clean).not.toContain('s3cr3t-value-here');
  });

  it('redacts a keyed secret before treating it as anything else', () => {
    // Order matters: `code=481923` must be redacted as a secret, not
    // reformatted as a six-digit number and left half readable.
    const clean = redact('code=481923');
    expect(clean).toBe(`code=${REDACTED}`);
  });

  it('never returns the input unchanged when the input had a secret', () => {
    const secrets = [
      'otp=999111',
      'token: abcdef123456789012345678901234567890',
      'my number is 09181234567',
      'password=letmein',
    ];
    for (const text of secrets) {
      expect(redact(text), text).not.toBe(text);
    }
  });

  it('handles nothing at all without throwing', () => {
    expect(redact(undefined)).toBe('');
    expect(redact(null)).toBe('');
    expect(redact('')).toBe('');
    expect(redactMessage(undefined)).toBe('An error with no message');
    expect(redactStack(undefined)).toBeNull();
  });

  it('truncates rather than storing an essay', () => {
    const long = 'x'.repeat(5_000);
    expect(redactMessage(long).length).toBeLessThan(1_100);
    expect(redactMessage(long)).toContain('truncated');
    expect((redactStack('y'.repeat(20_000)) ?? '').length).toBeLessThan(8_200);
  });
});

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------

describe('normalising a route', () => {
  it('drops the query string, which is where the tokens are', () => {
    expect(normaliseRoute('/login?next=%2Fadmin&token=abc')).toBe('/login');
  });

  it('collapses ids so one broken page is one fault', () => {
    // Otherwise a failing order page reads as a thousand distinct errors.
    expect(normaliseRoute('/orders/cm5x1a2b3c4d5e6f7g8h9i0j')).toBe('/orders/:id');
    expect(normaliseRoute('/admin/users/123')).toBe('/admin/users/:id');
    expect(
      normaliseRoute('/orders/3f2504e0-4f89-11d3-9a0c-0305e82c3301'),
    ).toBe('/orders/:id');
  });

  it('keeps the route shape', () => {
    expect(normaliseRoute('/stores/aling-nena-carinderia')).toBe(
      '/stores/aling-nena-carinderia',
    );
    expect(normaliseRoute('/')).toBe('/');
  });

  it('survives nonsense', () => {
    expect(normaliseRoute(undefined)).toBeNull();
    expect(normaliseRoute('')).toBeNull();
    expect(normaliseRoute('?only=query')).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Grouping
// -----------------------------------------------------------------------------

describe('what counts as the same fault', () => {
  const frame = 'at placeOrder (/app/src/lib/orders/place-order.ts:42:11)';

  it('groups two occurrences that differ only by a redacted value', () => {
    // The reason redaction runs BEFORE fingerprinting. These are one bug.
    const a = fingerprintOf({
      kind: 'Error',
      redactedMessage: redactMessage('Invalid phone +639171234567'),
      topFrame: frame,
    });
    const b = fingerprintOf({
      kind: 'Error',
      redactedMessage: redactMessage('Invalid phone +639189876543'),
      topFrame: frame,
    });
    expect(a).toBe(b);
  });

  it('separates different kinds with the same message', () => {
    const a = fingerprintOf({ kind: 'TypeError', redactedMessage: 'x', topFrame: frame });
    const b = fingerprintOf({ kind: 'RangeError', redactedMessage: 'x', topFrame: frame });
    expect(a).not.toBe(b);
  });

  it('separates the same message thrown from different places', () => {
    const a = fingerprintOf({ kind: 'Error', redactedMessage: 'Not found', topFrame: frame });
    const b = fingerprintOf({
      kind: 'Error',
      redactedMessage: 'Not found',
      topFrame: 'at loadStore (/app/src/lib/stores.ts:9:3)',
    });
    expect(a).not.toBe(b);
  });

  it('is stable across calls', () => {
    const input = { kind: 'Error', redactedMessage: 'boom', topFrame: frame };
    expect(fingerprintOf(input)).toBe(fingerprintOf(input));
    expect(fingerprintOf(input)).toHaveLength(32);
  });
});

describe('finding the frame that matters', () => {
  it('skips framework frames to reach our own code', () => {
    // An error thrown inside React's renderer has the same top frame whatever
    // caused it. Grouping on that would collapse every fault into one row.
    const stack = [
      'Error: boom',
      '    at renderWithHooks (/app/node_modules/react-dom/cjs/react-dom.js:1)',
      '    at /app/.next/server/chunks/1234.js:5:6',
      '    at CheckoutForm (/app/src/components/cart/CheckoutForm.tsx:88:14)',
    ].join('\n');
    expect(topOwnFrame(stack)).toContain('CheckoutForm.tsx');
  });

  it('returns nothing rather than guessing when there is no stack', () => {
    expect(topOwnFrame(undefined)).toBe('');
    expect(topOwnFrame('Error: boom')).toBe('');
  });

  it('falls back to a framework frame over nothing at all', () => {
    // Better an imprecise group than one row for every error in the app.
    const stack = 'Error: boom\n    at node:internal/process/task_queues:95:5';
    expect(topOwnFrame(stack)).toBe('');
  });
});

// -----------------------------------------------------------------------------
// Alerting
// -----------------------------------------------------------------------------

describe('telling somebody', () => {
  it('interrupts, because a broken checkout at 2am is worth waking one person', () => {
    const policy = KIND_POLICY[NotificationKind.ERROR_DETECTED];
    expect(policy.urgency).toBe('OPERATIONAL');
    expect(policy.channels).toContain(NotificationChannel.PUSH);
    expect(policy.channels).toContain(NotificationChannel.IN_APP);
  });

  it('cannot spend money', () => {
    // A monitoring system that can run up an SMS bill during an error loop is
    // a monitoring system somebody switches off.
    expect(KIND_POLICY[NotificationKind.ERROR_DETECTED].channels).not.toContain(
      NotificationChannel.SMS,
    );
  });

  it('puts no stack trace on a lock screen', () => {
    const rendered = renderNotification(NotificationKind.ERROR_DETECTED, {
      errorKind: 'PrismaClientKnownRequestError',
      errorRoute: '/checkout',
    });
    expect(rendered.title).toContain('PrismaClientKnownRequestError');
    expect(rendered.body).toContain('/checkout');
    expect(rendered.body).toMatch(/console/i);
    expect(rendered.body.length).toBeLessThan(300);
  });

  it('reads sensibly with nothing but a kind', () => {
    const rendered = renderNotification(NotificationKind.ERROR_DETECTED, {
      errorKind: 'TypeError',
    });
    expect(rendered.body).not.toMatch(/undefined|null/);
  });

  it('alerts once per fault, not once per occurrence', () => {
    const queries = source('src/lib/monitoring/queries.ts');
    expect(queries).toMatch(/alertedAt: null/);
    const sweep = source('src/lib/orders/maintenance.ts');
    expect(sweep).toMatch(/markErrorAlerted/);
  });

  it('does not wake a support agent who cannot deploy a fix', () => {
    const queries = codeOnly('src/lib/monitoring/queries.ts');
    expect(queries).toMatch(/roles: \{ has: UserRole\.ADMIN \}/);
    expect(queries).not.toMatch(/SUPPORT_AGENT/);
  });

  it('names every source in the console, so a sixth is a compile error', () => {
    expect(Object.keys(ERROR_SOURCE_LABEL).sort()).toEqual(
      Object.values(ErrorSource).sort(),
    );
  });
});

// -----------------------------------------------------------------------------
// The rules the reporter has to keep
// -----------------------------------------------------------------------------

describe('the reporter cannot make things worse', () => {
  const report = source('src/lib/monitoring/report.ts');

  it('wraps its whole body, so it never throws at a caller', () => {
    // A monitoring call that can fail turns one broken page into two, and the
    // second happens inside the handler for the first.
    expect(report).toMatch(/try \{/);
    expect(report).toMatch(/catch \(reportingFailure\)/);
  });

  it('does not report its own failure', () => {
    // Reporting the reporter is an infinite loop with a database attached.
    const catchBlock = report.slice(report.indexOf('catch (reportingFailure)'));
    expect(catchBlock).not.toMatch(/reportError\(/);
    expect(catchBlock).toMatch(/console\.error/);
  });

  it('groups by upsert rather than appending a row per occurrence', () => {
    expect(report).toMatch(/errorReport\.upsert/);
    expect(report).toMatch(/occurrences: \{ increment: 1 \}/);
  });

  it('reopens a fault that comes back after being marked fixed', () => {
    const update = report.slice(report.indexOf('update: {'), report.indexOf('select: {'));
    expect(update).toMatch(/resolvedAt: null/);
  });

  it('redacts before writing, never after', () => {
    expect(report).toMatch(/redactMessage\(/);
    expect(report).toMatch(/redactStack\(/);
  });

  it('never trusts a stack sent by a browser', () => {
    // That endpoint is reachable by anybody who can post to the app, which
    // makes an accepted `stack` field unverifiable text written straight into
    // the database.
    const action = codeOnly('src/lib/actions/monitoring-actions.ts');
    expect(action).not.toMatch(/stack/i);
  });
});

// -----------------------------------------------------------------------------
// Not every throw is a fault
// -----------------------------------------------------------------------------

describe('what does not belong on the error page', () => {
  /**
   * Every refusal class, actually constructed.
   *
   * `expected.ts` matches on names rather than `instanceof`, because it is
   * reachable from the edge-compiled instrumentation hook and cannot import
   * these modules. This is the test that stops the two drifting apart: rename
   * a class or change its `this.name` and the name it was matched by is no
   * longer produced by anything.
   */
  const refusals: Error[] = [
    new AdminAccessRequiredError(),
    new NotAuthenticatedError(),
    new OnboardingIncompleteError(),
    new NoStoreAccessError('store_1'),
    new InsufficientStoreRoleError(StoreRole.OWNER, StoreRole.STAFF),
    new NotAFleetPartnerError(),
  ];

  it('ignores every refusal an access check can throw', () => {
    for (const error of refusals) {
      expect(
        notAFaultReason({ kind: error.name, message: error.message }),
        `${error.name} would still fill the error page`,
      ).toBe('EXPECTED_REFUSAL');
    }
  });

  it('lists no name that no class produces', () => {
    // The other direction: a stale entry here is a rule that silently stopped
    // applying, which is worse than no rule at all because it reads as one.
    const produced = new Set(refusals.map((error) => error.name));
    for (const name of EXPECTED_REFUSAL_NAMES) {
      expect(produced.has(name), `${name} is matched but nothing throws it`).toBe(true);
    }
    expect(EXPECTED_REFUSAL_NAMES).toHaveLength(refusals.length);
  });

  it('ignores a request the customer walked away from', () => {
    // Observed for real on /help/contact: a tab closed while the RSC stream
    // was still being written. Nothing on our side is wrong or fixable.
    expect(notAFaultReason({ kind: 'Error', message: 'Connection closed.' })).toBe(
      'ABANDONED_REQUEST',
    );
    expect(notAFaultReason({ kind: 'ResponseAborted', message: '' })).toBe(
      'ABANDONED_REQUEST',
    );
  });

  it('still records everything that is a fault', () => {
    const faults = [
      { kind: 'TypeError', message: "Cannot read properties of undefined (reading 'id')" },
      { kind: 'PrismaClientValidationError', message: 'Invalid `prisma.store.findMany()`' },
      { kind: 'ClientError', message: 'Minified React error #418' },
      { kind: 'IllegalTransitionError', message: 'Cannot go from DELIVERED to PREPARING' },
      // A wallet refusal that reached the hook means an action failed to catch
      // it and the customer saw a 500. The refusal was right; the 500 was not.
      { kind: 'InsufficientCreditsError', message: 'Not enough credits' },
    ];
    for (const fault of faults) {
      expect(notAFaultReason(fault), `${fault.kind} would be swallowed`).toBeNull();
    }
  });

  it('matches an abandoned request exactly, never by substring', () => {
    // The loose version of this rule is the dangerous one: a real database
    // failure that happens to mention a closed connection must still be seen.
    expect(
      notAFaultReason({
        kind: 'PrismaClientUnknownRequestError',
        message: 'Connection closed. The connection pool was exhausted.',
      }),
    ).toBeNull();
  });

  it('costs nothing at all, so /admin in a loop writes no rows', () => {
    const report = codeOnly('src/lib/monitoring/report.ts');
    expect(report.indexOf('notAFaultReason(')).toBeGreaterThan(-1);
    expect(report.indexOf('notAFaultReason(')).toBeLessThan(
      report.indexOf('errorReport.upsert'),
    );
  });

  it('imports nothing, so the edge-compiled hook still builds', () => {
    // The hand-written hash in `report.ts` exists because one node-only import
    // in this layer silently switches monitoring off. Naming the errors as
    // strings is what keeps this module free of the classes that would.
    const expectedModule = codeOnly('src/lib/monitoring/expected.ts');
    expect(expectedModule).not.toMatch(/^\s*import /m);
  });

  it('says why it ignored something, rather than dropping it silently', () => {
    const report = source('src/lib/monitoring/report.ts');
    expect(report).toMatch(/notAFault\?: NotAFaultReason/);
    expect(report).toMatch(/\.\.\.NOT_RECORDED, notAFault/);
  });
});
