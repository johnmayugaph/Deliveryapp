/**
 * Philippine mobile number normalisation.
 *
 * Every phone number entering the system passes through here first, because
 * `User.phone` is the login identity and a number that normalises two different
 * ways is two accounts for one person — or worse, a code delivered to someone
 * else. Filipinos write their own number half a dozen ways:
 *
 *     0917 123 4567      the everyday local form
 *     +63 917 123 4567   international
 *     639171234567       no plus, as pasted from a spreadsheet
 *     0917-123-4567      dashes
 *     (0917) 1234567     parenthesised area-code habit from landlines
 *
 * All of those are the same person, and all normalise to +639171234567.
 *
 * Pure, and heavily tested: this is the one function where a subtle bug sends a
 * login code to a stranger.
 */

/** Philippine country calling code. */
const COUNTRY_CODE = '63';

/**
 * Mobile numbers are `9` followed by nine digits — the national significant
 * number is always ten digits beginning with 9. Landlines start with 2-8 and
 * cannot receive an SMS from a bulk gateway reliably, so they are rejected
 * rather than silently accepted and then failing at send time.
 */
const MOBILE_NSN = /^9\d{9}$/;

export class InvalidPhoneNumberError extends Error {
  constructor(readonly input: string, readonly reason: string) {
    super(`"${input}" is not a usable Philippine mobile number: ${reason}`);
    this.name = 'InvalidPhoneNumberError';
  }
}

/**
 * Reduces input to digits, keeping track of whether it was written in
 * international form. Strips the separators people actually type — spaces,
 * dashes, dots, brackets, non-breaking spaces — and nothing else, so a letter
 * in the middle is still an error rather than being quietly deleted.
 */
function toDigits(input: string): { digits: string; hadPlus: boolean } {
  const trimmed = input.trim();
  const hadPlus = trimmed.startsWith('+');
  const body = hadPlus ? trimmed.slice(1) : trimmed;
  const stripped = body.replace(/[\s ().\-–—]/g, '');
  return { digits: stripped, hadPlus };
}

/**
 * The national significant number (ten digits, starting 9) for a Philippine
 * mobile, or null if the input is not one.
 */
function toNationalSignificant(input: string): string | null {
  const { digits, hadPlus } = toDigits(input);

  if (digits.length === 0 || !/^\d+$/.test(digits)) {
    return null;
  }

  // +63 9xx xxx xxxx  /  639xxxxxxxxx
  if (digits.startsWith(COUNTRY_CODE)) {
    const rest = digits.slice(COUNTRY_CODE.length);
    // Guard the ambiguity: "639171234567" is a country code plus a mobile, but
    // a bare local "63917..." is not a thing — local mobiles start 09.
    return MOBILE_NSN.test(rest) ? rest : null;
  }

  // 0917 123 4567 — the trunk prefix is dropped in E.164.
  if (digits.startsWith('0')) {
    const rest = digits.slice(1);
    return MOBILE_NSN.test(rest) ? rest : null;
  }

  // 9171234567, typed without the leading zero.
  if (MOBILE_NSN.test(digits)) {
    return digits;
  }

  // A leading + that was not +63 is some other country; out of scope rather
  // than mangled into a Philippine number.
  if (hadPlus) {
    return null;
  }

  return null;
}

/** True when `input` is a Philippine mobile number in any common written form. */
export function isValidPhilippineMobile(input: string): boolean {
  return toNationalSignificant(input) !== null;
}

/**
 * Normalises to E.164 (`+639171234567`). Throws rather than returning null, so
 * a caller cannot forget to check — the alternative is an un-normalised number
 * reaching the database.
 */
export function normalisePhilippineMobile(input: string): string {
  const nsn = toNationalSignificant(input);
  if (nsn === null) {
    const { digits } = toDigits(input);
    const reason =
      digits.length === 0
        ? 'no digits'
        : !/^\d+$/.test(digits)
          ? 'contains characters that are not digits'
          : 'Philippine mobile numbers are 09xx xxx xxxx';
    throw new InvalidPhoneNumberError(input, reason);
  }
  return `+${COUNTRY_CODE}${nsn}`;
}

/** Normalises, or null. For places where invalid input is an expected outcome. */
export function tryNormalisePhilippineMobile(input: string): string | null {
  const nsn = toNationalSignificant(input);
  return nsn === null ? null : `+${COUNTRY_CODE}${nsn}`;
}

/**
 * Local display form: `0917 123 4567`. What a Filipino expects to see back,
 * rather than the E.164 we store.
 */
export function formatPhilippineMobile(e164: string): string {
  const nsn = toNationalSignificant(e164);
  if (nsn === null) {
    return e164;
  }
  return `0${nsn.slice(0, 3)} ${nsn.slice(3, 6)} ${nsn.slice(6)}`;
}

/**
 * Partly masked, for confirmation screens and support transcripts:
 * `0917 ••• 4567`. Enough for someone to recognise their own number without
 * printing it in full.
 */
export function maskPhilippineMobile(e164: string): string {
  const nsn = toNationalSignificant(e164);
  if (nsn === null) {
    return e164;
  }
  return `0${nsn.slice(0, 3)} ••• ${nsn.slice(6)}`;
}
