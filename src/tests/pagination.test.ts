import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CURSOR_PARAM,
  PAGE_SIZE,
  fetchCount,
  newestHref,
  olderHref,
  pageOf,
  readCursor,
  type Page,
} from '@/lib/pagination/pages';

/** Strips comments, so a whole-file regex cannot be satisfied by prose. */
function codeOnly(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const rowsOf = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ id: `r${from + i}` }));

describe('the sentinel row', () => {
  it('fetches one more than the page', () => {
    expect(fetchCount(50)).toBe(51);
    expect(fetchCount()).toBe(PAGE_SIZE + 1);
  });

  it('is dropped, never rendered', () => {
    const page = pageOf(rowsOf(fetchCount(3)), null, 3);
    expect(page.rows).toHaveLength(3);
    expect(page.rows.map((r) => r.id)).toEqual(['r0', 'r1', 'r2']);
  });

  it('is the only thing that decides whether there is more', () => {
    // Exactly a full page and nothing behind it: no "Older" link. This is the
    // case a `rows.length === pageSize` test would get wrong.
    expect(pageOf(rowsOf(3), null, 3).olderCursor).toBeNull();
    expect(pageOf(rowsOf(4), null, 3).olderCursor).toBe('r2');
  });

  it('takes the cursor from the last row SHOWN, not the sentinel', () => {
    // Off by one here silently skips a row at every page boundary.
    const page = pageOf(rowsOf(4), null, 3);
    expect(page.olderCursor).toBe('r2');
    expect(page.olderCursor).not.toBe('r3');
  });
});

describe('walking the whole list', () => {
  /**
   * The property that matters: paging through a list end to end yields every
   * row exactly once. An off-by-one in either direction shows a row twice or
   * loses one, and on a credits ledger a lost row is a customer unable to
   * account for their own balance.
   */
  function walk(total: number, pageSize: number): string[] {
    const all = rowsOf(total);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 100; guard += 1) {
      const start = cursor === null ? 0 : all.findIndex((r) => r.id === cursor) + 1;
      const fetched = all.slice(start, start + fetchCount(pageSize));
      const page: Page<{ id: string }> = pageOf(fetched, cursor, pageSize);
      seen.push(...page.rows.map((r) => r.id));
      if (page.olderCursor === null) return seen;
      cursor = page.olderCursor;
    }
    throw new Error('did not terminate');
  }

  it.each([
    [0, 3],
    [1, 3],
    [2, 3],
    [3, 3],
    [4, 3],
    [6, 3],
    [7, 3],
    [9, 3],
    [50, 50],
    [51, 50],
    [137, 50],
  ])('%i rows in pages of %i: every row once, in order', (total, size) => {
    expect(walk(total, size)).toEqual(rowsOf(total).map((r) => r.id));
  });
});

describe('a cursor that goes nowhere', () => {
  it('is a stranded page, not an empty history', () => {
    // The distinction the six session-gone screens got wrong: a claim about
    // the link, not a claim about the customer.
    expect(pageOf([], 'r99', 3).strandedPage).toBe(true);
  });

  it('is never claimed on the first page', () => {
    // No cursor and no rows means the customer genuinely has nothing.
    expect(pageOf([], null, 3).strandedPage).toBe(false);
  });

  it('is not claimed when the page has rows', () => {
    expect(pageOf(rowsOf(2), 'r5', 3).strandedPage).toBe(false);
  });
});

describe('reading the cursor off the URL', () => {
  it('takes a plausible id', () => {
    expect(readCursor('cmtsu1lcz00297dzb3s2kblc6')).toBe('cmtsu1lcz00297dzb3s2kblc6');
  });

  it('treats absence and blankness as the first page', () => {
    expect(readCursor(undefined)).toBeNull();
    expect(readCursor('')).toBeNull();
    expect(readCursor('   ')).toBeNull();
  });

  it('takes the first of a repeated parameter rather than giving up', () => {
    // Dropping it would send somebody back to the top of a list they were
    // halfway down.
    expect(readCursor(['abc', 'def'])).toBe('abc');
  });

  it('refuses anything that is not id-shaped, so no query sees it', () => {
    for (const bad of [
      "' OR 1=1--",
      '../../etc/passwd',
      'a'.repeat(65),
      'has space',
      'semi;colon',
      '%2e%2e',
    ]) {
      expect(readCursor(bad)).toBeNull();
    }
  });
});

