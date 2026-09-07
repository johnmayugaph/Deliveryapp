/**
 * Email addresses: normalising them, and refusing the ones that cannot work.
 *
 * Pure, so every rule below is testable without a database or a network.
 *
 * The deliberate position here is that this module does NOT try to decide
 * whether an address is real. It cannot — only a delivered code can, which is
 * the whole reason `emailVerifiedAt` exists. So the validation is narrow: it
 * rejects what is definitely not an address, normalises what might be, and
 * leaves the actual question to the code that gets sent.
 *
 * A regex that tries to match RFC 5322 rejects valid addresses and lets
 * invalid ones through. This one checks the four things that are worth
 * checking and stops.
 */

export class InvalidEmailAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEmailAddressError';
  }
}

/** Long enough for any real address; short enough not to be a payload. */
export const MAX_EMAIL_LENGTH = 254;

/**
 * Lower-cases and trims.
 *
 * Case-folding the whole address is technically wrong — the local part is
 * case-sensitive per the RFC — and right in practice: no provider anybody uses
 * treats `Juan@` and `juan@` as different people, and a database with both is
 * a database where a person cannot sign in with the address they typed. The
 * column is unique, so this has to be decided once, here.
 */
export function normaliseEmail(input: string): string {
  const trimmed = input.trim().toLowerCase();

  if (trimmed.length === 0) {
    throw new InvalidEmailAddressError('Enter an email address.');
  }
  if (trimmed.length > MAX_EMAIL_LENGTH) {
    throw new InvalidEmailAddressError('That address is too long to be real.');
  }
  // Exactly one @, with something on each side. Two @ is not an address; zero
  // is a username.
  const at = trimmed.indexOf('@');
  if (at <= 0 || at !== trimmed.lastIndexOf('@') || at === trimmed.length - 1) {
    throw new InvalidEmailAddressError('That does not look like an email address.');
  }

  const domain = trimmed.slice(at + 1);
  // A domain with no dot cannot receive mail from the internet. This rejects
  // `juan@localhost`, which is correct here even though it is a valid address
  // on a machine — nobody recovers an account from one.
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) {
    throw new InvalidEmailAddressError('That address needs a domain, like gmail.com.');
  }
  // Whitespace anywhere means the field caught something it should not have.
  if (/\s/.test(trimmed)) {
    throw new InvalidEmailAddressError('An email address cannot contain spaces.');
  }

  return trimmed;
}

export function tryNormaliseEmail(input: string): string | null {
  try {
    return normaliseEmail(input);
  } catch {
    return null;
  }
}

/**
 * For screens and logs: `ju••@gmail.com`.
 *
 * Enough for the owner to recognise their own address and not enough for
 * somebody reading over their shoulder — or reading a support transcript — to
 * learn it. The domain stays whole because it is not the secret; which mailbox
 * at that domain is.
 */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '••••';

  const local = email.slice(0, at);
  const domain = email.slice(at);
  const shown = local.slice(0, Math.min(2, local.length));
  return `${shown}${'•'.repeat(Math.max(2, local.length - shown.length))}${domain}`;
}
