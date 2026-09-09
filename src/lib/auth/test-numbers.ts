import { CODE_LENGTH } from '@/lib/auth/crypto';
import {
  maskPhilippineMobile,
  tryNormalisePhilippineMobile,
} from '@/lib/auth/phone';

/**
 * Numbers that sign in with a fixed code and no SMS.
 *
 * ### Why this exists, and why it is not "turn OTP off"
 *
 * A dry run needs somebody to be able to sign in, and sign-in needs an SMS
 * gateway, and a gateway needs a prepaid top-up. That is a real bill to pay
 * before anybody has clicked anything, and the thing being tested is the
 * ORDER LIFECYCLE, not the carrier.
 *
 * The obvious shortcut — a variable that makes any code work — is a hole, not
 * a shortcut. This deployment's seed writes real Philippine number formats and
 * one of them holds ADMIN; a build that accepts any code for any number hands
 * the console to whoever finds the URL. And it is precisely the shape of thing
 * that ships to production by accident, because nothing about it looks
 * different once it works.
 *
 * So: an **allowlist**, and nothing else changes.
 *
 *     AUTH_TEST_NUMBERS="09171234567:123456,09181234568:654321"
 *
 * A number on that list gets its `PhoneVerification` row written with the code
 * named beside it, and the gateway is not called. Every other number goes
 * through the real path, and on a deployment with no gateway that still means
 * refused. Nothing here widens what an unlisted number can do.
 *
 * ### What is deliberately NOT relaxed
 *
 * The row is a real row. The five-minute expiry, the single-use consume, the
 * five-attempt ceiling, the resend cooldown and both request throttles apply
 * exactly as they do to a real code, because a rehearsal that skips them is
 * not a rehearsal of this application. The only difference is which six digits
 * are in the row and that no message was sent.
 *
 * ### Why it is allowed in production, unlike the endpoint override
 *
 * `SEMAPHORE_ENDPOINT` is ignored in production, and this is not — which looks
 * inconsistent until you compare what each one does when set by somebody who
 * should not have set it. The endpoint override redirects **everybody's** codes
 * to another host: a silent, total capture, and no legitimate deployment needs
 * it. This affects only numbers an operator typed out by hand, one at a time.
 * A dry run happens on a real deployment with a production build — that is
 * what makes it a dry run — so refusing it there would refuse the only case it
 * is for.
 *
 * What that trade buys has to be paid for in noise, and it is: the login
 * screen says so to whoever loads it, and `/admin/health` says so in red.
 * Leaving this set after launch is a static password on a live account, so it
 * is not something the deployment lets you forget about.
 */

/** The one variable. Named here so no screen spells it by hand. */
export const TEST_NUMBERS_VAR = 'AUTH_TEST_NUMBERS';

export interface TestNumbersEnv {
  AUTH_TEST_NUMBERS?: string | undefined;
  [key: string]: string | undefined;
}

export interface TestNumberEntry {
  /** E.164, normalised the same way the login form normalises what is typed. */
  phone: string;
  code: string;
}

export interface ParsedTestNumbers {
  entries: readonly TestNumberEntry[];
  /**
   * Fragments that were not usable, kept rather than dropped.
   *
   * A typo in this variable means an operator sits at a login screen entering
   * a code that will never work, with nothing anywhere saying why. So the
   * rejects are reported on `/admin/health` alongside the accepted ones.
   */
  rejected: readonly string[];
}

/**
 * Reads the variable.
 *
 * Pure, and total: every input produces a result, and anything unusable lands
 * in `rejected` rather than throwing. A malformed entry must not be able to
 * take a login screen down — the screen is the only thing left when this
 * variable is the reason somebody is looking at it.
 */
export function parseTestNumbers(raw: string | undefined): ParsedTestNumbers {
  const entries: TestNumberEntry[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();

  for (const fragment of (raw ?? '').split(',')) {
    const piece = fragment.trim();
    if (piece === '') continue;

    // `split(':')` rather than a regex on the whole thing, so a fragment with
    // two colons is reported instead of half-matching.
    const parts = piece.split(':');
    if (parts.length !== 2) {
      rejected.push(piece);
      continue;
    }

    const phone = tryNormalisePhilippineMobile(parts[0]!.trim());
    const code = parts[1]!.trim();

    if (phone === null) {
      rejected.push(piece);
      continue;
    }
    /* Exactly the shape a real code has. A four-digit test code would pass
       here and then be refused by the login form, which checks for six — two
       places disagreeing about the same value is how this stops being
       debuggable. */
    if (!new RegExp(`^\\d{${CODE_LENGTH}}$`).test(code)) {
      rejected.push(piece);
      continue;
    }
    // First listing wins, and a repeat is reported: two codes for one number
    // is an operator who edited this in a hurry, not a preference.
    if (seen.has(phone)) {
      rejected.push(piece);
      continue;
    }

    seen.add(phone);
    entries.push({ phone, code });
  }

  return { entries, rejected };
}

/**
 * The fixed code for a number, or undefined.
 *
 * `undefined` is the answer for every number when the variable is unset, which
 * is what makes the wiring in `requestLoginCode` a single branch that vanishes
 * on a normal deployment.
 */
export function testCodeFor(
  phone: string,
  env: TestNumbersEnv = process.env,
): string | undefined {
  const normalised = tryNormalisePhilippineMobile(phone);
  if (normalised === null) return undefined;
  return parseTestNumbers(env[TEST_NUMBERS_VAR]).entries.find(
    (entry) => entry.phone === normalised,
  )?.code;
}

/** Is this deployment running with the allowlist on at all? */
export function testNumbersAreEnabled(env: TestNumbersEnv = process.env): boolean {
  return parseTestNumbers(env[TEST_NUMBERS_VAR]).entries.length > 0;
}

/**
 * What to show an operator, masked.
 *
 * The numbers are masked and the codes are never returned. Not because the
 * codes are secret from an administrator — they typed them — but because this
 * renders on a screen somebody may be sharing, and a full number plus its
 * static code is the whole credential.
 */
export function describeTestNumbers(env: TestNumbersEnv = process.env): {
  enabled: boolean;
  masked: readonly string[];
  rejected: readonly string[];
} {
  const parsed = parseTestNumbers(env[TEST_NUMBERS_VAR]);
  return {
    enabled: parsed.entries.length > 0,
    masked: parsed.entries.map((entry) => maskPhilippineMobile(entry.phone)),
    rejected: parsed.rejected,
  };
}
