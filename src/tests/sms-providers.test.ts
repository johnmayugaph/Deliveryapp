import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NoSmsSenderError,
  SMS_BUILDERS,
  SMS_PROVIDERS,
  SMS_PROVIDER_NAMES,
  SemaphoreSmsSender,
  configuredSmsProvider,
  describeSmsSetup,
  isSmsProviderName,
  resolveSmsSender,
  smsRequiredVars,
  smsSendingIsRefused,
  type SmsEnv,
  type SmsProviderName,
} from '@/lib/auth/sms';

/**
 * The SMS provider seam.
 *
 * The `SmsSender` interface was written for swapping — its own comment says
 * the gateway is "the part of this system most likely to be swapped" — but the
 * SELECTION spelled `SEMAPHORE_API_KEY` by hand in six files, so swapping
 * meant editing operator copy in places nobody would grep. These tests are
 * about that seam: one gateway today, named in one directory, with the
 * operator copy derived rather than typed.
 */

/** Strips comments, so a whole-file regex cannot be satisfied by prose. */
function codeOnly(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const env = (over: Partial<SmsEnv> = {}): SmsEnv => ({ ...over }) as SmsEnv;

const SEMAPHORE = { SEMAPHORE_API_KEY: 'sem-key' };
const PHILSMS = { PHILSMS_API_TOKEN: 'phil-token', PHILSMS_SENDER_ID: 'TARA' };

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
    expect([...SMS_PROVIDER_NAMES].sort()).toEqual(Object.keys(SMS_PROVIDERS).sort());
  });

  it('gives every provider a distinct endpoint override variable', () => {
    // One shared variable would let a development redirect for one gateway
    // silently point another somewhere else.
    const vars = SMS_PROVIDER_NAMES.map((name) => SMS_PROVIDERS[name].endpointVar);
    expect(new Set(vars).size).toBe(vars.length);
  });

  it('names its required variables rather than hiding them in a predicate', () => {
    // So `/admin/health` can say what is missing, not merely that something is.
    for (const name of SMS_PROVIDER_NAMES) {
      expect(SMS_PROVIDERS[name].requires.length).toBeGreaterThan(0);
      expect(SMS_PROVIDERS[name].fix).not.toBe('');
    }
    expect(smsRequiredVars()).toContain('SEMAPHORE_API_KEY');
  });

  it('recognises only the providers it has', () => {
    expect(isSmsProviderName('semaphore')).toBe(true);
    expect(isSmsProviderName('twilio')).toBe(false);
    expect(isSmsProviderName('nexmo')).toBe(false);
    expect(isSmsProviderName('')).toBe(false);
  });
});

