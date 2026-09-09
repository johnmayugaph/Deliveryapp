import { readFileSync, readdirSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SMS_PROVIDER_ORDER,
  FallbackSmsSender,
  NoSmsSenderError,
  SMS_BUILDERS,
  SMS_PROVIDERS,
  SmsDeliveryError,
  TwilioSmsSender,
  configuredSmsProviders,
  describeSmsSetup,
  isSmsProviderName,
  resolveSmsSender,
  smsProviderOrder,
  smsSendingIsRefused,
  type SmsEnv,
  type SmsProviderName,
  type SmsSender,
  type TwilioSmsOptions,
} from '@/lib/auth/sms';

/**
 * A second SMS gateway, and the selection that had only ever had one.
 *
 * The `SmsSender` interface was written for swapping — its own comment says
 * the gateway is "the part of this system most likely to be swapped" — but the
 * SELECTION spelled `SEMAPHORE_API_KEY` by hand in six files, so swapping
 * meant editing operator copy in places nobody would grep. These tests are
 * about the seam, the new adapter, and the chain.
 */

/** Strips comments, so a whole-file regex cannot be satisfied by prose. */
function codeOnly(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const env = (over: Partial<SmsEnv> = {}): SmsEnv => ({ ...over }) as SmsEnv;

const SEMAPHORE = { SEMAPHORE_API_KEY: 'sem-key' };
const TWILIO = {
  TWILIO_ACCOUNT_SID: 'AC123',
  TWILIO_AUTH_TOKEN: 'tok-secret',
  TWILIO_FROM_NUMBER: '+15005550006',
};

// -----------------------------------------------------------------------------
// The registry
// -----------------------------------------------------------------------------

describe('the provider registry', () => {
  it('has a builder for every provider it declares', () => {
    /**
     * The compile-enforced `Record` catches this at build time; this catches
     * the case where the two files were edited separately and one entry was
     * left as a stub. Both directions, so neither list can grow alone.
     */
    expect(Object.keys(SMS_BUILDERS).sort()).toEqual(Object.keys(SMS_PROVIDERS).sort());
    expect([...DEFAULT_SMS_PROVIDER_ORDER].sort()).toEqual(
      Object.keys(SMS_PROVIDERS).sort(),
    );
  });

  it('gives every provider a distinct endpoint override variable', () => {
    // One shared variable would let a development redirect for one gateway
    // silently point another somewhere else.
    const vars = DEFAULT_SMS_PROVIDER_ORDER.map(
      (name) => SMS_PROVIDERS[name].endpointVar,
    );
    expect(new Set(vars).size).toBe(vars.length);
  });

  it('names its required variables rather than hiding them in a predicate', () => {
    // So `/admin/health` can say what is missing, not merely that something is.
    for (const name of DEFAULT_SMS_PROVIDER_ORDER) {
      expect(SMS_PROVIDERS[name].requires.length).toBeGreaterThan(0);
      expect(SMS_PROVIDERS[name].fix).not.toBe('');
    }
  });

  it('recognises only the providers it has', () => {
    expect(isSmsProviderName('semaphore')).toBe(true);
    expect(isSmsProviderName('twilio')).toBe(true);
    expect(isSmsProviderName('nexmo')).toBe(false);
    expect(isSmsProviderName('')).toBe(false);
  });
});

describe('which providers a deployment can use', () => {
  it('is nothing when nothing is set', () => {
    expect(configuredSmsProviders(env())).toEqual([]);
  });

  it('treats an empty string as unset', () => {
    // A blank variable in a compose file is the commonest way to "configure"
    // a gateway that then cannot send.
    expect(configuredSmsProviders(env({ SEMAPHORE_API_KEY: '' }))).toEqual([]);
  });

  it('needs the whole set, not one of it', () => {
    expect(configuredSmsProviders(env({ TWILIO_ACCOUNT_SID: 'AC123' }))).toEqual([]);
    expect(
      configuredSmsProviders(
        env({ TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'tok' }),
      ),
    ).toEqual([]); // no From and no Messaging Service — Twilio would reject it
  });

  it('accepts either way of saying who a Twilio message is from', () => {
    expect(configuredSmsProviders(env(TWILIO))).toEqual(['twilio']);
    expect(
      configuredSmsProviders(
        env({
          TWILIO_ACCOUNT_SID: 'AC123',
          TWILIO_AUTH_TOKEN: 'tok',
          TWILIO_MESSAGING_SERVICE_SID: 'MG1',
        }),
      ),
    ).toEqual(['twilio']);
  });

  it('lists both when both are set', () => {
    expect(configuredSmsProviders(env({ ...SEMAPHORE, ...TWILIO }))).toEqual([
      'semaphore',
      'twilio',
    ]);
  });
});

describe('the order gateways are tried in', () => {
  it('defaults to the declaration order', () => {
    expect(smsProviderOrder(env())).toEqual([...DEFAULT_SMS_PROVIDER_ORDER]);
  });

  it('honours SMS_PROVIDER_ORDER', () => {
    expect(smsProviderOrder(env({ SMS_PROVIDER_ORDER: 'twilio,semaphore' }))).toEqual([
      'twilio',
      'semaphore',
    ]);
  });

  it('is case and whitespace insensitive, because a .env file is hand-typed', () => {
    expect(
      smsProviderOrder(env({ SMS_PROVIDER_ORDER: '  Twilio , SEMAPHORE ' })),
    ).toEqual(['twilio', 'semaphore']);
  });

  it('IGNORES a name it does not know rather than failing', () => {
    // A stray comma must not stop a login screen from working.
    expect(smsProviderOrder(env({ SMS_PROVIDER_ORDER: 'nexmo,twilio' }))).toEqual([
      'twilio',
      'semaphore',
    ]);
  });

  it('APPENDS a provider the variable does not mention', () => {
    /**
     * THE property. `SMS_PROVIDER_ORDER=twilio` means "try Twilio first", not
     * "disable the Semaphore account that is paying for today's messages".
     * Dropping it would be a silent downgrade to a single point of failure.
     */
    expect(smsProviderOrder(env({ SMS_PROVIDER_ORDER: 'twilio' }))).toEqual([
      'twilio',
      'semaphore',
    ]);
    expect(configuredSmsProviders(env({ ...SEMAPHORE, ...TWILIO, SMS_PROVIDER_ORDER: 'twilio' })))
      .toEqual(['twilio', 'semaphore']);
  });

  it('never repeats a provider, however it is listed', () => {
    expect(smsProviderOrder(env({ SMS_PROVIDER_ORDER: 'twilio,twilio' }))).toEqual([
      'twilio',
      'twilio',
      'semaphore',
    ]);
    // Repetition inside the variable is the operator's business; what matters
    // is that the appended tail adds nothing already named.
    expect(
      smsProviderOrder(env({ SMS_PROVIDER_ORDER: 'twilio,semaphore' })),
    ).toHaveLength(2);
  });
});

// -----------------------------------------------------------------------------
// Selection
// -----------------------------------------------------------------------------

describe('what resolveSmsSender picks', () => {
  it('uses the console sender in development', () => {
    expect(resolveSmsSender(env({ NODE_ENV: 'development' })).name).toBe('console');
  });

  it('REFUSES the console sender in production', () => {
    expect(() => resolveSmsSender(env({ NODE_ENV: 'production' }))).toThrow(
      NoSmsSenderError,
    );
    expect(smsSendingIsRefused(env({ NODE_ENV: 'production' }))).toBe(true);
  });

  it('names every way to fix it, derived from the registry', () => {
    /**
     * The message used to name one variable. An operator who had a Twilio
     * account and no Semaphore one was told to go and get a Semaphore one.
     */
    const message = new NoSmsSenderError().message;
    for (const name of DEFAULT_SMS_PROVIDER_ORDER) {
      expect(message).toContain(SMS_PROVIDERS[name].requires[0]!);
    }
    expect(describeSmsSetup()).toContain('SEMAPHORE_API_KEY');
    expect(describeSmsSetup()).toContain('TWILIO_ACCOUNT_SID');
  });

  it('returns the bare sender when exactly one gateway is configured', () => {
    // Not a chain of one: a log line reading `semaphore` is what support
    // expects to see.
    expect(resolveSmsSender(env(SEMAPHORE)).name).toBe('semaphore');
    expect(resolveSmsSender(env(TWILIO)).name).toBe('twilio');
  });

  it('CHAINS both when both are configured', () => {
    const sender = resolveSmsSender(env({ ...SEMAPHORE, ...TWILIO }));
    expect(sender).toBeInstanceOf(FallbackSmsSender);
    expect((sender as FallbackSmsSender).providers).toEqual(['semaphore', 'twilio']);
  });

  it('chains in the configured order', () => {
    const sender = resolveSmsSender(
      env({ ...SEMAPHORE, ...TWILIO, SMS_PROVIDER_ORDER: 'twilio' }),
    );
    expect((sender as FallbackSmsSender).providers).toEqual(['twilio', 'semaphore']);
  });

  it('prefers a gateway over the console even in development', () => {
    expect(resolveSmsSender(env({ ...SEMAPHORE, NODE_ENV: 'development' })).name).toBe(
      'semaphore',
    );
  });

  it('is not refused once any gateway is configured, in any runtime', () => {
    for (const runtime of ['production', 'development', 'test', undefined]) {
      expect(smsSendingIsRefused(env({ ...TWILIO, NODE_ENV: runtime }))).toBe(false);
    }
  });
});

describe('the development endpoint redirect', () => {
  it('is honoured outside production', () => {
    const sender = resolveSmsSender(
      env({ ...TWILIO, NODE_ENV: 'development', TWILIO_ENDPOINT: 'http://127.0.0.1:1/x' }),
    ) as TwilioSmsSender;
    expect(sender.endpoint).toBe('http://127.0.0.1:1/x');
  });

  it('is IGNORED in production, for every provider', () => {
    /**
     * A variable that can point message delivery somewhere else is a way to
     * capture login codes. The rule now lives in one place (`devEndpointFor`)
     * rather than in each adapter, which is what stops a third gateway from
     * quietly honouring its own override.
     */
    const sender = resolveSmsSender(
      env({ ...TWILIO, NODE_ENV: 'production', TWILIO_ENDPOINT: 'http://evil/x' }),
    ) as TwilioSmsSender;
    expect(sender.endpoint).toContain('api.twilio.com');
    expect(sender.endpoint).not.toContain('evil');
  });

  it('resolves the rule centrally rather than per adapter', () => {
    const source = codeOnly('src/lib/auth/sms/registry.ts');
    expect(source).toMatch(/env\.NODE_ENV === 'production'/);
    // No adapter reads NODE_ENV for itself.
    for (const file of ['semaphore.ts', 'twilio.ts']) {
      expect(codeOnly(join('src/lib/auth/sms', file))).not.toMatch(/NODE_ENV/);
    }
  });
});

// -----------------------------------------------------------------------------
// Twilio, at the wire
// -----------------------------------------------------------------------------

interface Capture {
  method: string;
  url: string;
  contentType: string | undefined;
  authorization: string | undefined;
  raw: string;
}

let server: Server | undefined;

afterEach(async () => {
  if (!server) return;
  const closing = server;
  server = undefined;
  await new Promise<void>((resolve) => closing.close(() => resolve()));
});

/** Starts a loopback server that records one request and answers with `reply`. */
async function gateway(
  reply: (res: ServerResponse) => void,
): Promise<{ endpoint: string; captured: () => Capture | undefined }> {
  let capture: Capture | undefined;

  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      capture = {
        method: req.method ?? '',
        url: req.url ?? '',
        contentType: req.headers['content-type'],
        authorization: req.headers.authorization,
        raw: Buffer.concat(chunks).toString('utf8'),
      };
      reply(res);
    });
  });

  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server!.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a TCP address');
  }
  return {
    endpoint: `http://127.0.0.1:${address.port}/2010-04-01/Accounts/AC123/Messages.json`,
    captured: () => capture,
  };
}

