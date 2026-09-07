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

/** Reachable without signing in. */
const PUBLIC_PREFIXES = ['/login', '/icon.svg', '/_next', '/favicon.ico'];

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
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
