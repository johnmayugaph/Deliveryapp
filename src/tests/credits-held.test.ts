import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  creditsState,
  describeHold,
  holdIsInForce,
  shortHoldNote,
  spendableFrom,
  type WalletFacts,
} from '@/lib/wallet/held';
import { freezeIsInForce } from '@/lib/wallet/rules';
import { formatCentavos } from '@/lib/money';

/** Strips comments, so a whole-file regex cannot be satisfied by prose. */
function codeOnly(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const NOW = new Date('2026-09-09T10:00:00.000Z');
const SOON = new Date('2026-09-12T10:00:00.000Z');
const PAST = new Date('2026-09-08T10:00:00.000Z');

const facts = (over: Partial<WalletFacts> = {}): WalletFacts => ({
  balanceCentavos: 25_000,
  isFrozen: false,
  frozenUntil: null,
  ...over,
});

const day = (date: Date) =>
  date.toLocaleDateString('en-PH', { day: 'numeric', month: 'long' });

describe('the three states', () => {
  it('nothing in the ledger is NONE, with nothing to explain', () => {
    expect(creditsState(facts({ balanceCentavos: 0 }), NOW)).toEqual({
      kind: 'NONE',
    });
    // Even frozen: a hold on nothing is not worth a sentence.
    expect(
      creditsState(
        facts({ balanceCentavos: 0, isFrozen: true, frozenUntil: SOON }),
        NOW,
      ).kind,
    ).toBe('NONE');
  });

  it('a balance with no hold is SPENDABLE', () => {
    expect(creditsState(facts(), NOW)).toEqual({
      kind: 'SPENDABLE',
      centavos: 25_000,
    });
  });

  it('a balance under a hold is HELD, and keeps its amount', () => {
    // The whole point: the money is still theirs and the figure is still real.
    expect(creditsState(facts({ isFrozen: true, frozenUntil: SOON }), NOW)).toEqual(
      { kind: 'HELD', centavos: 25_000, until: SOON },
    );
  });

  it('a hold that has run out is SPENDABLE again, at the instant it runs out', () => {
    // Not at the next cron tick. The sweep is tidying, not enforcement.
    expect(
      creditsState(facts({ isFrozen: true, frozenUntil: PAST }), NOW).kind,
    ).toBe('SPENDABLE');
  });

  it('an indefinite hold has no date, because there is not one', () => {
    const state = creditsState(facts({ isFrozen: true, frozenUntil: null }), NOW);
    expect(state).toEqual({ kind: 'HELD', centavos: 25_000, until: null });
  });
});

describe('what can go against a bill', () => {
  it.each([
    ['NONE', facts({ balanceCentavos: 0 }), 0],
    ['SPENDABLE', facts(), 25_000],
    ['HELD, expiring', facts({ isFrozen: true, frozenUntil: SOON }), 0],
    ['HELD, indefinite', facts({ isFrozen: true, frozenUntil: null }), 0],
  ])('%s → %i spendable', (_name, given, expected) => {
    expect(spendableFrom(creditsState(given, NOW))).toBe(expected);
  });

  it('is zero for every state that is not SPENDABLE', () => {
    // The invariant, rather than a list of cases: nothing held is ever
    // offered against a bill, whatever a future state is called.
    expect(spendableFrom({ kind: 'NONE' })).toBe(0);
    expect(spendableFrom({ kind: 'HELD', centavos: 999, until: null })).toBe(0);
  });
});

describe('agreeing with the enforcement rule it duplicates', () => {
  /**
   * `holdIsInForce` is a deliberate copy of `freezeIsInForce`: that module is
   * reached from Prisma-facing code and this one is imported by a client
   * component. A duplicated rule is only safe while something checks the two
   * agree, so this is that something.
   */
  const cases: WalletFacts[] = [
    facts({ isFrozen: false, frozenUntil: null }),
    facts({ isFrozen: false, frozenUntil: SOON }),
    facts({ isFrozen: true, frozenUntil: null }),
    facts({ isFrozen: true, frozenUntil: SOON }),
    facts({ isFrozen: true, frozenUntil: PAST }),
    facts({ isFrozen: true, frozenUntil: NOW }),
  ];

  it.each(cases.map((c, i) => [i, c] as const))(
    'case %i agrees with freezeIsInForce',
    (_i, given) => {
      expect(holdIsInForce(given, NOW)).toBe(freezeIsInForce(given, NOW));
    },
  );

  it('covers the boundary, so the agreement is not trivial', () => {
    // A hold expiring exactly now is over: `>` not `>=`, in both.
    expect(holdIsInForce(facts({ isFrozen: true, frozenUntil: NOW }), NOW)).toBe(
      false,
    );
  });
});

describe('what the customer reads', () => {
  it('says nothing at all when nothing is held', () => {
    expect(describeHold({ kind: 'NONE' }, formatCentavos, day)).toBeNull();
    expect(
      describeHold({ kind: 'SPENDABLE', centavos: 100 }, formatCentavos, day),
    ).toBeNull();
  });

  it('names the date for a recovery hold, and says nothing was taken', () => {
    const text = describeHold(
      { kind: 'HELD', centavos: 25_000, until: SOON },
      formatCentavos,
      day,
    );
    expect(text).toContain('₱250.00');
    expect(text).toContain(day(SOON));
    expect(text).toMatch(/nothing has been taken/i);
    // The reason, in the customer's terms, not the column's.
    expect(text).toMatch(/new number/i);
  });

  it('names no date for a review, and points at a person', () => {
    const text = describeHold(
      { kind: 'HELD', centavos: 25_000, until: null },
      formatCentavos,
      day,
    );
    expect(text).toContain('₱250.00');
    expect(text).toMatch(/support/i);
    // Inventing a date turns one disappointment into two.
    expect(text).not.toMatch(/until/i);
    expect(text).toMatch(/has not gone anywhere/i);
  });

  it('never says a held balance is zero or unavailable', () => {
    for (const until of [SOON, null]) {
      const text = describeHold(
        { kind: 'HELD', centavos: 25_000, until },
        formatCentavos,
        day,
      )!;
      expect(text).not.toContain('₱0.00');
    }
  });
});

describe('the short note, for beside a payment option', () => {
  it('distinguishes held from absent', () => {
    // "₱0.00 available" was the falsehood: the money is there and the screen
    // said it was not.
    expect(shortHoldNote({ kind: 'HELD', centavos: 25_000, until: null }, formatCentavos))
      .toBe('₱250.00 held');
    expect(shortHoldNote({ kind: 'NONE' }, formatCentavos)).toBe('none yet');
    expect(
      shortHoldNote({ kind: 'SPENDABLE', centavos: 25_000 }, formatCentavos),
    ).toBe('₱250.00 available');
  });

  it('never reports a held balance as available', () => {
    const note = shortHoldNote(
      { kind: 'HELD', centavos: 25_000, until: null },
      formatCentavos,
    );
    expect(note).not.toContain('available');
  });
});

describe('checkout reads the LIVE figure, not the page-load one', () => {
  const form = codeOnly('src/components/cart/CheckoutForm.tsx');

  it('prefers the quote over the prop', () => {
    /**
     * The defect: `price.spendableCreditsCentavos` was already returned by
     * every quote and thrown away, while the screen rendered a prop fixed at
     * page load. Credits arriving mid-checkout could not be spent because the
     * checkbox was gated on the stale number, and credits that went to zero
     * left a checkbox that ticked and applied nothing.
     */
    expect(form).toMatch(/quote\?\.price\.credits \?\? creditsAtLoad/);
    // And the prop is named so nobody mistakes it for the current value.
    expect(form).toMatch(/creditsAtLoad/);
    expect(form).not.toMatch(/spendableCreditsCentavos: number/);
  });

  it('derives what is spendable through the one rule', () => {
    expect(form).toMatch(/spendableFrom\(credits\)/);
  });

  it('says "held" beside the option rather than a zero', () => {
    expect(form).toMatch(/shortHoldNote\(credits, formatCentavos\)/);
    expect(form).not.toMatch(/\{formatCentavos\(spendableCreditsCentavos\)\} available/);
  });

  it('explains the hold where the customer is choosing how to pay', () => {
    expect(form).toMatch(/holdNote \? \(/);
  });
});

describe('the two screens that render a balance', () => {
  const credits = codeOnly('src/app/credits/page.tsx');
  const checkout = codeOnly('src/app/checkout/page.tsx');

  it('show the BALANCE, not the spendable figure', () => {
    /**
     * `/credits` showed `getSpendableCentavos`, which is zero under a hold —
     * so the hero read ₱0.00 while the ledger rows below it added to
     * something else, and nothing said why. The comment on that function
     * claimed this screen explained the hold. No code here ever did.
     */
    expect(credits).toMatch(/wallet\.balanceCentavos/);
    expect(credits).not.toMatch(/getSpendableCentavos/);
    expect(checkout).not.toMatch(/getSpendableCentavos/);
  });

  it('both explain a hold', () => {
    expect(credits).toMatch(/describeHold\(/);
    expect(codeOnly('src/components/cart/CheckoutForm.tsx')).toMatch(
      /describeHold\(/,
    );
  });

  it('the ledger no longer claims a screen explains something it does not', () => {
    // The rotted sentence, gone. It is worth pinning: prose about a gate is
    // exactly what rots, and this is the fourth instance in the project.
    const ledger = readFileSync('src/lib/wallet/ledger.ts', 'utf8');
    expect(ledger).not.toMatch(/credits screen still shows it/);
  });
});

describe('the pure module stays pure', () => {
  it('imports nothing at all', () => {
    // A client component imports it; reaching Prisma would make it a 500.
    const source = readFileSync('src/lib/wallet/held.ts', 'utf8');
    expect(source).not.toMatch(/^import /m);
  });
});
