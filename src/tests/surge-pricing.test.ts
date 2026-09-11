import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AdminAction, BenefitSource, BenefitType, ServiceKey } from '@prisma/client';
import { applyBenefits } from '@/lib/pricing/benefits';
import { ADMIN_ACTION_LABEL } from '@/lib/admin/access';
import { partnerEarningsCentavos } from '@/lib/fleet/offer-policy';
import {
  SNAPSHOT_MAX_AGE_SECONDS,
  SURGE_CEILING_CENTAVOS,
  SURGE_REASON_TEXT,
  capSurge,
  firstDescendingStep,
  ladderFor,
  ordersPerRider,
  selectBand,
  surgeForMarket,
  surgeFromSnapshot,
  type SurgeBandFacts,
  type SurgeReason,
} from '@/lib/pricing/surge-policy';

/**
 * Surge pricing.
 *
 * One idea carries this file: **the only surprise a customer is allowed is a
 * pleasant one.** Every uncertainty — no bands, no measurement, an old
 * measurement, a mistyped ladder — has to come out as ₱0, and the price a
 * customer is quoted has to be the price they are charged. So most of what
 * follows is not "does the arithmetic work" but "does the doubtful case
 * decline to bill anyone".
 */

function source(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (match) => ' '.repeat(match.length))
    .replace(/^\s*\/\/\/.*$/gm, ' ');
}

function codeOnly(relativePath: string): string {
  return stripComments(source(relativePath));
}

function band(
  overrides: Partial<SurgeBandFacts> & Pick<SurgeBandFacts, 'minOrdersPerRider' | 'surgeCentavos'>,
): SurgeBandFacts {
  return {
    id: `band-${overrides.minOrdersPerRider}-${overrides.cityId ?? 'all'}`,
    cityId: null,
    label: `Step ${overrides.minOrdersPerRider}`,
    isActive: true,
    ...overrides,
  };
}

/** A plausible national ladder: busy at 1.5, very busy at 2.5, brutal at 4. */
const LADDER: SurgeBandFacts[] = [
  band({ minOrdersPerRider: 1.5, surgeCentavos: 2_000, label: 'Busy' }),
  band({ minOrdersPerRider: 2.5, surgeCentavos: 4_000, label: 'Very busy' }),
  band({ minOrdersPerRider: 4, surgeCentavos: 6_000, label: 'Extremely busy' }),
];

describe('measuring how tight the market is', () => {
  it('is orders divided by riders', () => {
    expect(ordersPerRider(6, 3)).toBe(2);
    expect(ordersPerRider(3, 2)).toBe(1.5);
  });

  it('reads an empty market as calm, not as tight', () => {
    expect(ordersPerRider(0, 0)).toBe(0);
    expect(ordersPerRider(0, 12)).toBe(0);
  });

  it('does not drop the surge off a cliff when the last rider logs off', () => {
    // The failure this prevents: eight orders and one rider is the ceiling,
    // then that rider ends their shift and — if zero riders meant zero surge —
    // the price would FALL at the moment the wait got longest.
    const withOneRider = ordersPerRider(8, 1);
    const withNone = ordersPerRider(8, 0);
    expect(withNone).toBeGreaterThanOrEqual(withOneRider);
    expect(selectBand(LADDER, withNone)?.surgeCentavos).toBe(6_000);
  });

  it('never returns a negative ratio from nonsense counts', () => {
    expect(ordersPerRider(-4, 2)).toBe(0);
    expect(ordersPerRider(4, -2)).toBe(4);
  });
});

