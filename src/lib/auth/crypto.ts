import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * Cryptographic primitives for authentication. Pure, and separated from the
 * database work so the rules that decide whether a code matches are testable
 * without Postgres.
 */

/**
 * Just the variables these functions read. Narrower than `ProcessEnv` on
 * purpose: a helper that needs one secret should not demand the whole
 * environment, and a test should not have to fabricate NODE_ENV to call it.
 */
export interface AuthEnv {
  AUTH_SECRET?: string | undefined;
  /** Present so `process.env` satisfies this type structurally. */
  [key: string]: string | undefined;
}

export class MissingAuthSecretError extends Error {
  constructor() {
    super(
      'AUTH_SECRET is not set. Generate one with `openssl rand -hex 32` and put it in .env. ' +
        'Without it, login codes in the database could be brute-forced back to plaintext.',
    );
    this.name = 'MissingAuthSecretError';
  }
}

/**
 * The server secret keying the OTP HMAC.
 *
 * Read at call time, not module load, so a missing secret surfaces as a clear
 * error on the login path rather than crashing the whole app at boot — and so
 * tests can set it per case.
 */
export function authSecret(env: AuthEnv = process.env): string {
  const secret = env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new MissingAuthSecretError();
  }
  return secret;
}

/** Digits only, so the code is easy to read off a phone and type one-handed. */
const CODE_ALPHABET = '0123456789';
export const CODE_LENGTH = 6;

/**
 * A login code, from a CSPRNG.
 *
 * `randomInt` rather than `Math.random`, and per-digit rather than
 * `Math.floor(Math.random() * 1e6)` — the latter also drops leading zeros,
 * which would quietly shrink the keyspace and make "000123" impossible.
 */
export function generateLoginCode(): string {
  let code = '';
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * HMAC of a login code, keyed with the server secret.
 *
 * A six-digit code has a million possibilities, so a plain SHA-256 in a leaked
 * database is a rainbow table away from plaintext. Keying it means the database
 * alone is not enough.
 */
export function hashLoginCode(code: string, env?: AuthEnv): string {
  return createHmac('sha256', authSecret(env)).update(code).digest('hex');
}

/**
 * Constant-time comparison of a submitted code against a stored hash.
 *
 * `===` on the hex strings would leak, through timing, how many leading
 * characters matched. That is a small leak on a value that expires in five
 * minutes, but it costs nothing to close.
 */
export function loginCodeMatches(
  submitted: string,
  storedHash: string,
  env?: AuthEnv,
): boolean {
  let candidate: Buffer;
  let stored: Buffer;
  try {
    candidate = Buffer.from(hashLoginCode(submitted, env), 'hex');
    stored = Buffer.from(storedHash, 'hex');
  } catch {
    return false;
  }
  // timingSafeEqual throws on a length mismatch, which is itself an oracle;
  // a wrong-length stored hash is corrupt data, so fail closed.
  if (candidate.length !== stored.length) {
    return false;
  }
  return timingSafeEqual(candidate, stored);
}

/** Session token entropy. 32 bytes is 256 bits — not guessable. */
const SESSION_TOKEN_BYTES = 32;

/** A fresh opaque session token. This value goes in the cookie and nowhere else. */
export function generateSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

/**
 * The stored form of a session token.
 *
 * Plain SHA-256 rather than an HMAC or a slow KDF, deliberately: the token is
 * 256 bits of CSPRNG output, so there is no dictionary to attack and no reason
 * to slow down a lookup that happens on every request. What matters is that the
 * database holds the hash and not the token.
 */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * A stable, non-reversible fingerprint of a client address.
 *
 * Used for throttling bulk code requests from one source. Keyed with the server
 * secret and truncated: enough to recognise "this source again", not enough to
 * recover the address, so throttling does not quietly become an access log.
 */
export function hashClientIp(ip: string, env?: AuthEnv): string {
  return createHmac('sha256', authSecret(env)).update(ip).digest('hex').slice(0, 32);
}
