import type {
  CaptchaChallenge,
  CaptchaVerdict,
  CaptchaVerifier,
} from '@/lib/auth/captcha/types';

/**
 * Cloudflare Turnstile.
 *
 * Chosen over reCAPTCHA and hCaptcha on three grounds that matter for this
 * product specifically:
 *
 *  - **Free at any volume**, with no request ceiling to plan around. The whole
 *    point of this feature is to stop an attacker spending our money; paying
 *    per check to save per SMS would be a strange trade.
 *  - **No puzzle for almost anybody.** The managed widget resolves silently
 *    for a normal browser. This app targets low-end Android phones on patchy
 *    mobile data, where "click the six squares containing a bus" on a 5-inch
 *    screen over a slow connection is a real reason to give up on ordering.
 *  - **It does not build an advertising profile** of the person signing in,
 *    which is worth something on its own and worth more under the Data Privacy
 *    Act.
 *
 * Verified how far it can be. `src/tests/captcha-wire.test.ts` runs this
 * adapter against a real HTTP server on a loopback socket and asserts the exact
 * bytes Cloudflare receives — method, content type, field names, the secret,
 * the token, the client address — and every response shape it can answer with.
 * What that cannot establish is Cloudflare's own behaviour: whether a key pair
 * is live, whether the widget renders on a real handset, what a genuine token
 * looks like. No token has ever been checked against the real endpoint from
 * here, because this environment has no route to it.
 */
export class TurnstileVerifier implements CaptchaVerifier {
  readonly name = 'turnstile';

  constructor(
    private readonly secretKey: string,
    /** Public so callers and tests can report where checks actually go. */
    readonly endpoint = 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async verify(challenge: CaptchaChallenge): Promise<CaptchaVerdict> {
    const body = new URLSearchParams({
      secret: this.secretKey,
      response: challenge.token,
    });
    if (challenge.clientIp) {
      // Optional, and a signal rather than a check: Cloudflare compares it
      // against where the token was minted.
      body.set('remoteip', challenge.clientIp);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        // Shorter than the SMS timeout on purpose: this runs BEFORE the
        // gateway call, so its budget is time a person is already waiting.
        signal: AbortSignal.timeout(5_000),
      });
    } catch (error) {
      return {
        outcome: 'UNAVAILABLE',
        provider: this.name,
        reason: error instanceof Error ? error.message : 'request failed',
      };
    }

    if (!response.ok) {
      // A 5xx is their outage; a 4xx here means we sent something malformed,
      // which is our bug and equally not the person's fault. Neither is
      // evidence about the token, so neither rejects it.
      return {
        outcome: 'UNAVAILABLE',
        provider: this.name,
        reason: `HTTP ${response.status}`,
      };
    }

    let payload: { success?: unknown; 'error-codes'?: unknown };
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      return {
        outcome: 'UNAVAILABLE',
        provider: this.name,
        reason: 'unparseable response',
      };
    }

    if (payload.success === true) {
      return { outcome: 'PASSED', provider: this.name };
    }

    const codes = Array.isArray(payload['error-codes'])
      ? payload['error-codes'].filter((code): code is string => typeof code === 'string')
      : [];

    /**
     * Two of Cloudflare's error codes are about US, not the visitor.
     *
     * A missing or invalid SECRET means this deployment is misconfigured, and
     * an outdated-widget error means the pair does not match. Rejecting every
     * login on the strength of our own mistake is the same total outage that
     * `UNAVAILABLE` exists to avoid, and it would be loud in the log and
     * invisible on the screen — the worst combination. So they are reported as
     * unavailable, which lets people in and leaves the evidence.
     */
    const ourFault = codes.some(
      (code) => code === 'missing-input-secret' || code === 'invalid-input-secret',
    );
    if (ourFault) {
      return {
        outcome: 'UNAVAILABLE',
        provider: this.name,
        reason: `configuration rejected: ${codes.join(', ')}`,
      };
    }

    return { outcome: 'REJECTED', provider: this.name, codes };
  }
}