describe('which ladder applies', () => {
  const national = band({ minOrdersPerRider: 1.5, surgeCentavos: 2_000 });
  const manila = band({
    minOrdersPerRider: 2,
    surgeCentavos: 5_000,
    cityId: 'city_manila',
  });

  it('uses the city ladder when the city has one', () => {
    const ladder = ladderFor([national, manila], 'city_manila');
    expect(ladder).toEqual([manila]);
  });

  it('falls back to the national ladder in a city with none', () => {
    const ladder = ladderFor([national, manila], 'city_quezon');
    expect(ladder).toEqual([national]);
  });

  it('never merges the two, so nobody prices from half of each', () => {
    // Merging would surge Manila at 1.5 from a step Manila's operator never
    // wrote, which is a price no screen they configured can explain.
    const ladder = ladderFor([national, manila], 'city_manila');
    expect(ladder.some((step) => step.cityId === null)).toBe(false);
  });

  it('drops inactive steps before deciding which ladder is in force', () => {
    const off = { ...manila, isActive: false };
    // The trap: deactivating a city's only step must not silently promote the
    // whole national ladder onto that city.
    expect(ladderFor([national, off], 'city_manila')).toEqual([national]);
  });

  it('returns nothing when nobody has configured anything', () => {
    expect(ladderFor([], 'city_manila')).toEqual([]);
  });

  it('sorts a ladder by threshold whatever order it arrives in', () => {
    const shuffled = [LADDER[2]!, LADDER[0]!, LADDER[1]!];
    expect(ladderFor(shuffled, 'city_manila').map((s) => s.minOrdersPerRider)).toEqual([
      1.5, 2.5, 4,
    ]);
  });
});

describe('which step a ratio has earned', () => {
  it('charges nothing below the first threshold', () => {
    expect(selectBand(LADDER, 1.49)).toBeNull();
    expect(selectBand(LADDER, 0)).toBeNull();
  });

  it('includes the threshold itself', () => {
    expect(selectBand(LADDER, 1.5)?.label).toBe('Busy');
  });

  it('climbs one step at a time', () => {
    expect(selectBand(LADDER, 2.4)?.label).toBe('Busy');
    expect(selectBand(LADDER, 2.5)?.label).toBe('Very busy');
    expect(selectBand(LADDER, 3.9)?.label).toBe('Very busy');
    expect(selectBand(LADDER, 40)?.label).toBe('Extremely busy');
  });

  it('never charges less for a busier market, even from a mistyped ladder', () => {
    // 2.0 → ₱10 sits below 1.5 → ₱30. Highest-threshold-met would charge ₱10
    // at ratio 2 and ₱30 at ratio 1.5: the customer watching the queue grow
    // watches the price fall.
    const mistyped = [
      band({ minOrdersPerRider: 1.5, surgeCentavos: 3_000, label: 'Busy' }),
      band({ minOrdersPerRider: 2, surgeCentavos: 1_000, label: 'Typo' }),
    ];
    expect(selectBand(mistyped, 1.5)?.surgeCentavos).toBe(3_000);
    expect(selectBand(mistyped, 2)?.surgeCentavos).toBe(3_000);
  });

  it('is monotonic across the whole range, on both ladders', () => {
    const mistyped = [
      band({ minOrdersPerRider: 1.5, surgeCentavos: 3_000 }),
      band({ minOrdersPerRider: 2, surgeCentavos: 1_000 }),
      band({ minOrdersPerRider: 3, surgeCentavos: 5_000 }),
    ];
    for (const ladder of [LADDER, mistyped]) {
      let previous = 0;
      for (let ratio = 0; ratio <= 10; ratio += 0.05) {
        const charged = selectBand(ladder, ratio)?.surgeCentavos ?? 0;
        expect(charged).toBeGreaterThanOrEqual(previous);
        previous = charged;
      }
    }
  });

  it('points the console at the step that reads backwards', () => {
    expect(firstDescendingStep(LADDER)).toBeNull();
    const mistyped = [
      band({ minOrdersPerRider: 1.5, surgeCentavos: 3_000 }),
      band({ minOrdersPerRider: 2, surgeCentavos: 1_000, label: 'Typo' }),
    ];
    expect(firstDescendingStep(mistyped)?.label).toBe('Typo');
  });
});