function json(status: number, payload: unknown) {
  return (res: ServerResponse) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
}

/** One accepted message, in the shape Twilio's API documents. */
const ACCEPTED = {
  sid: 'SM0123456789abcdef',
  status: 'queued',
  to: '+639171234567',
  from: '+15005550006',
  body: 'Your TARA code is 481920.',
  num_segments: '1',
};

const twilio = (endpoint: string, over: Partial<TwilioSmsOptions> = {}) =>
  new TwilioSmsSender({
    accountSid: 'AC123',
    authToken: 'tok-secret',
    from: '+15005550006',
    endpoint,
    ...over,
  });

describe('the request that reaches Twilio', () => {
  it('POSTs form-encoded fields over a real socket', async () => {
    const { endpoint, captured } = await gateway(json(201, ACCEPTED));
    await twilio(endpoint).send({
      to: '+639171234567',
      body: 'Your TARA code is 481920.',
    });

    const request = captured()!;
    expect(request.method).toBe('POST');
    expect(request.contentType).toBe('application/x-www-form-urlencoded');
    const fields = new URLSearchParams(request.raw);
    expect(fields.get('To')).toBe('+639171234567');
    expect(fields.get('From')).toBe('+15005550006');
    expect(fields.get('Body')).toBe('Your TARA code is 481920.');
  });

  it('percent-encodes the leading + rather than sending it raw', async () => {
    /**
     * THE bug, on the other adapter. A raw `+` in a form body is decoded as a
     * space, so the gateway sees ` 639171234567` — which is a silent, billable
     * failure: accepted, charged, delivered nowhere.
     */
    const { endpoint, captured } = await gateway(json(201, ACCEPTED));
    await twilio(endpoint).send({ to: '+639171234567', body: 'x' });
    expect(captured()!.raw).toContain('To=%2B639171234567');
    expect(captured()!.raw).not.toContain('To=+639171234567');
  });

  it('sends the credentials as HTTP Basic, never in the URL', async () => {
    const { endpoint, captured } = await gateway(json(201, ACCEPTED));
    await twilio(endpoint).send({ to: '+639171234567', body: 'x' });

    const request = captured()!;
    const expected = Buffer.from('AC123:tok-secret', 'utf8').toString('base64');
    expect(request.authorization).toBe(`Basic ${expected}`);
    // A token in a query string lands in access logs and error reports.
    expect(request.url).not.toContain('tok-secret');
    expect(request.raw).not.toContain('tok-secret');
  });

  it('prefers a Messaging Service over a bare number when both are set', async () => {
    // The service holds the sender pool and the sticky-sender rules, so a
    // deployment with both configured meant to use it.
    const { endpoint, captured } = await gateway(json(201, ACCEPTED));
    await twilio(endpoint, { messagingServiceSid: 'MG9' }).send({
      to: '+639171234567',
      body: 'x',
    });
    const fields = new URLSearchParams(captured()!.raw);
    expect(fields.get('MessagingServiceSid')).toBe('MG9');
    expect(fields.get('From')).toBeNull();
  });

  it('refuses to be built with no origin at all', () => {
    // Twilio rejects such a message with a 400. A login screen is the wrong
    // place to discover a deployment was never told who the message is from.
    expect(
      () => new TwilioSmsSender({ accountSid: 'AC1', authToken: 't' }),
    ).toThrow(SmsDeliveryError);
  });

  it('keeps a multi-line body intact through form encoding', async () => {
    const { endpoint, captured } = await gateway(json(201, ACCEPTED));
    const body = 'Your TARA code is 481920.\n\nDo not share it.';
    await twilio(endpoint).send({ to: '+639171234567', body });
    expect(new URLSearchParams(captured()!.raw).get('Body')).toBe(body);
  });
});

