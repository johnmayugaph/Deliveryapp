import { NextResponse, type NextRequest } from 'next/server';

/**
 * Route protection, first pass.
 *
 * This checks only whether a session cookie is PRESENT — middleware runs on the
 * edge runtime, where Prisma is unavailable, so it cannot tell a valid session
 * from a forged one. That is fine for what it is for: bouncing obviously
 * signed-out traffic without a database round trip.
 *
 * The real check is server-side, in `getCurrentUser()` / `requireCurrentUser()`,
 * which validate the token hash against the database on every page and action.
 * A hand-written cookie gets past this middleware and then resolves to no user,
 * so nothing here is load-bearing for security.
 */

const SESSION_COOKIE = 'tara_session';

/**
 * Public, by exact path.
 *
 * `/` has to be matched exactly rather than as a prefix, and that distinction
 * is why this list exists separately: `'/'.startsWith` matches every path in
 * the application. A single entry in the wrong list would silently serve the
 * admin console, the merchant back office and every customer's order history
 * to the internet, with no error and nothing to notice.
 *
 * The storefront is public because a delivery app whose front door demands a
 * phone number has already lost the customer, and because the coming-soon
 * tiles are the only demand signal this product collects — measuring only the
 * people who already signed up measures the wrong population.
 *
 * `/sw.js` is here because the service worker script must be fetchable on its
 * own terms. It happens to work for a signed-in visitor, whose cookie rides
 * along — but a redirect to /login served as a service worker is a
 * registration failure with a confusing cause, and the file contains nothing
 * private.
 */
const PUBLIC_PATHS: readonly string[] = [
  '/',
  // The container healthcheck and the load balancer. Behind the login wall it
  // would answer 307 to /login, which reads as healthy to some probes and as
  // unhealthy to others — neither of them true.
  '/api/health',
  '/login',
  // The premise of recovery is that the person cannot sign in.
  '/recover',
  '/search',
  // FAQ articles. Somebody with a question should not have to sign up to read
  // the answer; raising a ticket still needs an account.
  '/help',
  '/sw.js',
  '/icon.svg',
  '/icon-192.png',
  '/badge-72.png',
  '/favicon.ico',
];

/**
 * Public, along with everything beneath them.
 *
 * Matched on a path BOUNDARY — `/services` or `/services/anything`, never
 * `/servicesomething`. A plain `startsWith` would make a future `/helpdesk`
 * public on the strength of `/help` being in a list, which is the kind of
 * mistake that is invisible in review and permanent in production.
 *
 * Nothing under these renders anything about a person: no contact details, no
 * order history, no saved addresses. A stranger browses the tiles, a service's
 * stores and a store's menu, and can fill a cart, which lives in their own
 * browser. Signing in is asked for at the first point it is actually needed —
 * `/checkout`, which redirects there itself — and for anything about a person
 * rather than a product.
 */
const PUBLIC_SUBTREES: readonly string[] = [
  '/services',
  '/stores',
  // Photographs of dishes. On a page a stranger can already open, so putting
  // them behind the wall would render the storefront as a grid of broken
  // images — and each one is a picture of food and nothing else.
  '/menu-images',
  '/_next',
];

/** Whether a path is reachable without a session cookie. */
export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.includes(pathname)) return true;
  return PUBLIC_SUBTREES.some(
    (root) => pathname === root || pathname.startsWith(`${root}/`),
  );
}

/**
 * An invite code has to be captured before there is anybody to attach it to.
 *
 * Somebody opens a shared `?ref=CODE` link with no account. What follows is a
 * login, an SMS round trip and an onboarding form — three navigations that all
 * lose the query string. So the code is parked in a cookie here, in the one
 * place that sees every request, and claimed when the account is onboarded.
 *
 * Only if there is no code already: the first link wins. Otherwise anybody
 * could overwrite a pending attribution by sending a second link, which is
 * whoever-messaged-last rather than whoever-actually-invited-them.
 *
 * Only when signed OUT, too. A code arriving for an account that already
 * exists is either somebody sharing a link with a customer we already have, or
 * a person trying to attribute themselves after the fact — and attribution is
 * for new accounts, so there is nothing to hold.
 *
 * The value is length-capped and stripped to the code alphabet before it is
 * stored. It is echoed back to nothing and read only as a database lookup key,
 * but a cookie written from a query parameter is attacker-controlled by
 * definition and bounding it here costs one line.
 */
const CODE_ALPHABET_PATTERN = /[^ABCDEFGHJKMNPQRTUVWXYZ23456789]/g;
const REFERRAL_COOKIE = 'tara_ref';
const REFERRAL_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

function captureReferralCode(
  request: NextRequest,
  response: NextResponse,
): NextResponse {
  const raw = request.nextUrl.searchParams.get('ref');
  if (!raw) return response;
  if (request.cookies.has(SESSION_COOKIE)) return response;
  if (request.cookies.has(REFERRAL_COOKIE)) return response;

  const code = raw.toUpperCase().slice(0, 32).replace(CODE_ALPHABET_PATTERN, '');
  if (code.length !== 6) return response;

  response.cookies.set({
    name: REFERRAL_COOKIE,
    value: code,
    maxAge: REFERRAL_COOKIE_MAX_AGE_SECONDS,
    path: '/',
    sameSite: 'lax',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
  });
  return response;
}

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (isPublicPath(pathname)) {
    return captureReferralCode(request, NextResponse.next());
  }

  if (request.cookies.has(SESSION_COOKIE)) {
    return NextResponse.next();
  }

  const login = new URL('/login', request.url);
  // Carry the destination so a deep link survives the detour. The login page
  // validates it as a same-site path before using it.
  login.searchParams.set('next', pathname + search);
  // Set on the REDIRECT, not on a response nobody receives: a code arriving on
  // a protected deep link would otherwise be lost at the login bounce, which
  // is the most likely shape of a shared link ("look at this shop").
  return captureReferralCode(request, NextResponse.redirect(login));
}

export const config = {
  // Everything except static assets and the Next.js internals.
  matcher: ['/((?!_next/static|_next/image|.*\\.(?:svg|png|jpg|jpeg|webp|ico)$).*)'],
};