describe('the links', () => {
  it('names the parameter the reader reads', () => {
    expect(olderHref('/orders', 'abc')).toBe(`/orders?${CURSOR_PARAM}=abc`);
    expect(readCursor('abc')).toBe('abc');
  });

  it('encodes the cursor', () => {
    expect(olderHref('/credits', 'a+b')).toBe('/credits?before=a%2Bb');
  });

  it('goes back to the bare path for the newest page', () => {
    // Not `?before=`, which would look like a cursor to a future reader.
    expect(newestHref('/orders')).toBe('/orders');
  });
});

describe('both screens are actually wired to it', () => {
  const orders = codeOnly('src/app/orders/page.tsx');
  const credits = codeOnly('src/app/credits/page.tsx');

  it.each([
    ['orders', orders],
    ['credits', credits],
  ])('%s reads a cursor and fetches the sentinel', (_name, source) => {
    expect(source).toMatch(/readCursor\(/);
    expect(source).toMatch(/fetchCount\(\)/);
    expect(source).toMatch(/pageOf\(fetched, cursor\)/);
    // The bare cap is gone.
    expect(source).not.toMatch(/take: 50/);
    expect(source).not.toMatch(/limit: 50/);
  });

  it.each([
    ['orders', orders],
    ['credits', credits],
  ])('%s renders the pager and the stranded page', (_name, source) => {
    expect(source).toMatch(/<OlderPager/);
    expect(source).toMatch(/<StrandedPage/);
    expect(source).toMatch(/onFirstPage=\{cursor === null\}/);
  });

  it('orders a total order, so a page boundary cannot straddle a tie', () => {
    // Two rows sharing a millisecond would otherwise show one twice and the
    // other never. Credits writes pairs in one transaction routinely.
    expect(orders).toMatch(
      /orderBy: \[\{ createdAt: 'desc' \}, \{ id: 'desc' \}\]/,
    );
    expect(codeOnly('src/lib/wallet/ledger.ts')).toMatch(
      /orderBy: \[\{ createdAt: 'desc' \}, \{ id: 'desc' \}\]/,
    );
  });

  it('shows the rating nudge on the first page only', () => {
    expect(orders).toMatch(/cursor === null \? await unratedOrders/);
  });

  it('keeps the credits balance off the page, since it is the whole ledger', () => {
    // Paging the history must not page the figure it explains.
    expect(credits).toMatch(/getSpendableCentavos\(user\.id\)/);
    expect(credits).not.toMatch(/getSpendableCentavos\([^)]*before/);
  });
});

describe('the pager is honest about the end', () => {
  const pager = codeOnly('src/components/ui/OlderPager.tsx');

  it('says so rather than showing a link that goes nowhere', () => {
    // A last page that happens to be exactly full looks identical to one with
    // more behind it.
    expect(pager).toMatch(/olderCursor === null \?/);
    expect(pager).toMatch(/That&rsquo;s everything/);
  });

  it('renders nothing when there is one page and you are on it', () => {
    expect(pager).toMatch(/if \(olderCursor === null && onFirstPage\) return null/);
  });

  it('is plain links, so it works before hydration and without JavaScript', () => {
    expect(pager).toMatch(/<Link/);
    expect(pager).not.toMatch(/'use client'/);
    expect(pager).not.toMatch(/onClick/);
  });
});

describe('the pure module stays pure', () => {
  it('imports nothing at all', () => {
    const source = readFileSync('src/lib/pagination/pages.ts', 'utf8');
    expect(source).not.toMatch(/^import /m);
  });
});