describe('which provider a deployment can use', () => {
  it('is nothing when nothing is set', () => {
    expect(configuredSmsProvider(env())).toBeUndefined();
  });

  it('treats an empty string as unset', () => {
    // A blank variable in a compose file is the commonest way to "configure"
    // a gateway that then cannot send.
    expect(configuredSmsProvider(env({ SEMAPHORE_API_KEY: '' }))).toBeUndefined();
  });

  it('needs every required variable, not one of them', () => {
    /**
     * Vacuous today — the one provider requires exactly one variable — so it
     * is asserted against the SPEC rather than by half-configuring it. What
     * this pins is that `isConfigured` reads the whole of `requires`, which
     * is the property a two-variable gateway would depend on.
     */
    for (const name of SMS_PROVIDER_NAMES) {
      const spec = SMS_PROVIDERS[name];
      const full = Object.fromEntries(spec.requires.map((key) => [key, 'x']));
      expect(spec.isConfigured(env(full))).toBe(true);
      for (const key of spec.requires) {
        const { [key]: _dropped, ...missingOne } = full;
        expect(spec.isConfigured(env(missingOne))).toBe(false);
      }
    }
  });

  it('finds the gateway once its key is set', () => {
    expect(configuredSmsProvider(env(SEMAPHORE))).toBe('semaphore');
    expect(configuredSmsProvider(env(PHILSMS))).toBe('philsms');
  });

  it('needs BOTH of PhilSMS\'s variables, not just the token', () => {
    // No longer vacuous: PhilSMS has no account-default sender, so a token
    // alone is a gateway that fails on the first login rather than one that
    // half-works. It must read as unconfigured.
    expect(configuredSmsProvider(env({ PHILSMS_API_TOKEN: 'phil-token' }))).toBeUndefined();
    expect(configuredSmsProvider(env({ PHILSMS_SENDER_ID: 'TARA' }))).toBeUndefined();
  });

  it('applies declaration order when BOTH gateways are configured', () => {
    /*
     * The decision the single-provider version left open, now that there is a
     * second adapter: precedence, not fallback, and Semaphore first so an
     * existing deployment's gateway does not change under it on an upgrade.
     */
    expect(configuredSmsProvider(env({ ...SEMAPHORE, ...PHILSMS }))).toBe('semaphore');
    expect(SMS_PROVIDER_NAMES.indexOf('semaphore')).toBeLessThan(
      SMS_PROVIDER_NAMES.indexOf('philsms'),
    );
  });

  it('ignores a variable belonging to a gateway this build has no adapter for', () => {
    // A deployment that pasted another vendor's credentials in has not
    // configured anything, and must be told so rather than half-working.
    expect(
      configuredSmsProvider(env({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't' })),
    ).toBeUndefined();
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
    const message = new NoSmsSenderError().message;
    for (const name of SMS_PROVIDER_NAMES) {
      expect(message).toContain(SMS_PROVIDERS[name].requires[0]!);
    }
    expect(describeSmsSetup()).toContain('SEMAPHORE_API_KEY');
    expect(describeSmsSetup()).toContain('PHILSMS_API_TOKEN');
  });

  it('returns the gateway, named as itself, when one is configured', () => {
    // The `provider` field on a send result and on a log line is this name;
    // support reads it off the line.
    expect(resolveSmsSender(env(SEMAPHORE)).name).toBe('semaphore');
    expect(resolveSmsSender(env(PHILSMS)).name).toBe('philsms');
  });

  it('prefers a gateway over the console even in development', () => {
    expect(resolveSmsSender(env({ ...SEMAPHORE, NODE_ENV: 'development' })).name).toBe(
      'semaphore',
    );
  });

  it('is not refused once a gateway is configured, in any runtime', () => {
    for (const runtime of ['production', 'development', 'test', undefined]) {
      expect(smsSendingIsRefused(env({ ...SEMAPHORE, NODE_ENV: runtime }))).toBe(false);
    }
  });
});

