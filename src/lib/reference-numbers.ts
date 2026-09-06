import { randomInt } from 'node:crypto';

/**
 * Human-facing reference numbers for orders and support tickets.
 *
 * Deliberately NOT a `count() + 1` sequence. Two orders placed in the same
 * millisecond would read the same count and generate the same number, and the
 * unique constraint would then fail one of them at random — a lost order, for
 * cosmetic tidiness. A date plus random characters is collision-resistant, and
 * still short enough to read over the phone.
 *
 * The alphabet omits I, L, O, U, 0 and 1: a customer reading a code aloud to
 * support should not have to distinguish O from 0.
 */
const UNAMBIGUOUS_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomCode(length: number): string {
  let code = '';
  for (let index = 0; index < length; index += 1) {
    code += UNAMBIGUOUS_ALPHABET[randomInt(UNAMBIGUOUS_ALPHABET.length)];
  }
  return code;
}

function datePart(now: Date): string {
  return now.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * e.g. `DA-20260906-K3M9Q`. ~24 million codes per day, so a same-day collision
 * needs a birthday-paradox coincidence rather than a race.
 */
export function generateOrderNumber(now: Date = new Date()): string {
  return `DA-${datePart(now)}-${randomCode(5)}`;
}

/** e.g. `HELP-20260906-K3M9Q`. */
export function generateTicketNumber(now: Date = new Date()): string {
  return `HELP-${datePart(now)}-${randomCode(5)}`;
}

export { UNAMBIGUOUS_ALPHABET };