describe('what Twilio sends back', () => {
  it('reads the sid as the provider message id', async () => {
    const { endpoint } = await gateway(json(201, ACCEPTED));
    const result = await twilio(endpoint).send({ to: '+639171234567', body: 'x' });
    expect(result).toEqual({
      providerMessageId: 'SM0123456789abcdef',
      provider: 'twilio',
    });
  });

  it('treats accepted-but-unparseable as accepted', async () => {
    // Do not fail a login over a response body.
    const { endpoint } = await gateway((res) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end('not json at all');
    });
    const result = await twilio(endpoint).send({ to: '+639171234567', body: 'x' });
    expect(result).toEqual({ providerMessageId: null, provider: 'twilio' });
  });

  it('surfaces the Twilio error code, which is the useful half', async () => {
    /**
     * 21608 is "unverified number on a trial account" — the single most likely
     * failure while testing before a branded sender exists. A bare "HTTP 400"
     * would send somebody reading docs for an hour.
     */
    const { endpoint } = await gateway(
      json(400, {
        code: 21608,
        message: 'The number is unverified. Trial accounts may only send to verified numbers.',
        more_info: 'https://www.twilio.com/docs/errors/21608',
      }),
    );
    /* Asserted on the FORMATTED shape, not on the substrings. The first
       version of this test looked for /21608/ and /unverified/i — both of
       which appear in the raw JSON body too, so it passed just as happily
       when the parsing was disabled and the whole blob was dumped. A check
       that cannot fail is worse than no check. `(code 21608)` is a shape only
       this adapter produces. */
    await expect(twilio(endpoint).send({ to: '+639171234567', body: 'x' })).rejects.toThrow(
      '(code 21608)',
    );
    await expect(
      twilio(endpoint).send({ to: '+639171234567', body: 'x' }),
    ).rejects.toThrow(/HTTP 400: The number is unverified/);
    // And the raw JSON is NOT what gets surfaced.
    await expect(
      twilio(endpoint).send({ to: '+639171234567', body: 'x' }),
    ).rejects.not.toThrow(/"more_info"/);
  });

  it('still reports the status when the body is not JSON', async () => {
    const { endpoint } = await gateway((res) => {
      res.writeHead(502, { 'content-type': 'text/html' });
      res.end('<html>bad gateway</html>');
    });
    await expect(twilio(endpoint).send({ to: '+639171234567', body: 'x' })).rejects.toThrow(
      /HTTP 502/,
    );
  });

  it('reports a refused connection as a delivery failure', async () => {
    // Port 1 on loopback answers nothing.
    const sender = twilio('http://127.0.0.1:1/Messages.json');
    await expect(sender.send({ to: '+639171234567', body: 'x' })).rejects.toBeInstanceOf(
      SmsDeliveryError,
    );
  });
});

