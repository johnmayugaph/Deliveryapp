import { createHash, randomInt } from 'node:crypto';
import {
  GIFT_CODE_ALPHABET,
  GIFT_CODE_LENGTH,
  normaliseGiftCode,
} from '@/lib/gift-cards/policy';

/**
 * Making a gift card code, and turning one into the only form we keep.
 *
 * Split from `policy.ts` so the rules stay importable by a client component
 * without dragging `node:crypto` into a browser bundle — the same split the
 * pricing and surge modules use.
 */

/**
 * A fresh bearer code.
 *
 * `randomInt` from `node:crypto`, not `Math.random`. Two reasons, and the
 * second is the one that matters: `Math.random` is not a CSPRNG, so its output
 * is predictable from a few observed values — and a few observed values is
 * exactly what an attacker has, because we hand codes out. Somebody who
 * redeemed two cards from a printed batch could compute the rest of the batch.
 *
 * `randomInt(n)` also rejection-samples rather than taking a modulus, so every
 * character is equally likely. `randomBytes(16)` with `% 30` would be biased
 * towards the first sixteen letters of the alphabet (256 mod 30 = 16). That
 * bias is worth nothing to an attacker at this length, but it costs nothing to
 * avoid and a future shorter code would inherit the fix.
 */
export function generateGiftCode(): string {
  let code = '';
  for (let index = 0; index < GIFT_CODE_LENGTH; index += 1) {
    code += GIFT_CODE_ALPHABET[randomInt(GIFT_CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * The stored form of a code. The plaintext is never written down.
 *
 * Plain SHA-256, deliberately, and not the keyed HMAC the OTP uses:
 *
 *  - **There is no dictionary to attack.** An OTP is six digits — a million
 *    possibilities, so an unkeyed hash in a leaked database is a rainbow table
 *    away from plaintext, and the key is what stands between the two. A gift
 *    card is ~78 bits of CSPRNG output. There is nothing to enumerate.
 *  - **A key would make `AUTH_SECRET` load-bearing for money.** Rotating that
 *    secret is a routine security action — after a leak, or on a schedule —
 *    and if gift cards were keyed with it, rotating it would silently void
 *    every card in circulation. That is not a bug that shows up in a test; it
 *    is a drawer of printed cards that stop working, and money owed to people
 *    who cannot prove it.
 *
 * Same reasoning as `hashSessionToken`, which is the same shape of value.
 *
 * Normalises first, so what is hashed is the bare canonical form and the
 * hyphens somebody typed cannot change the answer.
 */
export function hashGiftCode(code: string): string {
  return createHash('sha256').update(normaliseGiftCode(code)).digest('hex');
}

/** Reference characters. Shorter than a code because it protects nothing. */
const REFERENCE_LENGTH = 6;

/**
 * A short, non-secret handle for one card: `GC-7K2MPQ`.
 *
 * This is what the console lists, what support quotes on the phone, and what
 * goes in the customer's credits history. It grants nothing — redeeming needs
 * the code — so it is fine that it is short and guessable.
 *
 * Generated INDEPENDENTLY of the code rather than being a prefix or suffix of
 * it. A reference derived from the code would leak part of the secret into
 * every screen, every log line and every backup that holds a reference, which
 * is a strange amount of entropy to give away for the convenience of not
 * calling `randomInt` a second time.
 */
export function generateReference(): string {
  let out = '';
  for (let index = 0; index < REFERENCE_LENGTH; index += 1) {
    out += GIFT_CODE_ALPHABET[randomInt(GIFT_CODE_ALPHABET.length)];
  }
  return `GC-${out}`;
}