describe('the ceiling', () => {
  it('is the same number the database enforces', () => {
    // The database is the enforcement; this constant is the same number where
    // the arithmetic can see it. They have to agree or one of them is a lie.
    const guards = source('prisma/sql/surge.sql');
    expect(guards).toContain(`"surgeCentavos" <= ${SURGE_CEILING_CENTAVOS}`);
  });

  it('sits below the fee ceiling the seed ships', () => {
    // A surge bigger than the whole fare is a decimal point in the wrong place.
    expect(SURGE_CEILING_CENTAVOS).toBeLessThan(25_000);
  });

  it('clamps anything above it', () => {
    expect(capSurge(SURGE_CEILING_CENTAVOS + 1)).toBe(SURGE_CEILING_CENTAVOS);
    expect(capSurge(9_999_999)).toBe(SURGE_CEILING_CENTAVOS);
  });

  it('turns nonsense into nothing rather than into a charge', () => {
    // Infinity clamps to nothing rather than to the ceiling. Both are safe,
    // but the module's rule is that an input it cannot reason about charges
    // ₱0 — a surge arrived at by arithmetic that overflowed is not a surge
    // anyone could explain to the customer paying it.
    expect(capSurge(Number.NaN)).toBe(0);
    expect(capSurge(Number.POSITIVE_INFINITY)).toBe(0);
    expect(capSurge(-500)).toBe(0);
    expect(capSurge(0)).toBe(0);
  });

  it('leaves whole centavos, never a fraction of one', () => {
    expect(capSurge(1_999.6)).toBe(2_000);
  });
});

describe('what the cron writes', () => {
  it('charges nothing at all when nobody configured a ladder', () => {
    const outcome = surgeForMarket({
      bands: [],
      cityId: 'city_manila',
      ordersWaiting: 40,
      ridersAvailable: 1,
    });
    // Surge off by default is the whole point: a market can be on fire and an
    // operator who never opened the surge screen still charges the plain fee.
    expect(outcome).toMatchObject({
      surgeCentavos: 0,
      label: null,
      reason: 'NOT_CONFIGURED',
    });
  });

  it('records the ratio it measured alongside the money', () => {
    const outcome = surgeForMarket({
      bands: LADDER,
      cityId: 'city_manila',
      ordersWaiting: 9,
      ridersAvailable: 3,
    });
    expect(outcome.ratio).toBe(3);
    expect(outcome).toMatchObject({
      surgeCentavos: 4_000,
      label: 'Very busy',
      reason: 'BUSY',
    });
  });

  it('says calm rather than charging when the market is quiet', () => {
    const outcome = surgeForMarket({
      bands: LADDER,
      cityId: 'city_manila',
      ordersWaiting: 2,
      ridersAvailable: 8,
    });
    expect(outcome).toMatchObject({ surgeCentavos: 0, label: null, reason: 'CALM' });
  });

  it('never produces a labelled zero, which the database would refuse', () => {
    // `surge_snapshot_surge_has_a_reason` requires (surge = 0) = (label IS
    // NULL). A charge with no name is an unexplained fee; a name over ₱0 is a
    // screen saying "Busy" above nothing.
    const rows = [
      { bands: [] as SurgeBandFacts[], orders: 40, riders: 0 },
      { bands: LADDER, orders: 0, riders: 0 },
      { bands: LADDER, orders: 1, riders: 9 },
      { bands: LADDER, orders: 99, riders: 1 },
    ];
    for (const row of rows) {
      const outcome = surgeForMarket({
        bands: row.bands,
        cityId: 'city_manila',
        ordersWaiting: row.orders,
        ridersAvailable: row.riders,
      });
      expect(outcome.surgeCentavos === 0).toBe(outcome.label === null);
    }
  });

  it('caps a step that was saved before the ceiling was lowered', () => {
    const outcome = surgeForMarket({
      bands: [band({ minOrdersPerRider: 1, surgeCentavos: 50_000, label: 'Old' })],
      cityId: 'city_manila',
      ordersWaiting: 4,
      ridersAvailable: 1,
    });
    expect(outcome.surgeCentavos).toBe(SURGE_CEILING_CENTAVOS);
  });
});