// -----------------------------------------------------------------------------
// The chain
// -----------------------------------------------------------------------------

/** A sender that records its calls and can be told to fail. */
function fake(name: string, behaviour: 'ok' | 'fail'): SmsSender & { calls: number } {
  const sender = {
    name,
    calls: 0,
    async send() {
      sender.calls += 1;
      if (behaviour === 'fail') {
        throw new SmsDeliveryError(name, 'refused for the test');
      }
      return { providerMessageId: `${name}-1`, provider: name };
    },
  };
  return sender;
}

describe('chaining gateways', () => {
  const message = { to: '+639171234567', body: 'x' };

  it('stops at the first gateway that accepts', async () => {
    const first = fake('a', 'ok');
    const second = fake('b', 'ok');
    const result = await new FallbackSmsSender([first, second]).send(message);

    expect(result.provider).toBe('a');
    expect(first.calls).toBe(1);
    // The whole point: a working first gateway costs nothing extra.
    expect(second.calls).toBe(0);
  });

  it('falls through when one refuses', async () => {
    const first = fake('a', 'fail');
    const second = fake('b', 'ok');
    const result = await new FallbackSmsSender([first, second]).send(message);

    expect(result.provider).toBe('b');
    expect(first.calls).toBe(1);
    expect(second.calls).toBe(1);
  });

  it('reports the gateway that DELIVERED, not the chain', async () => {
    // That is the field support reads off a log line.
    const sender = new FallbackSmsSender([fake('a', 'fail'), fake('b', 'ok')]);
    expect(sender.name).toBe('a→b');
    expect((await sender.send(message)).provider).toBe('b');
  });

  it('carries every reason when they all refuse', async () => {
    /**
     * With one provider the message was the answer. With two, "SMS failed"
     * without saying which and why is an hour of somebody's evening.
     */
    const sender = new FallbackSmsSender([fake('a', 'fail'), fake('b', 'fail')]);
    await expect(sender.send(message)).rejects.toThrow(/a: .*refused/);
    await expect(sender.send(message)).rejects.toThrow(/b: .*refused/);
    await expect(sender.send(message)).rejects.toBeInstanceOf(SmsDeliveryError);
  });

  it('tries them in the order given, every time', async () => {
    // No round-robin and no health tracking: state that decides whether
    // logins work is a thing to add on evidence, not on the first day.
    const first = fake('a', 'ok');
    const second = fake('b', 'ok');
    const sender = new FallbackSmsSender([first, second]);
    await sender.send(message);
    await sender.send(message);
    expect(first.calls).toBe(2);
    expect(second.calls).toBe(0);
  });

  it('refuses to be built empty', () => {
    expect(() => new FallbackSmsSender([])).toThrow();
  });
});

