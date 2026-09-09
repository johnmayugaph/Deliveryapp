import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OrderStatus } from '@prisma/client';
import {
  REPORT_WINDOW_DAYS,
  SETTLED_STATUSES,
  absorbedCountsFor,
  cappedNote,
  reportWindowStart,
  windowNote,
} from '@/lib/merchant/reporting';
import { DEFAULT_WINDOW_DAYS } from '@/lib/merchant/tier-customers';

/**
 * What the shop's reporting screens count, and over how long.
 *
 * Every test here exists because two screens reported on the same orders and
 * disagreed silently — over the period they covered, and over whether a
 * cancelled order counts as money TARA spent.
 */

const ALL_STATUSES = Object.values(OrderStatus);
const read = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8');
const codeOnly = (file: string) =>
  read(file).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

describe('which orders TARA absorbed anything on', () => {
  it('is COMPLETED, and nothing else in the whole enum', () => {
    /**
     * Walked over every status rather than spot-checked, so a new terminal
     * status — a partial completion, a return — fails this test instead of
     * quietly being counted or quietly not being.
     */
    const counted = ALL_STATUSES.filter((status) => absorbedCountsFor(status));
    expect(counted).toEqual([OrderStatus.COMPLETED]);
    expect(ALL_STATUSES.length).toBeGreaterThan(20);
  });

  it('never counts a cancellation', () => {
    // The bug: each of these had its discount added to "what TARA covered",
    // and its own row said so, on an order refunded in full to source.
    for (const status of ALL_STATUSES.filter((s) => s.startsWith('CANCELLED'))) {
      expect(absorbedCountsFor(status), status).toBe(false);
    }
    expect(absorbedCountsFor(OrderStatus.FAILED_DELIVERY)).toBe(false);
    // Delivered is not completed: the money is settled at completion.
    expect(absorbedCountsFor(OrderStatus.DELIVERED)).toBe(false);
  });

  it('agrees with the one place settlement actually accrues', () => {
    /**
     * The claim underneath the predicate. If accrual ever moved, or gained a
     * second call site on another status, this list would be a guess.
     */
    const callers = ['src/lib/orders/maintenance.ts'];
    const accrualCalls = callers.flatMap((file) =>
      codeOnly(file)
        .split('\n')
        .filter((line) => /accrueOrderSettlement\(/.test(line)),
    );
    expect(accrualCalls).toHaveLength(1);
    // And nothing outside that file calls it.
    const others = ['src/lib/actions/merchant-actions.ts', 'src/lib/merchant/queue.ts'];
    for (const file of others) {
      expect(codeOnly(file), file).not.toMatch(/accrueOrderSettlement/);
    }
  });

  it('uses one list for the query and the per-row decision', () => {
    // Two ways of saying "settled" is two things that can disagree about a row.
    expect(SETTLED_STATUSES).toEqual([OrderStatus.COMPLETED]);
    const loader = codeOnly('src/lib/merchant/queue.ts');
    expect(loader).toMatch(/status: \{ in: \[\.\.\.SETTLED_STATUSES\] \}/);
    const page = codeOnly('src/app/merchant/[storeId]/history/page.tsx');
    expect(page).toMatch(/absorbedCountsFor\(entry\.order\.status\)/);
  });
});

describe('the window both screens report over', () => {
  it('is one constant, not a number written down twice', () => {
    /**
     * Regulars aggregated ninety days; History took the most recent fifty
     * orders with no date bound at all. Both then reported "what TARA
     * absorbed", and a shop comparing the two figures had no way to know they
     * answered different questions.
     */
    expect(DEFAULT_WINDOW_DAYS).toBe(REPORT_WINDOW_DAYS);
    const tiers = codeOnly('src/lib/merchant/tier-customers.ts');
    expect(tiers).toMatch(/REPORT_WINDOW_DAYS/);
    // No literal 90 left behind to drift from it.
    expect(tiers).not.toMatch(/=\s*90\b/);
  });

  it('bounds the history query by date, which it did not before', () => {
    const loader = codeOnly('src/lib/merchant/queue.ts');
    expect(loader).toMatch(/createdAt: \{ gte: since \}/);
    expect(loader).toMatch(/reportWindowStart\(/);
  });

  it('starts the window the same number of days back for everyone', () => {
    const now = new Date('2026-09-09T12:00:00Z');
    const start = reportWindowStart(now);
    const days = (now.getTime() - start.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBe(REPORT_WINDOW_DAYS);
    expect(reportWindowStart(now, 7).toISOString()).toBe('2026-09-02T12:00:00.000Z');
  });

  it('says the period in words a shop would use', () => {
    expect(windowNote(90)).toBe('the last 90 days');
    expect(windowNote(7)).toBe('the last week');
    expect(windowNote(14)).toBe('the last 2 weeks');
    expect(windowNote(1)).toBe('the last day');
    // 60+ stays in days: "the last 13 weeks" is a number nobody thinks in.
    expect(windowNote(63)).toBe('the last 63 days');
  });
});

describe('saying how much of the window is on screen', () => {
  it('says nothing when everything in the window is shown', () => {
    expect(cappedNote(12, 12)).toBeNull();
    expect(cappedNote(50, 3)).toBeNull();
    expect(cappedNote(0, 0)).toBeNull();
  });

  it('says so when the cap bites, with both numbers', () => {
    // A list that silently stops at fifty rows is a list whose totals mean
    // something different from what they look like they mean.
    expect(cappedNote(50, 214)).toBe('Showing the most recent 50 of 214');
  });
});

describe('the total is over the window, not over the visible rows', () => {
  const loader = codeOnly('src/lib/merchant/queue.ts');

  it('comes from its own aggregate rather than a sum of the rows', () => {
    /**
     * It was summed from the rendered rows, under a comment saying that made
     * it "the sum of exactly the rows above it". True, and the problem: the
     * rows are capped, so the figure moved whenever the cap did and could
     * never agree with a ninety-day aggregate on another tab.
     */
    expect(loader).toMatch(/absorbedCentavos: absorbedPerOrder\.reduce/);
    const page = codeOnly('src/app/merchant/[storeId]/history/page.tsx');
    expect(page).toMatch(/absorbedCentavos=\{history\.absorbedCentavos\}/);
    expect(page).not.toMatch(/rows\.reduce/);
  });

  it('uses the same definition of absorbed that settlement was charged', () => {
    // Not a fifth copy of the four-column sum: `platformAbsorbedCentavos` is
    // what `accrueOrderSettlement` itself records.
    expect(loader).toMatch(/platformAbsorbedCentavos/);
    expect(loader).not.toMatch(/promoDiscountCentavos \+/);
  });

  it('names the period in the sentence under the list', () => {
    const note = codeOnly('src/components/merchant/OrderBenefitNote.tsx');
    expect(note).toMatch(/Over \{windowNote\}/);
    // The old wording sounded like the rows on screen.
    expect(note).not.toMatch(/Across \{orderCount/);
  });

  it('shows no per-order note on an order nobody absorbed anything for', () => {
    const note = codeOnly('src/components/merchant/OrderBenefitNote.tsx');
    expect(note).toMatch(/view\.absorbedCentavos === 0 \|\| !wasSettled/);
  });
});