describe('what a quote charges', () => {
  const now = new Date('2026-09-08T12:00:00.000Z');

  function snapshotAgedSeconds(seconds: number, surge = 2_000, label = 'Busy') {
    return {
      surgeCentavos: surge,
      bandLabel: label as string | null,
      createdAt: new Date(now.getTime() - seconds * 1_000),
    };
  }

  it('charges what the snapshot says, so quote and placement agree', () => {
    expect(surgeFromSnapshot(snapshotAgedSeconds(30), now)).toEqual({
      surgeCentavos: 2_000,
      label: 'Busy',
      reason: 'BUSY',
    });
  });

  it('charges nothing when the market has never been measured', () => {
    expect(surgeFromSnapshot(null, now)).toMatchObject({
      surgeCentavos: 0,
      reason: 'NO_SNAPSHOT',
    });
  });

  it('charges nothing from a measurement older than five minutes', () => {
    // The cron runs every minute, so this is four missed passes: by now the
    // reading describes a market that has moved on.
    expect(surgeFromSnapshot(snapshotAgedSeconds(SNAPSHOT_MAX_AGE_SECONDS + 1), now))
      .toMatchObject({ surgeCentavos: 0, label: null, reason: 'STALE' });
  });

  it('still charges at exactly the boundary', () => {
    expect(
      surgeFromSnapshot(snapshotAgedSeconds(SNAPSHOT_MAX_AGE_SECONDS), now).reason,
    ).toBe('BUSY');
  });

  it('refuses a snapshot from the future rather than trusting it', () => {
    // A negative age proves only that the timestamps cannot be reasoned about,
    // and an unreasonable timestamp must not become a charge.
    expect(surgeFromSnapshot(snapshotAgedSeconds(-60), now).reason).toBe('STALE');
  });

  it('ignores a charge whose reason went missing', () => {
    const orphan = { ...snapshotAgedSeconds(30), bandLabel: null };
    expect(surgeFromSnapshot(orphan, now)).toMatchObject({
      surgeCentavos: 0,
      reason: 'CALM',
    });
  });

  it('caps a stored surge above the ceiling', () => {
    expect(surgeFromSnapshot(snapshotAgedSeconds(30, 90_000), now).surgeCentavos).toBe(
      SURGE_CEILING_CENTAVOS,
    );
  });

  it('names every reason it can return', () => {
    const reasons: SurgeReason[] = [
      'NOT_CONFIGURED',
      'NO_SNAPSHOT',
      'STALE',
      'CALM',
      'BUSY',
    ];
    for (const reason of reasons) {
      expect(SURGE_REASON_TEXT[reason].length).toBeGreaterThan(10);
    }
    expect(Object.keys(SURGE_REASON_TEXT).sort()).toEqual([...reasons].sort());
  });
});

