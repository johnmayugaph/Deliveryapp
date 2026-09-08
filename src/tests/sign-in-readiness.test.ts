import { describe, expect, it, vi } from 'vitest';
import {
  resolveSmsSender,
  smsSendingIsRefused,
  NoSmsSenderError,
  type SmsEnv,
} from '@/lib/auth/sms';
import { signInBlockers } from '@/lib/deploy/sign-in-readiness';
import { SMS_NOT_CONFIGURED_MESSAGE, THROTTLE_MESSAGES } from '@/lib/auth/otp-policy';

/**
 * Both of these were found by rehearsing a production deployment, not by
 * reading the code. The tests exist so a refactor cannot quietly restore
 * either failure — and, for the transport one, because the failure is
 * unreproducible on localhost by design, so a test is the ONLY place it can
 * be pinned down at all.
 */

const ENVS: readonly SmsEnv[] = [
  {} as SmsEnv,
  { NODE_ENV: 'production' } as SmsEnv,
  { NODE_ENV: 'development' } as SmsEnv,
  { NODE_ENV: 'test' } as SmsEnv,
  { NODE_ENV: 'production', SEMAPHORE_API_KEY: 'k' } as SmsEnv,
  { NODE_ENV: 'development', SEMAPHORE_API_KEY: 'k' } as SmsEnv,
  { SEMAPHORE_API_KEY: 'k' } as SmsEnv,
  { NODE_ENV: 'production', SEMAPHORE_API_KEY: '' } as SmsEnv,
];

describe('smsSendingIsRefused agrees with the sender it describes', () => {
  it.each(ENVS.map((env) => [JSON.stringify(env), env] as const))(
    'matches resolveSmsSender for %s',
    (_label, env) => {
      let threw = false;
      try {
        resolveSmsSender(env);
      } catch (error) {
        expect(error).toBeInstanceOf(NoSmsSenderError);
        threw = true;
      }
      // The screen and the sender must not be able to disagree: a screen that
      // promises a code the sender then refuses is the bug this replaces.
      expect(smsSendingIsRefused(env)).toBe(threw);
    },
  );
});

describe('what stops a deployment signing anybody in', () => {
  const HTTPS = { forwardedProto: 'https', host: 'tara.example.ph' };

  it('finds nothing wrong with a configured deployment behind TLS', () => {
    expect(
      signInBlockers({
        ...HTTPS,
        env: { NODE_ENV: 'production', SEMAPHORE_API_KEY: 'k' } as SmsEnv,
      }),
    ).toEqual([]);
  });

  it('finds nothing wrong with a development deployment', () => {
    // Development uses the console sender and a non-Secure cookie, so plain
    // http on any host is correct there. A panel that fired locally would be
    // ignored by the time it mattered.
    expect(
      signInBlockers({
        forwardedProto: 'http',
        host: 'dev.internal',
        env: { NODE_ENV: 'development' } as SmsEnv,
      }),
    ).toEqual([]);
  });

  it('reports a production deployment with no gateway', () => {
    expect(
      signInBlockers({ ...HTTPS, env: { NODE_ENV: 'production' } as SmsEnv }),
    ).toEqual(['NO_SMS_GATEWAY']);
  });

  it('reports plain http on a real host, where the Secure cookie is dropped', () => {
    expect(
      signInBlockers({
        forwardedProto: 'http',
        host: 'tara.example.ph',
        env: { NODE_ENV: 'production', SEMAPHORE_API_KEY: 'k' } as SmsEnv,
      }),
    ).toEqual(['INSECURE_TRANSPORT']);
  });

  it.each([
    ['localhost:3000'],
    ['localhost'],
    ['127.0.0.1:3000'],
    ['[::1]:3000'],
    ['app.localhost'],
  ])('stays quiet over http on %s, which browsers treat as secure', (host) => {
    // This is the exception that made the real failure undiscoverable: the
    // measured behaviour was that a Secure cookie set over http://localhost
    // IS stored, and the same cookie over http://a-real-domain is silently
    // dropped. Testing on localhost can never see it.
    expect(
      signInBlockers({
        forwardedProto: 'http',
        host,
        env: { NODE_ENV: 'production', SEMAPHORE_API_KEY: 'k' } as SmsEnv,
      }),
    ).toEqual([]);
  });

  it('stays quiet when nothing told it the protocol', () => {
    // No proxy set the header. Guessing would put a red panel on a working
    // deployment, which teaches an operator to ignore the panel.
    expect(
      signInBlockers({
        host: 'tara.example.ph',
        env: { NODE_ENV: 'production', SEMAPHORE_API_KEY: 'k' } as SmsEnv,
      }),
    ).toEqual([]);
  });

  it('reads only the first hop of a chained x-forwarded-proto', () => {
    // Two proxies append: `https,http` means the browser spoke https and an
    // internal hop did not. The browser is the one holding the cookie.
    expect(
      signInBlockers({
        forwardedProto: 'https, http',
        host: 'tara.example.ph',
        env: { NODE_ENV: 'production', SEMAPHORE_API_KEY: 'k' } as SmsEnv,
      }),
    ).toEqual([]);
    expect(
      signInBlockers({
        forwardedProto: 'http, https',
        host: 'tara.example.ph',
        env: { NODE_ENV: 'production', SEMAPHORE_API_KEY: 'k' } as SmsEnv,
      }),
    ).toEqual(['INSECURE_TRANSPORT']);
  });

  it('reports both at once, gateway first', () => {
    expect(
      signInBlockers({
        forwardedProto: 'http',
        host: 'tara.example.ph',
        env: { NODE_ENV: 'production' } as SmsEnv,
      }),
    ).toEqual(['NO_SMS_GATEWAY', 'INSECURE_TRANSPORT']);
  });
});

