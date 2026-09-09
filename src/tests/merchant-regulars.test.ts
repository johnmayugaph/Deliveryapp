import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { platformAbsorbedCentavos } from '@/lib/settlement/policy';
import { REPORT_WINDOW_DAYS } from '@/lib/merchant/reporting';
import { DEFAULT_WINDOW_DAYS } from '@/lib/merchant/tier-customers';

/**
 * What the Regulars tab says, and whether it agrees with the tab next to it.
 *
 * The defect these guard is one this project introduced itself: two screens
 * reported "TARA covered" over the same ninety days about different amounts —
 * the loyalty discount here, all four discount columns there — with nothing to
 * explain the gap. Making the windows agree, one phase earlier, is what turned
 * a difference nobody could see into one a shop would.
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8');
const codeOnly = (file: string) =>
  read(file).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

describe('the two absorbed figures', () => {
  const query = codeOnly('src/lib/merchant/tier-customers.ts');

  it('are computed with the same function settlement was charged', () => {
    /**
     * Not a fifth copy of the four-column sum. `platformAbsorbedCentavos` is
     * what `accrueOrderSettlement` records and what the History loader
     * reports, so the totals are equal by construction rather than by
     * coincidence.
     */
    expect(query).toMatch(/platformAbsorbedCentavos/);
    expect(query).not.toMatch(/promoDiscountCentavos \+/);
    const history = codeOnly('src/lib/merchant/queue.ts');
    expect(history).toMatch(/platformAbsorbedCentavos/);
  });

  it('read all four discount columns, not just the loyalty one', () => {
    // The query selected `loyaltyDiscountCentavos` alone, so the total could
    // not have been computed here even if somebody had wanted it.
    for (const column of [
      'promoDiscountCentavos',
      'subscriptionDiscountCentavos',
      'loyaltyDiscountCentavos',
      'walletCreditAppliedCentavos',
    ]) {
      expect(query, column).toContain(`${column}: true`);
    }
  });

  it('sum the loyalty part to no more than the whole', () => {
    /**
     * The relationship the screen states. Asserted on the arithmetic rather
     * than on the wording, so it holds for any order.
     */
    const order = {
      promoDiscountCentavos: 5_000,
      subscriptionDiscountCentavos: 2_500,
      loyaltyDiscountCentavos: 1_000,
      walletCreditAppliedCentavos: 500,
    };
    expect(platformAbsorbedCentavos(order)).toBe(9_000);
    expect(order.loyaltyDiscountCentavos).toBeLessThanOrEqual(
      platformAbsorbedCentavos(order),
    );
  });

  it('cover the same window as the tab they are compared against', () => {
    expect(DEFAULT_WINDOW_DAYS).toBe(REPORT_WINDOW_DAYS);
  });
});

describe('what the panel calls them', () => {
  const panel = codeOnly('src/components/merchant/TierStandingPanel.tsx');

  it('no longer labels the loyalty part "TARA covered"', () => {
    /**
     * The History tab's own figure carries those words, and it is a different
     * number. One of the two labels had to change, and it is this one: this
     * screen is about statuses, so naming the figure after them is both the
     * fix and the more accurate caption.
     */
    expect(panel).toMatch(/label="Statuses covered"/);
    expect(panel).not.toMatch(/label="TARA covered"/);
  });

  it('states the whole figure and which tab shows it order by order', () => {
    expect(panel).toMatch(/absorbedCentavos/);
    expect(panel).toMatch(/History/);
  });

  it('says so only when there is something to reconcile', () => {
    // On a shop that has had no discounts at all, a paragraph explaining how
    // ₱0.00 relates to ₱0.00 is noise.
    expect(panel).toMatch(/absorbedCentavos > 0 \?/);
  });
});

describe('the per-tier split', () => {
  const query = codeOnly('src/lib/merchant/tier-customers.ts');
  const panel = codeOnly('src/components/merchant/TierStandingPanel.tsx');

  it('is grouped on the tier id rather than its name', () => {
    // Two rungs sharing a name would otherwise be merged into one row.
    expect(query).toMatch(/perTier = new Map</);
    expect(query).toMatch(/perTier\.get\(tier\.id\)/);
    expect(query).toMatch(/tierByUser\.set\(account\.userId, \{ id: current\.id/);
  });

  it('omits rungs nobody at this shop has reached', () => {
    /**
     * A shop wants to know who its regulars are, not which bands exist — the
     * ladder below already lists every rung and what it confers.
     */
    expect(query).toMatch(/bucket === undefined\s*\?\s*\[\]/);
  });

  it('keeps the ladder’s own order rather than sorting by size', () => {
    // A list that reshuffled as customers moved between rungs would be
    // unreadable, and the rungs are shown in ladder order just below it.
    expect(query).toMatch(/ladder\.flatMap\(\(tier\) =>/);
    expect(query).not.toMatch(/regularsByTier[\s\S]{0,80}\.sort\(/);
  });

  it('is rendered from the split itself, not from the benefit ladder', () => {
    /**
     * It was first written as a line inside each ladder card, and a browser
     * showed the consequence: `merchantTierViews` drops every tier that
     * confers nothing a shop is told about, so on a programme whose statuses
     * carry no benefits yet — the state every deployment starts in, and the
     * state of the seeded database — there are no cards, and a page headed
     * "Your regulars" still could not say which ones.
     *
     * So the block is driven by `regularsByTier` and gated on nothing else.
     */
    expect(panel).toMatch(/\{regularsByTier\.length > 0 \?/);
    expect(panel).toMatch(/regularsByTier\.map\(\(row\) =>/);
    expect(panel).not.toMatch(/regularsAt/);
    // And it is outside the `tiers` branch, which is the whole point.
    const split = panel.indexOf('regularsByTier.length > 0');
    const ladder = panel.indexOf('tiers.length === 0');
    expect(split).toBeGreaterThan(-1);
    expect(ladder).toBeGreaterThan(split);
  });

  it('counts customers and orders separately', () => {
    // One regular ordering eleven times is one regular, not eleven.
    expect(query).toMatch(/customers: bucket\.customers\.size/);
    expect(query).toMatch(/orders: bucket\.orders/);
  });
});
