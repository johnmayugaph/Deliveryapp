import { describe, expect, it } from 'vitest';
import {
  checkCodeUsable,
  evaluateThrottle,
  IP_WINDOW_SECONDS,
  MAX_CODES_PER_IP,
  MAX_CODES_PER_PHONE,
  MAX_VERIFY_ATTEMPTS,
  PHONE_WINDOW_SECONDS,
  RESEND_COOLDOWN_SECONDS,
  VERIFY_FAILURE_MESSAGES,
} from '@/lib/auth/otp-policy';

const NOW = new Date('2026-09-06T12:00:00.000Z');
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);

describe('resend cooldown', () => {
  it('blocks a double-tapped button', () => {
    const decision = evaluateThrottle({ now: NOW, recentForPhone: [ago(5)], recentForIpCount: 0 });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('COOLDOWN');
  });

  it('says how long to wait, so the button can count down', () => {
    const decision = evaluateThrottle({ now: NOW, recentForPhone: [ago(10)], recentForIpCount: 0 });
    expect(decision.retryAfterSeconds).toBe(RESEND_COOLDOWN_SECONDS - 10);
  });

  it('allows a resend once the cooldown has passed', () => {
    const decision = evaluateThrottle({
      now: NOW,
      recentForPhone: [ago(RESEND_COOLDOWN_SECONDS + 1)],
      recentForIpCount: 0,
    });
    expect(decision.allowed).toBe(true);
  });

  it('allows the very first request', () => {
    expect(evaluateThrottle({ now: NOW, recentForPhone: [], recentForIpCount: 0 }).allowed).toBe(true);
  });
});