describe('the sentence a customer is given', () => {
  it('does not tell them to try again, because trying again cannot work', () => {
    expect(SMS_NOT_CONFIGURED_MESSAGE).not.toMatch(/try again/i);
    for (const message of Object.values(THROTTLE_MESSAGES)) {
      expect(message).not.toBe(SMS_NOT_CONFIGURED_MESSAGE);
    }
  });

  it('names no environment variable', () => {
    // The variable belongs on the login screen's operator panel and in the
    // log, not in a sentence handed to whoever typed a phone number.
    expect(SMS_NOT_CONFIGURED_MESSAGE).not.toMatch(/SEMAPHORE|API_KEY|env/i);
  });
});

describe('requestLoginCode refuses before it writes anything', () => {
  it('issues no verification row when there is no gateway', async () => {
    /**
     * The bug: `resolveSmsSender()` used to be called on the line above the
     * send, AFTER the `PhoneVerification` row was created and OUTSIDE the
     * try/catch, so on a production deployment with no gateway the first
     * request anybody made returned a 500 and left an unconsumed row behind
     * that could start a cooldown against the honest retry.
     *
     * Prisma is mocked so this can assert the ordering rather than the
     * outcome: if the module reaches the database at all, the mock throws and
     * this fails.
     */
    vi.resetModules();
    const reached = vi.fn(() => {
      throw new Error('requestLoginCode touched the database');
    });
    vi.doMock('@/lib/prisma', () => ({
      prisma: {
        phoneVerification: {
          findMany: reached,
          count: reached,
          create: reached,
          update: reached,
          updateMany: reached,
        },
        $transaction: reached,
      },
    }));

    const previous = process.env.NODE_ENV;
    const key = process.env.SEMAPHORE_API_KEY;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.env as any).NODE_ENV = 'production';
    delete process.env.SEMAPHORE_API_KEY;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { requestLoginCode } = await import('@/lib/auth/otp');
      const outcome = await requestLoginCode({ rawPhone: '09171234567' });

      expect(outcome).toEqual({ ok: false, notConfigured: true });
      expect(reached).not.toHaveBeenCalled();
      // The operator-facing sentence has to land somewhere an operator looks.
      expect(errors.mock.calls.flat().join(' ')).toMatch(/SEMAPHORE_API_KEY/);
    } finally {
      errors.mockRestore();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.env as any).NODE_ENV = previous;
      if (key === undefined) delete process.env.SEMAPHORE_API_KEY;
      else process.env.SEMAPHORE_API_KEY = key;
      vi.doUnmock('@/lib/prisma');
      vi.resetModules();
    }
  });
});