describe('the rule stays pure', () => {
  it('imports nothing that would drag the server into the browser', () => {
    // The lesson from five previous rounds of this: a constant a client
    // component wants lives in a module that imports nothing but types, or
    // `next/headers` ends up in the browser bundle and the build breaks a
    // screen away from the change.
    const policy = codeOnly('src/lib/pricing/surge-policy.ts');
    expect(policy).not.toMatch(/from 'next\//);
    expect(policy).not.toMatch(/from '@\/lib\/prisma'/);
    expect(policy).not.toMatch(/from '@prisma\/client'/);
    expect(policy).not.toMatch(/^import (?!type )/m);
  });

  it('takes the clock as an argument rather than reading it', () => {
    const policy = codeOnly('src/lib/pricing/surge-policy.ts');
    expect(policy).not.toMatch(/Date\.now\(\)/);
    expect(policy).not.toMatch(/new Date\(\)/);
  });
});

describe('the surge belongs to the rider, and nothing takes it away', () => {
  const BUSY_ORDER = {
    subtotalCentavos: 50_000,
    deliveryFeeCentavos: 4_900,
    serviceFeeCentavos: 1_000,
    smallOrderFeeCentavos: 0,
    surgeCentavos: 2_000,
    tipCentavos: 0,
    promoDiscountCentavos: 0,
  };

  it('adds the surge to the rider’s earnings, not the platform’s', () => {
    expect(partnerEarningsCentavos(BUSY_ORDER)).toBe(4_900 + 2_000);
  });

  it('is not waived by a free-delivery benefit', () => {
    // The trap: Plus waives the DELIVERY FEE. If the waiver reached the surge
    // as well, a subscriber ordering in a busy market would take ₱20 out of
    // the rider's pay — the rider would be paid less for the harder job
    // precisely because the customer has a subscription.
    const outcome = applyBenefits({
      serviceType: ServiceKey.FOOD,
      fees: BUSY_ORDER,
      benefits: [
        {
          source: BenefitSource.SUBSCRIPTION,
          benefit: {
          id: 'free_delivery',
          type: BenefitType.FREE_DELIVERY,
          serviceKeys: [],
          percentBasisPoints: null,
          minimumOrderCentavos: 0,
          monthlyUsageCap: null,
          maxDiscountCentavos: null,
          monthlyCeilingCentavos: null,
          displayLabel: 'Plus free delivery',
          sortOrder: 0,
          },
        },
      ],
      usageByBenefitId: new Map(),
    });

    // The waiver covers the fee exactly, and no more.
    expect(outcome.subscriptionDiscountCentavos).toBe(4_900);
    // So the surge survives into what is payable.
    const gross = 50_000 + 4_900 + 1_000 + 2_000;
    expect(outcome.payableCentavos).toBe(gross - 4_900);
  });
});

describe('the market is measured on the sweep, and read by quotes', () => {
  it('snapshots after the timeout sweep, not before', () => {
    // Order matters: an order cancelled a moment ago for sitting unclaimed is
    // no longer competing for a rider, and counting it would charge the next
    // customer for pressure already released.
    const sweep = codeOnly('src/lib/orders/maintenance.ts');
    const expiry = sweep.indexOf('const expired = await expireStaleOrders()');
    const snapshot = sweep.indexOf('await recordSurgeSnapshots()');
    expect(expiry).toBeGreaterThan(-1);
    expect(snapshot).toBeGreaterThan(expiry);
  });

  it('counts only orders actually waiting for a rider', () => {
    const surge = codeOnly('src/lib/pricing/surge.ts');
    expect(surge).toMatch(/status: OrderStatus\.AWAITING_RIDER_ASSIGNMENT/);
  });

  it('counts only riders who could take a job', () => {
    const surge = codeOnly('src/lib/pricing/surge.ts');
    expect(surge).toMatch(/isOnline: true, isSuspended: false/);
    // A rider already carrying an order is not available, however online.
    expect(surge).toMatch(/onAJob\.has\(partner\.id\)/);
    expect(surge).toMatch(/ACTIVE_JOB_STATUSES/);
  });

  it('does not filter the snapshot lookup on freshness in SQL', () => {
    // Found against the real database. Bounding the query by `createdAt >=
    // now - window` meant an aged-out snapshot did not match, so the rule saw
    // null and answered NO_SNAPSHOT — "not measured yet" — for a market that
    // had been measured all day until the cron died. The one failure the
    // console exists to reveal, reported as its opposite; and it made the
    // STALE branch dead code in the only path that reaches it.
    const surge = codeOnly('src/lib/pricing/surge.ts');
    expect(surge).toMatch(/where: \{ serviceType, cityId \}/);
    expect(surge).not.toMatch(/createdAt: \{ gte:/);
    // Still one index seek: newest row for this market, nothing scanned.
    expect(surge).toMatch(/orderBy: \{ createdAt: 'desc' \}/);
    const schema = source('prisma/schema.prisma');
    expect(schema).toMatch(
      /@@index\(\[serviceType, cityId, createdAt\(sort: Desc\)\]\)/,
    );
  });

  it('reports the pass, so a sweep that measures nothing is visible', () => {
    const script = codeOnly('scripts/run-order-maintenance.ts');
    expect(script).toMatch(/surge\.measured/);
  });
});

describe('the quote and the placement charge the same number', () => {
  it('reads the surge from the snapshot inside the shared quote path', () => {
    // `placeOrder` re-quotes through `quoteCheckout`, so putting the lookup
    // there is what makes the displayed price and the charged price the same
    // code — measuring the queue per call site is how they drift apart.
    const order = codeOnly('src/lib/orders/place-order.ts');
    const quoteStart = order.indexOf('export async function quoteCheckout');
    const placeStart = order.indexOf('export async function placeOrder');
    const lookup = order.indexOf('await currentSurge(');
    expect(lookup).toBeGreaterThan(quoteStart);
    expect(lookup).toBeLessThan(placeStart);
  });

  it('never charges more surge than the screen displayed', () => {
    const order = codeOnly('src/lib/orders/place-order.ts');
    expect(order).toMatch(/quote\.surge\.surgeCentavos > input\.acceptedSurgeCentavos/);
    expect(order).toMatch(/throw new SurgeChangedError/);
  });

  it('treats the accepted figure as a ceiling and never as a price', () => {
    // A client-supplied number that can only cause a REFUSAL: sending a lower
    // figure than the real one buys an error, not a cheaper order.
    const order = codeOnly('src/lib/orders/place-order.ts');
    const uses = order.match(/acceptedSurgeCentavos/g) ?? [];
    // Declared once in the input type, read once in the comparison, passed
    // once to the error. Never assigned to a fee.
    expect(uses.length).toBeGreaterThan(0);
    expect(order).not.toMatch(/surgeCentavos: input\.acceptedSurgeCentavos/);
    expect(order).not.toMatch(/surgeCentavos: quote\.surge\.label/);
  });

  it('sends the displayed surge from the checkout screen', () => {
    // The whole ceiling is worthless if the form never fills it in — which is
    // the failure this codebase has produced three times now.
    const form = codeOnly('src/components/cart/CheckoutForm.tsx');
    expect(form).toMatch(/acceptedSurgeCentavos: quote\?\.surge\.surgeCentavos/);
  });

  it('re-quotes after a refusal, rather than leaving the old price up', () => {
    const form = codeOnly('src/components/cart/CheckoutForm.tsx');
    expect(form).toMatch(/code === 'SURGE_CHANGED'/);
    expect(form).toMatch(/setRequoteNonce/);
    // In the re-quote key, or the nonce changes nothing.
    const key = form.slice(form.indexOf('const quoteKey'), form.indexOf('useEffect('));
    expect(key).toMatch(/requoteNonce/);
  });

  it('lets the refusal reach the customer as its own sentence', () => {
    const actions = codeOnly('src/lib/actions/checkout-actions.ts');
    expect(actions).toMatch(/'SurgeChangedError'/);
    expect(actions).toMatch(/code: 'SURGE_CHANGED'/);
  });
});

describe('the charge has a name wherever it is shown', () => {
  it('gives the checkout line the band’s own label', () => {
    const form = codeOnly('src/components/cart/CheckoutForm.tsx');
    expect(form).toMatch(/label=\{quote\.surge\.label/);
  });

  it('says on the checkout screen where the money goes', () => {
    const form = codeOnly('src/components/cart/CheckoutForm.tsx');
    expect(form).toMatch(/goes to your\s*\n?\s*rider/);
  });

  it('copies the label onto the order, so the receipt outlives the band', () => {
    const order = codeOnly('src/lib/orders/place-order.ts');
    expect(order).toMatch(/surgeLabel: quote\.surge\.label/);
  });

  it('reads that label back on both receipts', () => {
    expect(codeOnly('src/app/orders/[orderId]/page.tsx')).toMatch(/order\.surgeLabel/);
    expect(codeOnly('src/app/admin/orders/[orderNumber]/page.tsx')).toMatch(
      /order\.surgeLabel/,
    );
  });

  it('refuses a charge with no reason on the order, in the database', () => {
    const guards = source('prisma/sql/surge.sql');
    expect(guards).toMatch(/order_surge_has_a_reason/);
    expect(guards).toMatch(/\("surgeCentavos" = 0\) = \("surgeLabel" IS NULL\)/);
  });
});

describe('editing the ladder is an audited decision', () => {
  it('names all three actions in the log’s vocabulary', () => {
    for (const action of [
      AdminAction.SURGE_BAND_CREATED,
      AdminAction.SURGE_BAND_CHANGED,
      AdminAction.SURGE_BAND_ACTIVATION_CHANGED,
    ]) {
      expect(ADMIN_ACTION_LABEL[action].length).toBeGreaterThan(5);
    }
  });

  it('demands a reason and writes an audit row for each', () => {
    // Checked per FUNCTION rather than by counting matches in the rest of the
    // file. The first version of this sliced from `createSurgeBandAction` to
    // the end of the source and asserted "three of each" — which passed only
    // as long as the surge actions were the last thing in the file, and broke
    // the day promo codes were appended after them. A test that measures where
    // code sits rather than what it does fails for the wrong reason and tells
    // you nothing when it does.
    const actions = codeOnly('src/lib/actions/admin-actions.ts');

    /** One exported action's body: from its signature to the next one. */
    const bodyOf = (name: string): string => {
      const start = actions.indexOf(`export async function ${name}(`);
      expect(start, `${name} should exist`).toBeGreaterThan(-1);
      const rest = actions.slice(start + 1);
      const end = rest.indexOf('export async function ');
      return end === -1 ? rest : rest.slice(0, end);
    };

    const surgeActions = {
      createSurgeBandAction: 'SURGE_BAND_CREATED',
      updateSurgeBandAction: 'SURGE_BAND_CHANGED',
      setSurgeBandActiveAction: 'SURGE_BAND_ACTIVATION_CHANGED',
    } as const;

    for (const [name, action] of Object.entries(surgeActions)) {
      const body = bodyOf(name);
      expect(body, `${name} should log ${action}`).toContain(`AdminAction.${action}`);
      expect(body, `${name} should demand a reason`).toContain(
        "normaliseReason(formData.get('reason'))",
      );
      expect(body, `${name} should write an audit row`).toContain(
        'await recordAdminAction(',
      );
    }
  });

  it('turns each refusal into a sentence rather than a constraint violation', () => {
    const actions = source('src/lib/actions/admin-actions.ts');
    const surge = actions.slice(actions.indexOf('function readBandFields'));
    // The bounds the database enforces, restated where an operator reads them.
    expect(surge).toMatch(/decimal point in the wrong place/);
    expect(surge).toMatch(/A step that adds nothing is not a step/);
    expect(surge).toMatch(/A fee with no name reads as a mistake/);
  });

  it('offers no way to configure a step that charges nothing', () => {
    // Which is what makes "off" unambiguous: surge is off where no step
    // exists or every step is switched off, and never because a step quietly
    // adds ₱0.
    const actions = codeOnly('src/lib/actions/admin-actions.ts');
    expect(actions).toMatch(/if \(surgeCentavos <= 0\)/);
  });
});

describe('the console shows the market and the charge separately', () => {
  it('measures live for the screen and reads the snapshot for the charge', () => {
    const admin = codeOnly('src/lib/admin/surge.ts');
    expect(admin).toMatch(/ordersWaitingByCity\(\)/);
    expect(admin).toMatch(/ridersAvailableByCity\(\)/);
    expect(admin).toMatch(/charging: await currentSurge\(/);
    expect(admin).toMatch(/wouldCharge: selectBand\(/);
  });

  it('shows cities with no ladder, because that is where one gets added', () => {
    // The cron deliberately skips these — a pair with no bands can never
    // surge — so the console has to expand from the service registry instead.
    const admin = codeOnly('src/lib/admin/surge.ts');
    expect(admin).toMatch(/availableCityIds/);
  });

  it('says out loud when nothing has been measured recently', () => {
    // Every uncertainty in this feature resolves to charging nothing, which is
    // the right default and a silent one: a stopped cron switches surge off
    // and no other screen would show it.
    const page = codeOnly('src/app/admin/surge/page.tsx');
    expect(page).toMatch(/cronLooksStopped/);
    expect(page).toMatch(/SNAPSHOT_MAX_AGE_SECONDS/);
    expect(page).toMatch(/role="alert"/);
  });

  it('is reachable from the console nav', () => {
    // Searched, not pointed at one file. This asserted against
    // `admin/layout.tsx` and broke the day the nav moved into its own
    // component — a reachability check should follow the links, not a path
    // somebody typed once.
    const nav = [
      'src/components/admin/AdminSidebar.tsx',
      'src/app/admin/layout.tsx',
    ]
      .map((file) => source(file))
      .join('\n');
    expect(nav).toMatch(/['"]\/admin\/surge['"]/);
  });
});
