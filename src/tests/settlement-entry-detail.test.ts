import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SettlementEntryType, SettlementParty } from '@prisma/client';
import {
  MISSING_REFERENCE_NOTE,
  entryDetailLines,
  referenceState,
} from '@/lib/settlement/entry-detail';
import { referenceIsRequired } from '@/lib/settlement/policy';

/**
 * What a statement line says beyond its amount.
 *
 * Both halves of this were already being recorded and shown to nobody, so the
 * tests that matter are the defensive ones: this renders on a screen about
 * somebody's money, and a wrong figure there is worse than no figure because
 * a shop would reconcile against it.
 */

const ALL_TYPES = Object.values(SettlementEntryType);

const earnings = (metadata: unknown) => ({
  type: SettlementEntryType.ORDER_EARNINGS,
  metadata,
});

// --- The commission a shop could not see ----------------------------------

describe('the breakdown behind a store earnings line', () => {
  it('stays quiet about a rate that matches the shop’s current one', () => {
    /**
     * Found by looking at the rendered screen: seventy statement rows each
     * carrying an identical "Rate 15.00%", under a footer already saying the
     * shop pays 15% of the food. Pure noise, seventy times over.
     */
    const lines = entryDetailLines(
      earnings({
        subtotalCentavos: 50_000,
        commissionBasisPoints: 1_500,
        commissionCentavos: 7_500,
      }),
      SettlementParty.STORE,
      { currentCommissionBasisPoints: 1_500 },
    );
    expect(lines.map((line) => line.label)).toEqual(['Food', 'TARA commission']);
  });

  it('speaks up for a line priced at a DIFFERENT rate', () => {
    /**
     * The case dropping it altogether would have lost, and the only case that
     * matters: the rate is snapshotted per entry, so a line from before a rate
     * change carries the old one — and that is exactly when the footer's
     * current figure misleads.
     */
    const lines = entryDetailLines(
      earnings({
        subtotalCentavos: 50_000,
        commissionBasisPoints: 1_000,
        commissionCentavos: 5_000,
      }),
      SettlementParty.STORE,
      { currentCommissionBasisPoints: 1_500 },
    );
    expect(lines.map((line) => line.label)).toEqual([
      'Food',
      'TARA commission',
      'Rate then',
    ]);
    expect(lines[2]!.value).toEqual({ kind: 'rate', basisPoints: 1_000 });
  });

  it('shows the food, the commission and the rate', () => {
    // Recorded by accrueOrderSettlement since settlement was built, and read
    // by nothing until now: a shop that sold ₱500 saw +₱425.00 and had to do
    // the arithmetic to check its own deduction.
    const lines = entryDetailLines(
      earnings({
        subtotalCentavos: 50_000,
        commissionBasisPoints: 1_500,
        commissionCentavos: 7_500,
      }),
      SettlementParty.STORE,
    );
    expect(lines).toEqual([
      { label: 'Food', value: { kind: 'money', centavos: 50_000 } },
      { label: 'TARA commission', value: { kind: 'money', centavos: 7_500 } },
      { label: 'Rate', value: { kind: 'rate', basisPoints: 1_500 } },
    ]);
  });

  it('drops the commission lines for a shop that pays none', () => {
    // Every shop starts at 0%. "TARA commission ₱0.00" on every order of a
    // statement is noise, and the rate line goes with it.
    const lines = entryDetailLines(
      earnings({
        subtotalCentavos: 50_000,
        commissionBasisPoints: 0,
        commissionCentavos: 0,
      }),
      SettlementParty.STORE,
    );
    expect(lines).toEqual([
      { label: 'Food', value: { kind: 'money', centavos: 50_000 } },
    ]);
  });

  it('shows the rider their fee, and a tip only when there was one', () => {
    expect(
      entryDetailLines(
        earnings({ deliveryFeeCentavos: 3_900, tipCentavos: 2_000 }),
        SettlementParty.FLEET_PARTNER,
      ),
    ).toEqual([
      { label: 'Delivery fee', value: { kind: 'money', centavos: 3_900 } },
      { label: 'Tip', value: { kind: 'money', centavos: 2_000 } },
    ]);
    // "Tip ₱0.00" on every delivery reads as a comment on the customer.
    expect(
      entryDetailLines(
        earnings({ deliveryFeeCentavos: 3_900, tipCentavos: 0 }),
        SettlementParty.FLEET_PARTNER,
      ),
    ).toEqual([
      { label: 'Delivery fee', value: { kind: 'money', centavos: 3_900 } },
    ]);
  });

  it('breaks down nothing but an earnings line', () => {
    for (const type of ALL_TYPES) {
      if (type === SettlementEntryType.ORDER_EARNINGS) continue;
      expect(
        entryDetailLines(
          { type, metadata: { subtotalCentavos: 50_000 } },
          SettlementParty.STORE,
        ),
        type,
      ).toEqual([]);
    }
  });
});

// --- Malformed metadata must not be believed or crash ----------------------