describe('per-phone cap', () => {
  /** Requests spaced past the cooldown, so only the cap can refuse them. */
  function spaced(count: number): Date[] {
    return Array.from({ length: count }, (_, index) => ago((index + 1) * (RESEND_COOLDOWN_SECONDS + 10)));
  }

  it('allows up to the cap', () => {
    const decision = evaluateThrottle({
      now: NOW,
      recentForPhone: spaced(MAX_CODES_PER_PHONE - 1),
      recentForIpCount: 0,
    });
    expect(decision.allowed).toBe(true);
  });

  it('refuses past the cap, so nobody is bombarded with codes', () => {
    const decision = evaluateThrottle({
      now: NOW,
      recentForPhone: spaced(MAX_CODES_PER_PHONE),
      recentForIpCount: 0,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('PHONE_LIMIT');
  });

  it('ignores requests that have aged out of the window', () => {
    const old = Array.from({ length: MAX_CODES_PER_PHONE }, () =>
      ago(PHONE_WINDOW_SECONDS + 60),
    );
    expect(evaluateThrottle({ now: NOW, recentForPhone: old, recentForIpCount: 0 }).allowed).toBe(true);
  });

  it('reports when the window frees up, not a flat guess', () => {
    const oldest = ago(PHONE_WINDOW_SECONDS - 120);
    const recent = spaced(MAX_CODES_PER_PHONE - 1);
    const decision = evaluateThrottle({
      now: NOW,
      recentForPhone: [...recent, oldest],
      recentForIpCount: 0,
    });
    expect(decision.reason).toBe('PHONE_LIMIT');
    // The oldest falls out of the window in about two minutes.
    expect(decision.retryAfterSeconds).toBeGreaterThan(60);
    expect(decision.retryAfterSeconds).toBeLessThanOrEqual(120);
  });

  it('never reports a non-positive retry time', () => {
    const decision = evaluateThrottle({
      now: NOW,
      recentForPhone: Array.from({ length: MAX_CODES_PER_PHONE }, () => ago(PHONE_WINDOW_SECONDS)),
      recentForIpCount: 0,
    });
    if (!decision.allowed && decision.retryAfterSeconds !== undefined) {
      expect(decision.retryAfterSeconds).toBeGreaterThan(0);
    }
  });
});

describe('per-source cap', () => {
  it('refuses one script burning the SMS budget across many numbers', () => {
    const decision = evaluateThrottle({
      now: NOW,
      recentForPhone: [],
      recentForIpCount: MAX_CODES_PER_IP,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('IP_LIMIT');
    expect(decision.retryAfterSeconds).toBe(IP_WINDOW_SECONDS);
  });

  it('allows a household under the cap', () => {
    expect(
      evaluateThrottle({ now: NOW, recentForPhone: [], recentForIpCount: MAX_CODES_PER_IP - 1 })
        .allowed,
    ).toBe(true);
  });

  it('is more generous than the per-phone cap, since one address is many people', () => {
    expect(MAX_CODES_PER_IP).toBeGreaterThan(MAX_CODES_PER_PHONE);
  });
});

describe('code usability, decided before the digits are compared', () => {
  const live = { expiresAt: new Date(NOW.getTime() + 60_000), attempts: 0, consumedAt: null };

  it('accepts a live code', () => {
    expect(checkCodeUsable(live, NOW)).toEqual({ usable: true });
  });

  it('rejects a missing code', () => {
    expect(checkCodeUsable(null, NOW)).toEqual({ usable: false, failure: 'NO_CODE' });
  });

  it('rejects an expired code', () => {
    const expired = { ...live, expiresAt: new Date(NOW.getTime() - 1) };
    expect(checkCodeUsable(expired, NOW)).toEqual({ usable: false, failure: 'EXPIRED' });
  });

  it('treats the expiry instant as already expired', () => {
    const boundary = { ...live, expiresAt: NOW };
    expect(checkCodeUsable(boundary, NOW)).toEqual({ usable: false, failure: 'EXPIRED' });
  });

  it('rejects a consumed code, so a code is single use', () => {
    const used = { ...live, consumedAt: NOW };
    expect(checkCodeUsable(used, NOW)).toEqual({ usable: false, failure: 'ALREADY_USED' });
  });

  it('rejects once attempts are spent, so a guess is not free', () => {
    const spent = { ...live, attempts: MAX_VERIFY_ATTEMPTS };
    expect(checkCodeUsable(spent, NOW)).toEqual({
      usable: false,
      failure: 'TOO_MANY_ATTEMPTS',
    });
  });

  it('still allows the last permitted attempt', () => {
    const nearly = { ...live, attempts: MAX_VERIFY_ATTEMPTS - 1 };
    expect(checkCodeUsable(nearly, NOW)).toEqual({ usable: true });
  });

  it('checks consumption before expiry, so a used code never reads as expired', () => {
    const usedAndExpired = {
      expiresAt: new Date(NOW.getTime() - 60_000),
      attempts: 0,
      consumedAt: new Date(NOW.getTime() - 30_000),
    };
    expect(checkCodeUsable(usedAndExpired, NOW)).toEqual({
      usable: false,
      failure: 'ALREADY_USED',
    });
  });
});

describe('the attempt ceiling makes online guessing hopeless', () => {
  it('allows a handful of tries against a million possibilities', () => {
    const keyspace = 10 ** 6;
    const chance = MAX_VERIFY_ATTEMPTS / keyspace;
    expect(chance).toBeLessThan(0.0001);
  });
});

describe('failure messages do not leak', () => {
  it('reads identically whether a code exists or is simply wrong', () => {
    // Otherwise the form becomes an oracle for "does this number have a code
    // outstanding", which is a step towards enumerating customers.
    expect(VERIFY_FAILURE_MESSAGES.NO_CODE).toBe(VERIFY_FAILURE_MESSAGES.WRONG_CODE);
  });

  it('is explicit about the cases that are the person’s own problem', () => {
    expect(VERIFY_FAILURE_MESSAGES.EXPIRED).not.toBe(VERIFY_FAILURE_MESSAGES.WRONG_CODE);
    expect(VERIFY_FAILURE_MESSAGES.TOO_MANY_ATTEMPTS).not.toBe(VERIFY_FAILURE_MESSAGES.WRONG_CODE);
  });

  it('always tells the person what to do next', () => {
    for (const message of Object.values(VERIFY_FAILURE_MESSAGES)) {
      expect(message.length).toBeGreaterThan(10);
      expect(message).toMatch(/code/i);
    }
  });
});
