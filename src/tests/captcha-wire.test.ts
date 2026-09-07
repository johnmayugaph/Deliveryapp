import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CAPTCHA_MISSING_MESSAGE,
  CAPTCHA_REJECTED_MESSAGE,
  TurnstileVerifier,
  captchaIsHalfConfigured,
  isCaptchaConfigured,
  resolveCaptchaVerifier,
  verifyLoginChallenge,
  type CaptchaEnv,
  type CaptchaVerdict,
  type CaptchaVerifier,
} from '@/lib/auth/captcha';

/**
 * The CAPTCHA on the login screen.
 *
 * Two halves, and the second is the one with the judgement in it.
 *
 * The wire tests run the Turnstile adapter against a real HTTP server on a
 * loopback socket and assert the bytes Cloudflare would receive, and every
 * response shape it can answer with. This environment's network policy has no
 * route to `challenges.cloudflare.com`, so a real token has never been checked
 * from here — what a live key pair does is still unverified, and the docstring
 * on the adapter says so.
 *
 * The policy tests are about what a failure MEANS. A rejected token refuses the
 * login; an unreachable verifier allows it. That asymmetry is the whole design
 * and it is the thing most likely to be "tidied" into consistency by somebody
 * who reads this as a security control rather than a cost control.
 */

interface Capture {
  method: string;
  contentType: string | undefined;
  raw: string;
}

let server: Server | undefined;

afterEach(async () => {
  if (!server) return;
  const closing = server;
  server = undefined;
  await new Promise<void>((resolve) => closing.close(() => resolve()));
});

/** A loopback stand-in for siteverify that records one request. */
async function siteverify(
  reply: (res: ServerResponse) => void,
): Promise<{ endpoint: string; captured: () => Capture | undefined }> {
  let capture: Capture | undefined;

  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      capture = {
        method: req.method ?? '',
        contentType: req.headers['content-type'],
        raw: Buffer.concat(chunks).toString('utf8'),
      };
      reply(res);
    });
  });

  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server!.address();
  if (address === null || typeof address === 'string') {
    throw new Error('no port');
  }
  return {
    endpoint: `http://127.0.0.1:${address.port}/turnstile/v0/siteverify`,
    captured: () => capture,
  };
}

function json(body: unknown, status = 200) {
  return (res: ServerResponse) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
}

// -----------------------------------------------------------------------------
// What Cloudflare receives
// -----------------------------------------------------------------------------

describe('the bytes on the wire', () => {
  it('posts the secret and the token as a form body', async () => {
    const { endpoint, captured } = await siteverify(json({ success: true }));
    const verifier = new TurnstileVerifier('sk-test-secret', endpoint);

    const verdict = await verifier.verify({ token: 'tok-abc.123' });

    expect(verdict).toEqual({ outcome: 'PASSED', provider: 'turnstile' });
    expect(captured()?.method).toBe('POST');
    expect(captured()?.contentType).toBe('application/x-www-form-urlencoded');
    expect(captured()?.raw).toContain('secret=sk-test-secret');
    expect(captured()?.raw).toContain('response=tok-abc.123');
  });

  it('sends the client address when there is one, and omits it otherwise', async () => {
    const withIp = await siteverify(json({ success: true }));
    await new TurnstileVerifier('sk', withIp.endpoint).verify({
      token: 'tok',
      clientIp: '112.198.0.1',
    });
    expect(withIp.captured()?.raw).toContain('remoteip=112.198.0.1');

    server?.close();
    const without = await siteverify(json({ success: true }));
    await new TurnstileVerifier('sk', without.endpoint).verify({ token: 'tok' });
    expect(without.captured()?.raw).not.toContain('remoteip');
  });

  it('percent-encodes a token containing form-hostile characters', async () => {
    // Turnstile tokens carry dots and can carry `+` and `/`. A `+` in a form
    // body means a space, so an unencoded one would be a different token —
    // the same class of bug the SMS adapter's `+63` encoding test exists for.
    const { endpoint, captured } = await siteverify(json({ success: true }));
    await new TurnstileVerifier('sk', endpoint).verify({ token: 'a+b/c=d.e' });

    expect(captured()?.raw).toContain('response=a%2Bb%2Fc%3Dd.e');
    expect(captured()?.raw).not.toContain('response=a+b/c=d.e');
  });

  it('never puts the secret in a URL', async () => {
    // A query string is logged by every proxy in between.
    const { endpoint, captured } = await siteverify(json({ success: true }));
    await new TurnstileVerifier('sk-in-body-only', endpoint).verify({ token: 't' });
    expect(captured()?.raw).toContain('sk-in-body-only');
  });
});