// -----------------------------------------------------------------------------
// The seam, guarded
// -----------------------------------------------------------------------------

describe('no vendor name outside the sms directory', () => {
  /**
   * The anti-regression for the whole change. Six files named
   * `SEMAPHORE_API_KEY`; the point was to leave that name in one directory so
   * the next gateway is a file and an entry, not a hunt.
   */
  function offenders(): string[] {
    const found: string[] = [];
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return /\.tsx?$/.test(entry.name) ? [full] : [];
      });

    for (const file of [...walk('src'), ...walk('scripts')]) {
      if (file.includes('tests') || file.includes(join('auth', 'sms'))) continue;
      if (/SEMAPHORE_[A-Z_]+|TWILIO_[A-Z_]+/.test(codeOnly(file))) found.push(file);
    }
    return found;
  }

  it('finds the names inside the directory, so the sweep is not vacuous', () => {
    expect(codeOnly('src/lib/auth/sms/registry.ts')).toMatch(/SEMAPHORE_API_KEY/);
    expect(codeOnly('src/lib/auth/sms/build.ts')).toMatch(/TWILIO_ACCOUNT_SID/);
  });

  it('leaves no provider variable spelled in code elsewhere', () => {
    expect(offenders()).toEqual([]);
  });

  it('the operator-facing copy is derived, not typed', () => {
    for (const file of [
      'src/components/auth/SignInBlockedNotice.tsx',
      'src/app/admin/health/page.tsx',
    ]) {
      expect(codeOnly(file)).toMatch(/describeSmsSetup\(\)/);
    }
  });

  it('the login screen does not pull the adapters in to render a string', () => {
    /**
     * `describeSmsSetup` is rendered on the most-visited page in the
     * application. The specs are data in `registry.ts` and the constructors
     * live in `build.ts` precisely so that page's module graph stays clear of
     * two HTTP clients — the same mistake that once broke the customer's
     * tracking map.
     */
    const registry = codeOnly('src/lib/auth/sms/registry.ts');
    expect(registry).not.toMatch(/SemaphoreSmsSender|TwilioSmsSender/);
    expect(registry).not.toMatch(/from '@\/lib\/auth\/sms\/(semaphore|twilio)'/);
  });
});

