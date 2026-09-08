import { smsSendingIsRefused, type SmsEnv } from '@/lib/auth/sms';

/**
 * Can this deployment sign anybody in at all?
 *
 * Two conditions make the answer no, and both were found by rehearsing a
 * production deployment rather than by reading the code. They share this
 * module because they share the only screen that can report them: if nobody
 * can sign in, nobody can open the console, so `/admin/health` — where every
 * other misconfiguration is reported — is not reachable. The login screen is
 * the last place left.
 *
 * Both are stated as a pure function of the environment and the request
 * headers so they can be tested as a table, and so the screen and the sender
 * cannot disagree about whether sending is possible.
 */

/** A reason nobody can sign in. Ordered worst-first where both apply. */
export type SignInBlocker = 'NO_SMS_GATEWAY' | 'INSECURE_TRANSPORT';

export interface SignInReadinessInput {
  /** `x-forwarded-proto`, or undefined when nothing set it. */
  forwardedProto?: string | undefined;
  /** The `Host` header, which decides whether the browser trusts the origin. */
  host?: string | undefined;
  env?: SmsEnv;
}

/**
 * Is this a host a browser treats as a secure context over plain http?
 *
 * Browsers make an exception for loopback: a `Secure` cookie set over
 * `http://localhost` IS stored. That exception is precisely why the transport
 * blocker below cannot be found by testing locally — the measured behaviour on
 * this codebase was that the same request over `http://localhost` kept the
 * session cookie and over `http://a-real-domain` silently dropped it, leaving
 * the next page anonymous with no error anywhere.
 */
function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, '').toLowerCase();
  return (
    name === 'localhost' ||
    name.endsWith('.localhost') ||
    name === '127.0.0.1' ||
    name === '[::1]' ||
    name === '::1'
  );
}

export function signInBlockers(input: SignInReadinessInput = {}): SignInBlocker[] {
  const env = input.env ?? process.env;
  const blockers: SignInBlocker[] = [];

  // No gateway: `requestLoginCode` refuses before it writes anything, so the
  // person never even gets as far as a code to type.
  if (smsSendingIsRefused(env)) {
    blockers.push('NO_SMS_GATEWAY');
  }

  /**
   * Plain http on a real host: the session cookie carries `Secure` in
   * production, so the browser accepts the redirect and throws the cookie
   * away. The code is sent, the code is correct, the login "succeeds", and the
   * next page is signed out. Nothing throws and nothing is logged.
   *
   * `undefined` proto means nothing told us, and this stays quiet rather than
   * guessing, because a false alarm on a working deployment would teach an
   * operator to ignore this panel. That case is rarer than it looks: the
   * standalone server was measured setting `x-forwarded-proto: http` itself on
   * a direct plain-http connection, so an operator who exposes this app with
   * no proxy at all is told, and one behind a proxy forwarding `https` is
   * not.
   */
  if (
    env.NODE_ENV === 'production' &&
    input.forwardedProto !== undefined &&
    input.forwardedProto.split(',')[0]!.trim().toLowerCase() === 'http' &&
    !isLoopbackHost(input.host)
  ) {
    blockers.push('INSECURE_TRANSPORT');
  }

  return blockers;
}
