import { describe, expect, it } from 'vitest';
import type { AuthEnv } from '@/lib/auth/crypto';
import {
  authSecret,
  CODE_LENGTH,
  generateLoginCode,
  generateSessionToken,
  hashClientIp,
  hashLoginCode,
  loginCodeMatches,
  MissingAuthSecretError,
  hashSessionToken,
} from '@/lib/auth/crypto';

const ENV: AuthEnv = { AUTH_SECRET: 'a'.repeat(64) };
const OTHER_ENV: AuthEnv = { AUTH_SECRET: 'b'.repeat(64) };

describe('the server secret is mandatory', () => {
  it('refuses a missing secret', () => {
    expect(() => authSecret({})).toThrow(MissingAuthSecretError);
  });

  it('refuses a short secret, which would be guessable', () => {
    expect(() => authSecret({ AUTH_SECRET: 'short' })).toThrow(
      MissingAuthSecretError,
    );
  });

  it('explains how to generate one', () => {
    expect(() => authSecret({})).toThrow(/openssl rand -hex 32/);
  });

  it('accepts a 32-byte hex secret', () => {
    expect(authSecret(ENV)).toBe(ENV.AUTH_SECRET);
  });
});

describe('login codes', () => {
  it('is six digits', () => {
    for (let index = 0; index < 200; index += 1) {
      expect(generateLoginCode()).toMatch(/^\d{6}$/);
    }
  });

  it('can produce leading zeros, so the keyspace is the full million', () => {
    // Math.floor(Math.random() * 1e6) rendered as a number silently drops these,
    // which would make "000123" unreachable and shrink the keyspace.
    const codes = Array.from({ length: 4000 }, generateLoginCode);
    expect(codes.some((code) => code.startsWith('0'))).toBe(true);
  });

  it('does not repeat itself over a large sample', () => {
    const codes = new Set(Array.from({ length: 2000 }, generateLoginCode));
    // With a million possibilities, 2000 draws should be nearly all distinct.
    expect(codes.size).toBeGreaterThan(1900);
  });

  it('uses every digit across a large sample', () => {
    const seen = new Set(Array.from({ length: 2000 }, generateLoginCode).join(''));
    expect(seen.size).toBe(10);
  });

  it('declares its own length', () => {
    expect(generateLoginCode()).toHaveLength(CODE_LENGTH);
  });
});

describe('code hashing', () => {
  it('is deterministic for one secret', () => {
    expect(hashLoginCode('123456', ENV)).toBe(hashLoginCode('123456', ENV));
  });

  it('never stores the code itself', () => {
    const hash = hashLoginCode('123456', ENV);
    expect(hash).not.toContain('123456');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is keyed, so a stolen database is not enough to recover codes', () => {
    // The whole point of the HMAC: identical codes hash differently under
    // different secrets, so a leaked table cannot be rainbow-tabled.
    expect(hashLoginCode('123456', ENV)).not.toBe(hashLoginCode('123456', OTHER_ENV));
  });

  it('separates codes that differ by one digit', () => {
    expect(hashLoginCode('123456', ENV)).not.toBe(hashLoginCode('123457', ENV));
  });
});

describe('code comparison', () => {
  it('accepts the right code', () => {
    expect(loginCodeMatches('123456', hashLoginCode('123456', ENV), ENV)).toBe(true);
  });

  it('rejects the wrong code', () => {
    expect(loginCodeMatches('999999', hashLoginCode('123456', ENV), ENV)).toBe(false);
  });

  it('rejects a code hashed under a different secret', () => {
    expect(loginCodeMatches('123456', hashLoginCode('123456', OTHER_ENV), ENV)).toBe(false);
  });

  it('fails closed on a corrupt stored hash rather than throwing', () => {
    // timingSafeEqual throws on a length mismatch, which would surface as a 500
    // on the login path; a corrupt row should just not match.
    for (const corrupt of ['', 'zz', 'abc', 'a'.repeat(63), 'a'.repeat(65)]) {
      expect(loginCodeMatches('123456', corrupt, ENV)).toBe(false);
    }
  });
});

describe('session tokens', () => {
  it('has 256 bits of entropy, so it is not guessable', () => {
    const token = generateSessionToken();
    // 32 bytes base64url-encoded, unpadded.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('never repeats', () => {
    const tokens = new Set(Array.from({ length: 2000 }, generateSessionToken));
    expect(tokens.size).toBe(2000);
  });

  it('is stored only as a hash, so a database dump yields no live sessions', () => {
    const token = generateSessionToken();
    const hash = hashSessionToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
  });

  it('hashes deterministically, since lookup is by hash', () => {
    const token = generateSessionToken();
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
  });

  it('needs no secret, because the token is already random', () => {
    // Unlike a six-digit code there is no dictionary to attack, so a plain
    // SHA-256 is right and a slow KDF would only tax every request.
    const token = generateSessionToken();
    expect(() => hashSessionToken(token)).not.toThrow();
  });
});

describe('client address fingerprints', () => {
  it('is stable for one address', () => {
    expect(hashClientIp('203.0.113.7', ENV)).toBe(hashClientIp('203.0.113.7', ENV));
  });

  it('differs between addresses', () => {
    expect(hashClientIp('203.0.113.7', ENV)).not.toBe(hashClientIp('203.0.113.8', ENV));
  });

  it('is truncated and keyed, so throttling is not a quiet access log', () => {
    const hash = hashClientIp('203.0.113.7', ENV);
    expect(hash).toHaveLength(32);
    // Hex only — no dots or colons, so the stored value cannot be an address.
    // (Checking for the substring "203" would be a bad test: hex contains
    // digits, so it can appear by coincidence.)
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
    expect(hashClientIp('203.0.113.7', OTHER_ENV)).not.toBe(hash);
  });

  it('handles IPv6', () => {
    expect(hashClientIp('2001:db8::1', ENV)).toMatch(/^[0-9a-f]{32}$/);
  });
});
