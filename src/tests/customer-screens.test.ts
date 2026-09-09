import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_SCREENS,
  isPublic,
  loginPathFor,
  pathFor,
  type CustomerScreen,
} from '@/lib/auth/screens';

/**
 * The screen map, and the thing it is for: no private customer screen may
 * render a guess when the session is gone.
 */

/** Strips comments, so a whole-file regex cannot be satisfied by prose. */
function codeOnly(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const SCREENS = Object.keys(CUSTOMER_SCREENS) as CustomerScreen[];

describe('the screen map', () => {
  it('gives every screen a path that starts at the root', () => {
    for (const screen of SCREENS) {
      expect(CUSTOMER_SCREENS[screen].path).toMatch(/^\//);
    }
  });

  it('says what a private screen would otherwise invent, and public ones invent nothing', () => {
    // The reason for the gate, written down beside it. A gate whose reason is
    // not recorded is a gate the next person removes.
    for (const screen of SCREENS) {
      const { needs, wouldInvent } = CUSTOMER_SCREENS[screen];
      if (needs === 'PUBLIC') expect(wouldInvent).toBeNull();
      else expect(wouldInvent).toBeTruthy();
    }
  });

  it('has no duplicate paths', () => {
    const paths = SCREENS.map((s) => CUSTOMER_SCREENS[s].path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe('every customer route is in the map', () => {
  /**
   * The load-bearing test. The map is only worth having if it is COMPLETE:
   * a new private screen that nobody added here would go back to reading a
   * nullable session and rendering a guess, which is exactly how the six
   * defects were written in the first place.
   *
   * So the routes are read off the filesystem and each one must be present.
   */
  function routes(dir: string, prefix = ''): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        // Route groups `(x)` do not appear in the URL; dynamic segments do.
        const segment = entry.startsWith('(') ? '' : `/${entry}`;
        found.push(...routes(full, prefix + segment));
      } else if (entry === 'page.tsx') {
        found.push(prefix === '' ? '/' : prefix);
      }
    }
    return found;
  }

  /** Not customer screens: they have their own access models. */
  const NOT_CUSTOMER = /^\/(merchant|admin|fleet)(\/|$)/;

  const onDisk = routes('src/app')
    .filter((route) => !NOT_CUSTOMER.test(route))
    // `[orderId]` on disk is `:id` in the map.
    .map((route) => route.replace(/\[[^\]]+\]/g, ':id'))
    .sort();

  it('finds the routes at all, so an empty sweep cannot pass', () => {
    // Without this the two expectations below are vacuous.
    expect(onDisk.length).toBeGreaterThanOrEqual(20);
    expect(onDisk).toContain('/credits');
    expect(onDisk).toContain('/orders/:id');
  });

  it('maps every one of them', () => {
    const mapped = new Set(SCREENS.map((s) => CUSTOMER_SCREENS[s].path));
    const missing = onDisk.filter((route) => !mapped.has(route));
    expect(missing).toEqual([]);
  });

  it('maps nothing that is not there', () => {
    const present = new Set(onDisk);
    const stale = SCREENS.map((s) => CUSTOMER_SCREENS[s].path).filter(
      (path) => !present.has(path),
    );
    expect(stale).toEqual([]);
  });
});

describe('no private screen reads a nullable session', () => {
  /**
   * The regression these tests exist for. Six screens read `getCurrentUser()`
   * and then rendered something for the null case: a ₱0.00 balance, "No
   * orders yet", an empty address book, `notFound()` about the customer's own
   * order, and — on the two that threw — the generic error page.
   *
   * A private screen must reach the session through `requireScreen`, which
   * redirects. Checked against the file, because this is a property of how the
   * screen is written and there is no runtime seam to assert it on.
   */
  const PRIVATE = SCREENS.filter((s) => !isPublic(s));

  function sourceFor(screen: CustomerScreen): string {
    const path = CUSTOMER_SCREENS[screen].path;
    const dir = path === '/' ? '' : path.replace(/\/:id/g, '/[id]');
    // The map's `:id` is spelled variously on disk; find the real directory.
    const candidates = [
      `src/app${dir}/page.tsx`,
      `src/app${dir.replace('/[id]', '/[orderId]')}/page.tsx`,
    ];
    for (const candidate of candidates) {
      try {
        return codeOnly(candidate);
      } catch {
        continue;
      }
    }
    throw new Error(`no page found for ${screen} (tried ${candidates.join(', ')})`);
  }

  it('covers more than a handful of screens, so the sweep is not empty', () => {
    expect(PRIVATE.length).toBeGreaterThanOrEqual(14);
  });

  it.each(PRIVATE)('%s goes through requireScreen', (screen) => {
    const source = sourceFor(screen);
    expect(source).toMatch(/requireScreen\(/);
    // And does not also keep the old nullable read around.
    expect(source).not.toMatch(/getCurrentUser\(\)/);
    expect(source).not.toMatch(/requireOnboardedUser\(\)/);
  });

  it('none of them spells its own login redirect any more', () => {
    // Ten call sites, five encoded and five raw. One encoding now.
    for (const screen of PRIVATE) {
      expect(sourceFor(screen)).not.toMatch(/login\?next=/);
    }
  });
});

describe('where sign-in returns to', () => {
  it('encodes the path exactly once', () => {
    expect(loginPathFor('credits')).toBe('/login?next=%2Fcredits');
    expect(loginPathFor('tickets')).toBe('/login?next=%2Fhelp%2Ftickets');
  });

  it('carries the id, so an order opens the order and not the list', () => {
    expect(loginPathFor('orderDetail', 'abc123')).toBe(
      '/login?next=%2Forders%2Fabc123',
    );
  });

  it('refuses a screen that needs an id without one', () => {
    // Better than a redirect to a literal `/orders/:id`, which 404s as a
    // redirect target — the hardest kind of 404 to trace back.
    expect(() => pathFor('orderDetail')).toThrow(/needs an id/);
  });

  it('does not double-encode an id that already looks encoded', () => {
    // One pass in pathFor, one in loginPathFor, and no more.
    expect(pathFor('orderDetail', 'a b')).toBe('/orders/a%20b');
  });
});

describe('the gate refuses to be used the wrong way round', () => {
  const access = codeOnly('src/lib/auth/access.ts');

  it('will not let requireScreen guard a public screen', () => {
    expect(access).toMatch(/needs === 'PUBLIC'/);
    expect(access).toMatch(/must render for a stranger/);
  });

  it('will not let optionalUser be used on a private one', () => {
    expect(access).toMatch(/needs !== 'PUBLIC'/);
    expect(access).toMatch(/use requireScreen instead/);
  });

  it('redirects rather than throwing, which is the whole point', () => {
    expect(access).toMatch(/redirect\(loginPathFor\(screen, id\)\)/);
    expect(access).not.toMatch(/throw new NotAuthenticatedError/);
  });

  it('sends an unfinished account to welcome rather than to login', () => {
    expect(access).toMatch(/needs === 'ONBOARDED' && user\.onboardedAt === null/);
    expect(access).toMatch(/redirect\(pathFor\('welcome'\)\)/);
  });
});

describe('the pure module stays pure', () => {
  it('imports nothing at all', () => {
    // A `'use client'` component may import the rule; importing the session or
    // Prisma turns it into a 500 on first render. This codebase has done that
    // four times.
    const source = readFileSync('src/lib/auth/screens.ts', 'utf8');
    expect(source).not.toMatch(/^import /m);
  });
});
