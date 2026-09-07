/**
 * Proving that a login request came from a person.
 *
 * An interface rather than a direct provider call, for the same reason the SMS
 * gateway is one: this is the piece most likely to be swapped. Turnstile is
 * free today and might not be; hCaptcha and reCAPTCHA have the same shape;
 * and a self-hosted proof-of-work challenge would slot in here too.
 *
 * What this protects is MONEY, not access. The security boundary on an account
 * is the six-digit code sent to a phone somebody holds — a CAPTCHA does not
 * strengthen that by a single bit. What it stops is somebody spending a peso of
 * ours per request, a few thousand times, from a script. Keeping that
 * distinction straight is what decides how the failures below are handled.
 */

export interface CaptchaChallenge {
  /** The token the widget produced. */
  token: string;
  /** The requester's address, when we have it. Providers use it as a signal. */
  clientIp?: string | undefined;
}

export type CaptchaVerdict =
  /** A real token, checked and accepted. */
  | { outcome: 'PASSED'; provider: string }
  /**
   * Checked and rejected: expired, replayed, forged, or for another site.
   * The provider's own codes are kept for the log, never shown to the person.
   */
  | { outcome: 'REJECTED'; provider: string; codes: readonly string[] }
  /**
   * The verifier could not be reached, or did not answer in time.
   *
   * DELIBERATELY DISTINCT from rejection, because the two deserve opposite
   * answers. A rejected token is evidence; an unreachable verifier is evidence
   * of nothing except somebody else's outage, and treating it as a rejection
   * means a Cloudflare incident stops every customer in the country from
   * ordering dinner. See `verifyLoginChallenge`.
   */
  | { outcome: 'UNAVAILABLE'; provider: string; reason: string };

export interface CaptchaVerifier {
  readonly name: string;
  verify(challenge: CaptchaChallenge): Promise<CaptchaVerdict>;
}