describe('the development endpoint redirect', () => {
  it('is honoured outside production', () => {
    const sender = resolveSmsSender(
      env({
        ...SEMAPHORE,
        NODE_ENV: 'development',
        SEMAPHORE_ENDPOINT: 'http://127.0.0.1:1/x',
      }),
    ) as SemaphoreSmsSender;
    expect(sender.endpoint).toBe('http://127.0.0.1:1/x');
  });

  it('is IGNORED in production, for every provider', () => {
    /**
     * A variable that can point message delivery somewhere else is a way to
     * capture login codes. The rule lives in one place (`devEndpointFor`)
     * rather than in each adapter, which is what stops the next gateway from
     * quietly honouring its own override.
     */
    const sender = resolveSmsSender(
      env({ ...SEMAPHORE, NODE_ENV: 'production', SEMAPHORE_ENDPOINT: 'http://evil/x' }),
    ) as SemaphoreSmsSender;
    expect(sender.endpoint).toContain('api.semaphore.co');
    expect(sender.endpoint).not.toContain('evil');
  });

  it('resolves the rule centrally rather than per adapter', () => {
    const source = codeOnly('src/lib/auth/sms/registry.ts');
    expect(source).toMatch(/env\.NODE_ENV === 'production'/);
    /* No ADAPTER reads NODE_ENV for itself. Found by looking for the
       interface rather than by listing filenames, so a gateway added later is
       swept without anybody remembering to add it here. */
    const adapters = readdirSync('src/lib/auth/sms')
      .map((file) => join('src/lib/auth/sms', file))
      .filter((path) => /implements SmsSender/.test(readFileSync(path, 'utf8')));
    expect(adapters.length).toBeGreaterThan(0); // else this sweeps nothing
    for (const path of adapters) {
      expect(codeOnly(path)).not.toMatch(/NODE_ENV/);
    }
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
      if (/SEMAPHORE_[A-Z_]+|PHILSMS_[A-Z_]+|TWILIO_[A-Z_]+/.test(codeOnly(file)))
        found.push(file);
    }
    return found;
  }

  it('finds the names inside the directory, so the sweep is not vacuous', () => {
    // If these two stop matching, `offenders()` is sweeping for a string that
    // no longer exists and would pass over any file.
    expect(codeOnly('src/lib/auth/sms/registry.ts')).toMatch(/SEMAPHORE_API_KEY/);
    expect(codeOnly('src/lib/auth/sms/build.ts')).toMatch(/SEMAPHORE_API_KEY/);
    expect(codeOnly('src/lib/auth/sms/registry.ts')).toMatch(/PHILSMS_API_TOKEN/);
    expect(codeOnly('src/lib/auth/sms/build.ts')).toMatch(/PHILSMS_API_TOKEN/);
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

  it('the login screen does not pull the adapter in to render a string', () => {
    /**
     * `describeSmsSetup` is rendered on the most-visited page in the
     * application. The specs are data in `registry.ts` and the constructors
     * live in `build.ts` precisely so that page's module graph stays clear of
     * an HTTP client — the same mistake that once broke the customer's
     * tracking map.
     */
    const registry = codeOnly('src/lib/auth/sms/registry.ts');
    expect(registry).not.toMatch(/SemaphoreSmsSender/);
    expect(registry).not.toMatch(/from '@\/lib\/auth\/sms\/semaphore'/);
  });
});

describe('adding a second gateway stays cheap', () => {
  it('needs an adapter, a spec and a builder — and nothing else', () => {
    /**
     * Not a behavioural test; a statement of the seam, checked. If selection
     * ever grows a provider-specific branch again, this is where it shows.
     */
    const barrel = codeOnly('src/lib/auth/sms/index.ts');
    /* The barrel re-exports the adapter BY NAME, which is its job — the
       send-one script imports it from here. So the claim is narrower and more
       useful than "the file never says semaphore": the two functions that
       DECIDE must have no provider-specific branch in them. Sliced from the
       first of them to the end of the file. */
    const selection = barrel.slice(barrel.indexOf('export function smsSendingIsRefused'));
    expect(selection).not.toMatch(/semaphore|philsms|twilio/i);
    expect(selection).toMatch(
      /SMS_BUILDERS\[configured\]\(env, devEndpointFor\(configured, env\)\)/,
    );
    // And the slice is not empty, which would make the check vacuous.
    expect(selection).toContain('resolveSmsSender');
  });

  it('every declared provider actually builds', () => {
    // A spec whose builder throws on its own configuration is a provider that
    // exists on a screen and not in fact.
    const cases: Readonly<Record<SmsProviderName, SmsEnv>> = {
      semaphore: env(SEMAPHORE),
      philsms: env(PHILSMS),
    };
    for (const name of SMS_PROVIDER_NAMES) {
      const sender = SMS_BUILDERS[name](cases[name], undefined);
      expect(sender.name).toBe(name);
      expect(typeof sender.send).toBe('function');
    }
  });

  it('selection returns ONE gateway, so a second cannot be silently ignored', () => {
    /**
     * The shape is the safeguard. `configuredSmsProvider` answers a single
     * name; an array-returning version would let a second provider be added,
     * land in position two, and never be reached — a gateway that exists on a
     * screen and in nobody's inbox. Adding one has to change this signature,
     * which forces a decision about what happens when both are configured.
     */
    const answer = configuredSmsProvider(env({ ...SEMAPHORE, ...PHILSMS }));
    expect(Array.isArray(answer)).toBe(false);
    expect(answer).toBe('semaphore');
  });
});