describe('metadata is not trusted', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'subtotal: 500'],
    ['a number', 42],
    ['an array', [50_000, 7_500]],
    ['an empty object', {}],
  ])('returns no lines for %s', (_label, metadata) => {
    expect(() =>
      entryDetailLines(earnings(metadata), SettlementParty.STORE),
    ).not.toThrow();
    expect(entryDetailLines(earnings(metadata), SettlementParty.STORE)).toEqual([]);
  });

  it.each([
    ['a string where centavos belong', { subtotalCentavos: '50000' }],
    ['a float', { subtotalCentavos: 500.5 }],
    ['a negative', { subtotalCentavos: -50_000 }],
    ['NaN', { subtotalCentavos: Number.NaN }],
    ['Infinity', { subtotalCentavos: Number.POSITIVE_INFINITY }],
    ['beyond a safe integer', { subtotalCentavos: 2 ** 60 }],
  ])('refuses to show %s rather than displaying it', (_label, metadata) => {
    // A wrong number on a payout screen is worse than no number: a shop would
    // reconcile against it.
    expect(entryDetailLines(earnings(metadata), SettlementParty.STORE)).toEqual([]);
  });

  it('keeps the food line when only the commission is malformed', () => {
    // Partial credit, deliberately: the subtotal is the figure the shop most
    // wants, and losing it because a sibling field is broken would be worse.
    const lines = entryDetailLines(
      earnings({ subtotalCentavos: 50_000, commissionCentavos: 'oops' }),
      SettlementParty.STORE,
    );
    expect(lines).toEqual([
      { label: 'Food', value: { kind: 'money', centavos: 50_000 } },
    ]);
  });

  it('refuses a rate outside nought to a hundred per cent', () => {
    const lines = entryDetailLines(
      earnings({
        subtotalCentavos: 50_000,
        commissionCentavos: 7_500,
        commissionBasisPoints: 99_999,
      }),
      SettlementParty.STORE,
    );
    expect(lines.map((line) => line.label)).toEqual(['Food', 'TARA commission']);
  });
});

// --- The reference a payout is required to carry ---------------------------

describe('the reference on a line', () => {
  it('asks the same question the ledger’s writer asks', () => {
    /**
     * The first version of this module carried its own map of which types
     * need a reference — a second copy of `referenceIsRequired`, which the
     * writer uses to REFUSE an entry without one. Two copies of one decision
     * is a screen that can demand a reference the writer does not require, or
     * stay silent about one it does.
     *
     * So this checks agreement across the whole enum rather than restating
     * the list.
     */
    for (const type of ALL_TYPES) {
      const state = referenceState({ type, reference: null });
      expect(state.kind, type).toBe(referenceIsRequired(type) ? 'missing' : 'none');
    }
  });

  it('expects one on exactly the three a person asserts', () => {
    // Stated once here as a readable summary of what the writer requires: a
    // payout, a remittance and an adjustment are each somebody claiming money
    // moved in the real world.
    const expected = ALL_TYPES.filter((type) => referenceIsRequired(type)).sort();
    expect(expected).toEqual(
      [
        SettlementEntryType.PAYOUT_SENT,
        SettlementEntryType.CASH_REMITTED,
        SettlementEntryType.ADJUSTMENT,
      ].sort(),
    );
  });

  it('shows a reference that is there', () => {
    expect(
      referenceState({
        type: SettlementEntryType.PAYOUT_SENT,
        reference: 'GC-88910',
      }),
    ).toEqual({ kind: 'shown', reference: 'GC-88910' });
  });

  it('says so when a payout has none, rather than staying quiet', () => {
    // The reference exists so the partner can check the claim. A payout with
    // none, shown as though nothing were missing, leaves them unable to
    // reconcile and unaware that is why.
    expect(
      referenceState({ type: SettlementEntryType.PAYOUT_SENT, reference: null }),
    ).toEqual({ kind: 'missing' });
    expect(
      referenceState({ type: SettlementEntryType.PAYOUT_SENT, reference: '   ' }),
    ).toEqual({ kind: 'missing' });
  });

  it('says nothing about an accrual having no reference', () => {
    expect(
      referenceState({ type: SettlementEntryType.ORDER_EARNINGS, reference: null }),
    ).toEqual({ kind: 'none' });
  });

  it('tells the partner what to do, not that we made a mistake', () => {
    expect(MISSING_REFERENCE_NOTE).toMatch(/Ask the TARA team/);
    expect(MISSING_REFERENCE_NOTE).not.toMatch(/error|bug|failed|wrong/i);
  });
});

// --- Where "last paid" comes from ----------------------------------------

describe('the last payout', () => {
  it('is its own query, not a scan of the visible statement', () => {
    /**
     * The statement is capped at sixty lines. A busy shop's last payout is
     * easily older than its last sixty orders, so deriving this from what the
     * screen already had would have told exactly the shops with the most
     * orders that they had never been paid.
     */
    const ledger = readFileSync(
      path.join(process.cwd(), 'src/lib/settlement/ledger.ts'),
      'utf8',
    );
    expect(ledger).toMatch(/export async function lastPayout/);
    expect(ledger).toMatch(/type: SettlementEntryType\.PAYOUT_SENT/);
    expect(ledger).toMatch(/orderBy: \{ createdAt: 'desc' \}/);

    const panel = readFileSync(
      path.join(process.cwd(), 'src/components/settlement/PositionPanel.tsx'),
      'utf8',
    );
    // Passed in rather than dug out of `entries`.
    expect(panel).toMatch(/lastPayout\?: SettlementEntry \| null/);
    expect(panel).not.toMatch(/entries\.find\(/);
    expect(panel).not.toMatch(/entries\.filter\([\s\S]{0,60}PAYOUT_SENT/);
  });

  it('reaches both partners’ screens', () => {
    // The panel is shared, and a rider needs a payout reference for exactly
    // the same reason a shop does.
    for (const file of [
      'src/app/merchant/[storeId]/payouts/page.tsx',
      'src/app/fleet/earnings/page.tsx',
    ]) {
      const source = readFileSync(path.join(process.cwd(), file), 'utf8');
      expect(source, file).toMatch(/lastPayout/);
    }
  });
});
