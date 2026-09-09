import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  TEST_NUMBERS_VAR,
  describeTestNumbers,
  parseTestNumbers,
  testCodeFor,
  testNumbersAreEnabled,
  type TestNumbersEnv,
} from '@/lib/auth/test-numbers';
import { signInBlockers, signInWarnings } from '@/lib/deploy/sign-in-readiness';
import { maskPhilippineMobile } from '@/lib/auth/phone';

/**
 * Signing in on a fixed code, without paying for SMS.
 *
 * The thing under test is not really "does the code work" — that is one branch
 * — it is the BOUNDARY. A shortcut that lets a dry run happen without a
 * prepaid balance is one edit away from a build that hands an account to
 * whoever finds the URL, so most of what follows is about what this cannot do.
 */

const env = (raw?: string): TestNumbersEnv =>
  raw === undefined ? {} : { [TEST_NUMBERS_VAR]: raw };

const ONE = '09171234567:123456';

// -----------------------------------------------------------------------------
// Reading the variable
// -----------------------------------------------------------------------------

describe('parsing the allowlist', () => {
  it('is empty when unset, empty, or whitespace', () => {
    for (const raw of [undefined, '', '   ', ',', ' , , ']) {
      const parsed = parseTestNumbers(raw);
      expect(parsed.entries).toEqual([]);
      expect(parsed.rejected).toEqual([]);
    }
  });

  it('normalises the number to E.164, whatever form it was typed in', () => {
    // The login form normalises what somebody types; if this did not, a number
    // listed as 0917… would never match a request that arrived as +63917….
    for (const written of [
      '09171234567',
      '+639171234567',
      '639171234567',
      '9171234567',
    ]) {
      expect(parseTestNumbers(`${written}:123456`).entries).toEqual([
        { phone: '+639171234567', code: '123456' },
      ]);
    }
  });

  it('tolerates the whitespace a hand-edited .env picks up', () => {
    expect(
      parseTestNumbers(' 09171234567 : 123456 , 09181234568:654321 ').entries,
    ).toEqual([
      { phone: '+639171234567', code: '123456' },
      { phone: '+639181234568', code: '654321' },
    ]);
  });

  it('REPORTS what it could not read rather than dropping it', () => {
    /**
     * The failure this prevents: an operator sits at a login screen entering a
     * code that cannot work, with nothing anywhere saying why. Every reject is
     * surfaced on /admin/health.
     */
    const cases: Readonly<Record<string, string>> = {
      '09171234567': 'no code at all',
      '09171234567:123456:789': 'two colons',
      'not-a-number:123456': 'not a phone number',
      '09171234567:12345': 'five digits',
      '09171234567:1234567': 'seven digits',
      '09171234567:12345a': 'not all digits',
      '09171234567:': 'empty code',
      '02181234567:123456': 'a landline, not a mobile',
    };
    for (const [raw, why] of Object.entries(cases)) {
      const parsed = parseTestNumbers(raw);
      expect(parsed.entries, why).toEqual([]);
      expect(parsed.rejected, why).toEqual([raw]);
    }
  });

  it('keeps the good entries when one beside them is malformed', () => {
    // A typo in the third pair must not disable the first two — that would
    // turn one bad character into "nobody can sign in".
    const parsed = parseTestNumbers(`${ONE},oops,09181234568:654321`);
    expect(parsed.entries.map((entry) => entry.phone)).toEqual([
      '+639171234567',
      '+639181234568',
    ]);
    expect(parsed.rejected).toEqual(['oops']);
  });

  it('takes the first listing for a repeated number, and reports the rest', () => {
    const parsed = parseTestNumbers(`${ONE},09171234567:999999`);
    expect(parsed.entries).toEqual([{ phone: '+639171234567', code: '123456' }]);
    expect(parsed.rejected).toEqual(['09171234567:999999']);
  });

  it('never throws, whatever is in the variable', () => {
    for (const raw of ['::::', ':', ' ', 'a'.repeat(5000), '09171234567:123456,']) {
      expect(() => parseTestNumbers(raw)).not.toThrow();
    }
  });
});

// -----------------------------------------------------------------------------
// The boundary
// -----------------------------------------------------------------------------

describe('what the allowlist does NOT cover', () => {
  it('gives no code for a number that is not on it', () => {
    // THE property. Everything else here is convenience; this is the reason
    // this feature is not a back door.
    expect(testCodeFor('09991234567', env(ONE))).toBeUndefined();
  });

  it('gives no code for anybody when the variable is unset', () => {
    expect(testCodeFor('09171234567', env())).toBeUndefined();
    expect(testNumbersAreEnabled(env())).toBe(false);
  });

  it('gives no code for a rejected entry, so a typo fails closed', () => {
    // A five-digit code does not become "any code for this number".
    expect(testCodeFor('09171234567', env('09171234567:12345'))).toBeUndefined();
  });

  it('gives no code for input that is not a Philippine mobile', () => {
    for (const junk of ['', 'null', '../../etc/passwd', '+15551234567']) {
      expect(testCodeFor(junk, env(ONE))).toBeUndefined();
    }
  });

  it('matches a listed number however the request spelled it', () => {
    for (const asked of ['09171234567', '+639171234567', '0917 123 4567']) {
      expect(testCodeFor(asked, env(ONE))).toBe('123456');
    }
  });
});