// -----------------------------------------------------------------------------
// Every answer siteverify can give
// -----------------------------------------------------------------------------

describe('reading the verdict', () => {
  it('accepts a successful check', async () => {
    const { endpoint } = await siteverify(json({ success: true }));
    const verdict = await new TurnstileVerifier('sk', endpoint).verify({ token: 't' });
    expect(verdict.outcome).toBe('PASSED');
  });

  it('rejects an expired or replayed token, keeping the codes', async () => {
    const { endpoint } = await siteverify(
      json({ success: false, 'error-codes': ['timeout-or-duplicate'] }),
    );
    const verdict = await new TurnstileVerifier('sk', endpoint).verify({ token: 't' });
    expect(verdict).toEqual({
      outcome: 'REJECTED',
      provider: 'turnstile',
      codes: ['timeout-or-duplicate'],
    });
  });

  it('rejects a forged token', async () => {
    const { endpoint } = await siteverify(
      json({ success: false, 'error-codes': ['invalid-input-response'] }),
    );
    const verdict = await new TurnstileVerifier('sk', endpoint).verify({ token: 't' });
    expect(verdict.outcome).toBe('REJECTED');
  });

  it('treats OUR bad secret as unavailable, not as a rejection', async () => {
    // The distinction that keeps a misconfigured deployment from refusing
    // every customer: an invalid secret is our mistake, and the person
    // signing in cannot do anything about it.
    for (const code of ['missing-input-secret', 'invalid-input-secret']) {
      server?.close();
      const { endpoint } = await siteverify(
        json({ success: false, 'error-codes': [code] }),
      );
      const verdict = await new TurnstileVerifier('sk', endpoint).verify({ token: 't' });
      expect(verdict.outcome, code).toBe('UNAVAILABLE');
    }
  });

  it('treats a 5xx as unavailable', async () => {
    const { endpoint } = await siteverify(json({ error: 'oops' }, 503));
    const verdict = await new TurnstileVerifier('sk', endpoint).verify({ token: 't' });
    expect(verdict).toMatchObject({ outcome: 'UNAVAILABLE', reason: 'HTTP 503' });
  });

  it('treats an unparseable body as unavailable', async () => {
    const { endpoint } = await siteverify((res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('<html>who knows</html>');
    });
    const verdict = await new TurnstileVerifier('sk', endpoint).verify({ token: 't' });
    expect(verdict.outcome).toBe('UNAVAILABLE');
  });

  it('treats a dead socket as unavailable rather than throwing', async () => {
    // Port 1 on loopback: nothing listens, and a login must not 500 over it.
    const verifier = new TurnstileVerifier('sk', 'http://127.0.0.1:1/siteverify');
    const verdict = await verifier.verify({ token: 't' });
    expect(verdict.outcome).toBe('UNAVAILABLE');
  });

  it('does not hang a login on a slow verifier', async () => {
    // The adapter's own timeout, asserted through the option it passes rather
    // than by waiting five seconds in a test suite.
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const verifier = new TurnstileVerifier(
      'sk',
      'https://example.invalid/siteverify',
      fetchImpl as unknown as typeof fetch,
    );
    await verifier.verify({ token: 't' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

// -----------------------------------------------------------------------------
// Which deployments have a CAPTCHA at all
// -----------------------------------------------------------------------------

const BOTH: CaptchaEnv = {
  TURNSTILE_SECRET_KEY: 'sk',
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: 'pk',
};

describe('when a CAPTCHA is switched on', () => {
  it('needs both halves of the pair', () => {
    expect(isCaptchaConfigured(BOTH)).toBe(true);
    expect(isCaptchaConfigured({})).toBe(false);
    expect(isCaptchaConfigured({ TURNSTILE_SECRET_KEY: 'sk' })).toBe(false);
    expect(isCaptchaConfigured({ NEXT_PUBLIC_TURNSTILE_SITE_KEY: 'pk' })).toBe(false);
  });

  it('reports half a pair as the misconfiguration it is', () => {
    expect(captchaIsHalfConfigured({ TURNSTILE_SECRET_KEY: 'sk' })).toBe(true);
    expect(captchaIsHalfConfigured({ NEXT_PUBLIC_TURNSTILE_SITE_KEY: 'pk' })).toBe(true);
    expect(captchaIsHalfConfigured(BOTH)).toBe(false);
    expect(captchaIsHalfConfigured({})).toBe(false);
  });

  it('treats half a pair as OFF rather than as a lockout', () => {
    // A secret with no site key renders no widget, so nobody can produce a
    // token. Reading that as "configured" would refuse every login in the
    // country; reading it as "off" leaves the rate limits exactly as they
    // were yesterday. Only one of those is recoverable by a customer.
    expect(resolveCaptchaVerifier({ TURNSTILE_SECRET_KEY: 'sk' })).toBeNull();
  });

  it('honours an endpoint override outside production only', () => {
    const staging = resolveCaptchaVerifier({
      ...BOTH,
      TURNSTILE_ENDPOINT: 'http://127.0.0.1:9/siteverify',
      NODE_ENV: 'development',
    });
    expect((staging as TurnstileVerifier).endpoint).toBe('http://127.0.0.1:9/siteverify');

    // In production it is ignored: a variable that can redirect the check is a
    // way to make every check pass.
    const live = resolveCaptchaVerifier({
      ...BOTH,
      TURNSTILE_ENDPOINT: 'http://127.0.0.1:9/siteverify',
      NODE_ENV: 'production',
    });
    expect((live as TurnstileVerifier).endpoint).toBe(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    );
  });
});

// -----------------------------------------------------------------------------
// What a failure means
// -----------------------------------------------------------------------------

function verifierReturning(verdict: CaptchaVerdict): CaptchaVerifier {
  return { name: 'stub', verify: async () => verdict };
}

describe('the gate in front of sending a code', () => {
  it('lets everything through when no CAPTCHA is configured', async () => {
    const decision = await verifyLoginChallenge({ token: undefined, verifier: null });
    expect(decision).toEqual({ allowed: true, reason: 'NOT_CONFIGURED' });
  });

  it('lets a good token through', async () => {
    const decision = await verifyLoginChallenge({
      token: 'tok',
      verifier: verifierReturning({ outcome: 'PASSED', provider: 'stub' }),
    });
    expect(decision).toEqual({ allowed: true, reason: 'PASSED' });
  });

  it('refuses a missing token when a CAPTCHA IS configured', async () => {
    const decision = await verifyLoginChallenge({
      token: undefined,
      verifier: verifierReturning({ outcome: 'PASSED', provider: 'stub' }),
    });
    expect(decision).toEqual({ allowed: false, message: CAPTCHA_MISSING_MESSAGE });
  });

  it('refuses whitespace dressed up as a token', async () => {
    const decision = await verifyLoginChallenge({
      token: '   ',
      verifier: verifierReturning({ outcome: 'PASSED', provider: 'stub' }),
    });
    expect(decision.allowed).toBe(false);
  });

  it('refuses a rejected token', async () => {
    const decision = await verifyLoginChallenge({
      token: 'tok',
      verifier: verifierReturning({
        outcome: 'REJECTED',
        provider: 'stub',
        codes: ['invalid-input-response'],
      }),
    });
    expect(decision).toEqual({ allowed: false, message: CAPTCHA_REJECTED_MESSAGE });
  });

  /**
   * The asymmetry, stated as a test so that "tidying" it is a failing build.
   *
   * Failing closed on an outage at Cloudflare would stop every customer in the
   * country ordering dinner, every rider earning and every store selling — to
   * prevent an attacker from spending SMS credit that three independent rate
   * limits still cap. The CAPTCHA is a cost control. Nobody reaches an account
   * without the code sent to the phone.
   */
  it('lets requests through when the verifier cannot be reached', async () => {
    const decision = await verifyLoginChallenge({
      token: 'tok',
      verifier: verifierReturning({
        outcome: 'UNAVAILABLE',
        provider: 'stub',
        reason: 'HTTP 503',
      }),
    });
    expect(decision).toEqual({ allowed: true, reason: 'VERIFIER_UNAVAILABLE' });
  });

  it('says so loudly when it does', async () => {
    // A deployment running with its CAPTCHA effectively off must not discover
    // that from an SMS bill.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await verifyLoginChallenge({
      token: 'tok',
      verifier: verifierReturning({
        outcome: 'UNAVAILABLE',
        provider: 'stub',
        reason: 'HTTP 503',
      }),
    });
    expect(logged).toHaveBeenCalledOnce();
    expect(logged.mock.calls[0]?.[0]).toMatch(/unavailable/);
    logged.mockRestore();
  });

  it('tells a refused person what to do, and does not accuse them', async () => {
    // Almost every refusal is a page left open until the token expired.
    for (const message of [CAPTCHA_REJECTED_MESSAGE, CAPTCHA_MISSING_MESSAGE]) {
      expect(message).not.toMatch(/bot|robot|automated|suspicious|blocked/i);
      expect(message).toMatch(/try again|reload|wait/i);
    }
  });
});
