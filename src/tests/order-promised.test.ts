import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  describePromise,
  formatLate,
  lateBySeconds,
  needsDate,
  promiseIsOverdue,
  promiseState,
  sameDay,
} from '@/lib/orders/promised';
import { dayKeyIn, formatTimeIn } from '@/lib/time/manila';

/** Strips comments, so a whole-file regex cannot be satisfied by prose. */
function codeOnly(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const NOW = new Date('2026-09-09T08:40:00.000Z');
const SOON = new Date('2026-09-09T09:10:00.000Z');
const PASSED = new Date('2026-09-09T08:15:00.000Z');

/* The app's real formatter, which pins Manila. Using it here is deliberate:
   the bug this suite caught was a test formatter agreeing with a broken
   screen. */
const time = formatTimeIn;

describe('the promised time', () => {
  it('is nothing to say when the order has no estimate', () => {
    expect(promiseState(null, true, NOW)).toEqual({ kind: 'NONE' });
    expect(describePromise({ kind: 'NONE' }, time)).toBeNull();
  });

  it('is DUE while there is still time', () => {
    expect(promiseState(SOON, true, NOW)).toEqual({ kind: 'DUE', at: SOON });
  });

  it('is OVERDUE once the time has passed, and says how far', () => {
    // The defect: this rendered identically to DUE.
    expect(promiseState(PASSED, true, NOW)).toEqual({
      kind: 'OVERDUE',
      at: PASSED,
      lateSeconds: 25 * 60,
    });
  });

  it('is DONE on a finished order, whatever the estimate said', () => {
    // "25m late" about food already eaten is a complaint, not information.
    expect(promiseState(PASSED, false, NOW)).toEqual({ kind: 'DONE', at: PASSED });
    expect(describePromise({ kind: 'DONE', at: PASSED }, time)).toBeNull();
  });

  it('changes tense with the fact', () => {
    expect(describePromise(promiseState(SOON, true, NOW), time)).toMatch(
      /^Arriving by /,
    );
    expect(describePromise(promiseState(PASSED, true, NOW), time)).toMatch(
      /^Was due at /,
    );
  });

  it('says how late, and does not apologise or promise a new time', () => {
    const text = describePromise(promiseState(PASSED, true, NOW), time)!;
    expect(text).toContain('25m late');
    // Nothing in the app knows why it is late or when it will arrive.
    expect(text).not.toMatch(/sorry|apolog/i);
    expect(text).not.toMatch(/soon|shortly|any minute/i);
  });

  it('marks only OVERDUE as a problem', () => {
    expect(promiseIsOverdue(promiseState(PASSED, true, NOW))).toBe(true);
    expect(promiseIsOverdue(promiseState(SOON, true, NOW))).toBe(false);
    expect(promiseIsOverdue(promiseState(PASSED, false, NOW))).toBe(false);
    expect(promiseIsOverdue({ kind: 'NONE' })).toBe(false);
  });

  it('treats the exact moment as not yet late', () => {
    // `>` not `>=`, so an order due precisely now is not accused.
    expect(promiseState(NOW, true, NOW).kind).toBe('DUE');
  });
});

describe('how late, in words', () => {
  it.each([
    [30, '1m late'],
    [60, '1m late'],
    [25 * 60, '25m late'],
    [59 * 60, '59m late'],
    [60 * 60, '1h 0m late'],
    [65 * 60, '1h 5m late'],
  ])('%i seconds → %s', (seconds, expected) => {
    expect(formatLate(seconds)).toBe(expected);
  });

  it('never reports being late by seconds', () => {
    // A card reading "0m late" is a card that looks broken.
    for (const seconds of [1, 5, 30, 59]) {
      expect(formatLate(seconds)).toBe('1m late');
    }
  });

  it('is null rather than zero when nothing is late', () => {
    expect(lateBySeconds(SOON, NOW)).toBeNull();
    expect(lateBySeconds(NOW, NOW)).toBeNull();
    expect(lateBySeconds(null, NOW)).toBeNull();
  });
});

describe('stamping a timeline', () => {
  const at = (iso: string) => new Date(iso);

  it('shows no date on a list from today', () => {
    // A live order tracked this afternoon is a column of bare times.
    expect(needsDate(at('2026-09-09T07:00:00Z'), null, NOW, dayKeyIn)).toBe(false);
    expect(
      needsDate(
        at('2026-09-09T08:00:00Z'),
        at('2026-09-09T07:00:00Z'),
        NOW,
        dayKeyIn,
      ),
    ).toBe(false);
  });

  it('dates the first entry when the order is not from today', () => {
    // The receipt case: this screen is what a customer opens months later.
    expect(needsDate(at('2026-06-01T07:00:00Z'), null, NOW, dayKeyIn)).toBe(true);
  });

  it('dates exactly the entry that crosses midnight', () => {
    /**
     * An order placed 23:50 and delivered 00:20 rendered as 23:50 → 00:20,
     * which reads as a timeline running backwards. The crossing is the only
     * place the reader needs telling.
     */
    const placed = at('2026-09-08T15:50:00Z'); // 23:50 in Manila
    const delivered = at('2026-09-08T16:20:00Z'); // 00:20 next day
    expect(sameDay(placed, delivered, dayKeyIn)).toBe(false);
    expect(needsDate(delivered, placed, NOW, dayKeyIn)).toBe(true);
  });

  it('does not repeat the date for every entry after a crossing', () => {
    const a = at('2026-06-01T01:00:00Z');
    const b = at('2026-06-01T02:00:00Z');
    expect(needsDate(a, null, NOW, dayKeyIn)).toBe(true);
    expect(needsDate(b, a, NOW, dayKeyIn)).toBe(false);
  });

  it('compares calendar days, not elapsed hours', () => {
    // Twenty-three hours apart and the same day; one hour apart and not.
    // In MANILA: 08:30 and 15:30 the same day; then 16:30 and 17:30, also
    // the same day — so the pair that differs is chosen in Manila terms.
    expect(
      sameDay(at('2026-09-09T00:30:00Z'), at('2026-09-09T15:00:00Z'), dayKeyIn),
    ).toBe(true);
    expect(
      sameDay(at('2026-09-09T15:00:00Z'), at('2026-09-09T16:30:00Z'), dayKeyIn),
    ).toBe(false);
  });
});

describe('the tracking screen is wired to it', () => {
  const page = codeOnly('src/app/orders/[orderId]/page.tsx');

  it('renders the promise through the rule', () => {
    expect(page).toMatch(/promiseState\(order\.etaAt, isLive, renderedAt\)/);
    expect(page).toMatch(/describePromise\(promise,/);
    expect(page).toMatch(/promiseIsOverdue\(promise\)/);
  });

  it('no longer prints a bare estimated-arrival line', () => {
    // The exact string that could not be late.
    expect(page).not.toMatch(/Estimated arrival/);
  });

  it('resolves the clock once for the whole render', () => {
    // Two parts of a page disagreeing about now is a bug nobody reproduces.
    expect(page).toMatch(/const renderedAt = new Date\(\);/);
    expect(page).not.toMatch(/promiseState\([^)]*new Date\(\)\)/);
  });

  it('dates timeline entries through the rule rather than by hand', () => {
    expect(page).toMatch(/needsDate\(/);
    expect(page).toMatch(/showDateFor/);
  });
});

describe('the merchant card keeps working', () => {
  it('reads the helpers from their new home, by re-export', () => {
    /**
     * `lateBySeconds` and `formatLate` were written for the queue card and
     * moved once a customer screen needed them: a customer screen importing
     * a module named for the back office is a dependency that looks fine
     * until somebody puts a Prisma call in it.
     */
    const clock = codeOnly('src/lib/merchant/queue-clock.ts');
    expect(clock).toMatch(
      /export \{ formatLate, lateBySeconds \} from '@\/lib\/orders\/promised'/,
    );
    // And no second copy left behind to drift.
    expect(clock).not.toMatch(/function lateBySeconds/);
    expect(clock).not.toMatch(/function formatLate/);
  });
});

describe('the pure module stays pure', () => {
  it('imports nothing at all', () => {
    const source = readFileSync('src/lib/orders/promised.ts', 'utf8');
    expect(source).not.toMatch(/^import /m);
  });
});