describe('what an operator is shown', () => {
  it('masks the numbers and never returns the codes', () => {
    /**
     * Not because a code is secret from an administrator — they typed it — but
     * because /admin/health gets screen-shared, and a full number beside its
     * static code is the entire credential.
     */
    const shown = describeTestNumbers(env(`${ONE},09181234568:654321`));
    expect(shown.enabled).toBe(true);
    expect(shown.masked).toEqual([
      maskPhilippineMobile('+639171234567'),
      maskPhilippineMobile('+639181234568'),
    ]);
    // Masked means masked: the full national number is not in there.
    expect(shown.masked.join(' ')).not.toContain('1234567');

    const serialised = JSON.stringify(shown);
    expect(serialised).not.toContain('123456');
    expect(serialised).not.toContain('654321');
    // And the sweep is not vacuous: those codes really are in the variable.
    expect(parseTestNumbers(ONE).entries[0]!.code).toBe('123456');
  });

  it('reports a variable that is set but entirely unusable', () => {
    // Distinguishable from unset, because the two need opposite words: one is
    // a deployment working normally and the other is a typo.
    const shown = describeTestNumbers(env('09171234567'));
    expect(shown.enabled).toBe(false);
    expect(shown.rejected).toEqual(['09171234567']);
  });
});

// -----------------------------------------------------------------------------
// What the login screen says
// -----------------------------------------------------------------------------

describe('the login screen notice', () => {
  it('warns while the allowlist is on, and says nothing when it is off', () => {
    expect(signInWarnings({ env: env(ONE) })).toEqual(['TEST_NUMBERS_ENABLED']);
    expect(signInWarnings({ env: env() })).toEqual([]);
    // A variable set to junk is not a working allowlist, so it is not warned
    // about here — /admin/health is where the typo is reported.
    expect(signInWarnings({ env: env('oops') })).toEqual([]);
  });

  it('does not stop reporting the missing gateway', () => {
    /**
     * The honesty property, and the easy thing to get wrong. Test numbers make
     * sign-in possible for a handful of numbers; they do not make this
     * deployment able to sign anybody ELSE in. A build that swallowed
     * NO_SMS_GATEWAY here would leave an operator believing sign-in worked
     * right up until the first real customer.
     */
    const production = { NODE_ENV: 'production', ...env(ONE) };
    expect(signInBlockers({ env: production })).toContain('NO_SMS_GATEWAY');
  });
});

// -----------------------------------------------------------------------------
// The seam, guarded
// -----------------------------------------------------------------------------

describe('where the allowlist is consulted', () => {
  const otp = readFileSync('src/lib/auth/otp.ts', 'utf8');

  it('is checked BEFORE a gateway is resolved', () => {
    /**
     * Not cosmetic ordering. `resolveSmsSender()` THROWS on a deployment with
     * no gateway configured, which is exactly the deployment this feature is
     * for — so consulting the allowlist afterwards would make it useless in
     * the one case it exists to serve.
     */
    const allowlist = otp.indexOf('testCodeFor(');
    const resolve = otp.indexOf('resolveSmsSender()');
    expect(allowlist).toBeGreaterThan(-1);
    expect(resolve).toBeGreaterThan(-1);
    expect(allowlist).toBeLessThan(resolve);
  });

  it('leaves the throttles and the code lifetime alone', () => {
    /**
     * A rehearsal that skipped the cooldown, the attempt ceiling or the expiry
     * would not be a rehearsal of this application. The row a test number gets
     * is written by the same code as everybody else's — so what is asserted is
     * that there is ONE create call and one TTL, not a second relaxed path
     * beside it.
     */
    expect(otp.match(/phoneVerification\.create\(/g)).toHaveLength(1);
    expect(otp.match(/CODE_TTL_SECONDS \* 1000/g)).toHaveLength(1);
    expect(otp.match(/evaluateThrottle\(/g)).toHaveLength(1);
    // And the fixed code goes through the same HMAC as a generated one.
    expect(otp).toMatch(/codeHash: hashLoginCode\(code\)/);
    expect(otp).toMatch(/const code = testCode \?\? generateLoginCode\(\)/);
  });

  it('leaves verification untouched, so a fixed code is checked like any other', () => {
    // No branch on the allowlist anywhere in the verify half of the module.
    const verify = otp.slice(otp.indexOf('export async function verifyLoginCode'));
    expect(verify).toContain('loginCodeMatches');
    expect(verify).not.toMatch(/testCode|testNumbers/i);
  });

  it('does not spell the variable name outside its own module', () => {
    // Same rule as the SMS gateway: the name lives in one place so a screen
    // cannot drift from what the code reads.
    for (const file of [
      'src/lib/auth/otp.ts',
      'src/lib/deploy/sign-in-readiness.ts',
      'src/components/auth/SignInBlockedNotice.tsx',
      'src/app/admin/health/page.tsx',
    ]) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/AUTH_TEST_NUMBERS/);
    }
    // Not vacuous: it is spelled in the module that owns it.
    expect(readFileSync('src/lib/auth/test-numbers.ts', 'utf8')).toMatch(
      /AUTH_TEST_NUMBERS/,
    );
  });
});
