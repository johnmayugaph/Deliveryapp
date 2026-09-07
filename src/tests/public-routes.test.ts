import { readFileSync } from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { isPublicPath, middleware } from '@/middleware';

/**
 * What a stranger can reach.
 *
 * The storefront is public and everything about a person is not, and the line
 * between those two is one array in `src/middleware.ts`. A wrong entry does not
 * fail loudly: it serves the admin console to the internet, or it bounces
 * paying customers to a login form. So both directions are asserted here, and
 * the exact-versus-prefix distinction is asserted hardest, because `'/'` in the
 * prefix list matches every path in the application.
 */

const SESSION_COOKIE = 'tara_session';

function requestFor(pathname: string, options?: { signedIn?: boolean }): NextRequest {
  const request = new NextRequest(new URL(`http://localhost:3000${pathname}`));
  if (options?.signedIn) {
    request.cookies.set(SESSION_COOKIE, 'a-token-this-middleware-cannot-validate');
  }
  return request;
}

/** Where the middleware sends a signed-out visitor, or null if it lets them by. */
function redirectFor(pathname: string): string | null {
  const response = middleware(requestFor(pathname));
  const location = response.headers.get('location');
  return location === null ? null : new URL(location).pathname + new URL(location).search;
}

describe('the public storefront', () => {
  it('lets a stranger in the front door', () => {
    expect(isPublicPath('/')).toBe(true);
    expect(redirectFor('/')).toBeNull();
  });

  it('lets a stranger browse a service, a store and the search box', () => {
    for (const pathname of [
      '/services/food',
      '/stores/aling-nena-carinderia',
      '/search',
    ]) {
      expect(redirectFor(pathname), pathname).toBeNull();
    }
  });

  it('lets a stranger read the FAQ', () => {
    // Somebody with a question should not have to sign up to read the answer.
    expect(redirectFor('/help')).toBeNull();
  });

  it('lets a stranger sign in, or recover an account they cannot sign into', () => {
    expect(redirectFor('/login')).toBeNull();
    expect(redirectFor('/recover')).toBeNull();
  });

  it('answers the container healthcheck without a session', () => {
    // Behind the wall it would 307 to /login, which some probes read as
    // healthy and others as unhealthy, and neither is true.
    expect(redirectFor('/api/health')).toBeNull();
  });

  it('serves the service worker on its own terms', () => {
    // A redirect to /login delivered as a service worker is a registration
    // failure with a confusing cause.
    expect(redirectFor('/sw.js')).toBeNull();
  });
});

describe('what still needs an account', () => {
  const PRIVATE = [
    '/orders',
    '/orders/abc123',
    '/credits',
    '/profile',
    '/notifications',
    '/addresses',
    '/checkout',
    '/plus',
    '/welcome',
    '/merchant',
    '/merchant/store_1/menu',
    '/fleet',
    '/fleet/job',
    '/admin',
    '/admin/users',
    '/admin/services',
  ];

  it('bounces a signed-out visitor from every one of them', () => {
    for (const pathname of PRIVATE) {
      expect(isPublicPath(pathname), pathname).toBe(false);
      expect(redirectFor(pathname), pathname).not.toBeNull();
    }
  });

  it('carries the destination through the detour', () => {
    // A deep link into an order should survive signing in.
    expect(redirectFor('/orders/abc123')).toBe('/login?next=%2Forders%2Fabc123');
  });

  it('lets a cookie-holder through, without trusting the cookie', () => {
    // Middleware runs on the edge, where Prisma is unavailable: it can see
    // that a cookie exists and nothing else. The token above is nonsense and
    // still passes here, then resolves to no user server-side.
    const response = middleware(requestFor('/orders', { signedIn: true }));
    expect(response.headers.get('location')).toBeNull();
  });
});

describe('the exact-versus-boundary split', () => {
  /**
   * The mistake this exists for: `'/'` in a list matched with `startsWith`,
   * which makes the entire application public because `'/admin'.startsWith('/')`
   * is true. It reads as a tidy-up and it passes every test above.
   *
   * Boundary matching removes the trap rather than merely watching for it — a
   * subtree now has to be followed by `/` or nothing — so the source check
   * below is belt and braces, keeping the root where it belongs in case the
   * matching is ever loosened again.
   */
  it('does not treat the root as a prefix', () => {
    expect(isPublicPath('/admin')).toBe(false);
    expect(isPublicPath('/orders')).toBe(false);
    expect(isPublicPath('/anything-at-all')).toBe(false);
  });

  it('keeps the root out of the subtree list', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'src/middleware.ts'),
      'utf8',
    );
    const subtrees = source.slice(
      source.indexOf('const PUBLIC_SUBTREES'),
      source.indexOf('export function isPublicPath'),
    );
    expect(subtrees).not.toMatch(/'\/'/);
  });

  it('matches subtrees on a path boundary, not on characters', () => {
    // The trap: `/help` in a list making a future `/helpdesk` public, or
    // `/stores` making `/stores-admin` public. Invisible in review and
    // permanent in production.
    expect(isPublicPath('/services/food')).toBe(true);
    expect(isPublicPath('/services')).toBe(true);
    expect(isPublicPath('/servicesomething')).toBe(false);
    expect(isPublicPath('/stores-admin')).toBe(false);
    expect(isPublicPath('/helpdesk')).toBe(false);
    expect(isPublicPath('/logins')).toBe(false);
    expect(isPublicPath('/searching')).toBe(false);
  });
});