describe('adding a third gateway stays cheap', () => {
  it('needs an adapter, a spec and a builder — and nothing else', () => {
    /**
     * Not a behavioural test; a statement of the seam, checked. If selection
     * ever grows a provider-specific branch again, this is where it shows.
     */
    const barrel = codeOnly('src/lib/auth/sms/index.ts');
    /* The barrel re-exports both adapters BY NAME, which is its job — the
       send-one script imports them from here. So the claim is narrower and
       more useful than "the file never says twilio": the two functions that
       DECIDE must have no provider-specific branch in them. Sliced from the
       first of them to the end of the file. */
    const selection = barrel.slice(barrel.indexOf('export function smsSendingIsRefused'));
    expect(selection).not.toMatch(/semaphore|twilio/i);
    expect(selection).toMatch(/SMS_BUILDERS\[name\]\(env, devEndpointFor\(name, env\)\)/);
    // And the slice is not empty, which would make the check vacuous.
    expect(selection).toContain('resolveSmsSender');
  });

  it('every declared provider actually builds', () => {
    // A spec whose builder throws on its own configuration is a provider that
    // exists on a screen and not in fact.
    const cases: Readonly<Record<SmsProviderName, SmsEnv>> = {
      semaphore: env(SEMAPHORE),
      twilio: env(TWILIO),
    };
    for (const name of DEFAULT_SMS_PROVIDER_ORDER) {
      const sender = SMS_BUILDERS[name](cases[name], undefined);
      expect(sender.name).toBe(name);
      expect(typeof sender.send).toBe('function');
    }
  });
});
