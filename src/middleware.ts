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
const PUBLIC_SUBTREES: readonly string[] = ['/services', '/stores', '/_next'];

/** Whether a path is reachable without a session cookie. */
export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.includes(pathname)) return true;
  return PUBLIC_SUBTREES.some(
    (root) => pathname === root || pathname.startsWith(`${root}/`),
  );
}

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  if (request.cookies.has(SESSION_COOKIE)) {
    return NextResponse.next();
  }

  const login = new URL('/login', request.url);
  // Carry the destination so a deep link survives the detour. The login page
  // validates it as a same-site path before using it.
  login.searchParams.set('next', pathname + search);
  return NextResponse.redirect(login);
}

export const config = {
  // Everything except static assets and the Next.js internals.
  matcher: ['/((?!_next/static|_next/image|.*\\.(?:svg|png|jpg|jpeg|webp|ico)$).*)'],
};
