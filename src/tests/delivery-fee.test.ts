import { describe, expect, it } from 'vitest';
import { applyDeliveryFeeRule } from '@/lib/pricing/delivery-fee';
import { haversineMeters } from '@/lib/geo';

/** The seeded Manila rule, as the shape `applyDeliveryFeeRule` needs. */
function rule(overrides: Partial<Parameters<typeof applyDeliveryFeeRule>[0]> = {}) {
  return {
    id: 'rule_manila_food',
    baseFeeCentavos: 3_900, // ₱39 up to 2km
    includedMeters: 2_000,
    perKilometreCentavos: 1_000, // ₱10/km beyond
    minimumFeeCentavos: 3_900,
    maximumFeeCentavos: 20_000,
    freeAboveSubtotalCentavos: 100_000,
    smallOrderThresholdCentavos: 15_000,
    smallOrderFeeCentavos: 2_000,
    serviceFeeCentavos: 1_000,
    ...overrides,
  };
}

describe('distance component', () => {
  it('charges only the base fee within the included distance', () => {
    for (const distanceMeters of [0, 500, 1_999, 2_000]) {
      const quote = applyDeliveryFeeRule(rule(), { distanceMeters, subtotalCentavos: 50_000 });
      expect(quote.deliveryFeeCentavos, `at ${distanceMeters}m`).toBe(3_900);
    }
  });

  it('charges beyond the included distance pro rata, not in whole kilometres', () => {
    // A 2.1km trip should not cost what a 3km trip costs.
    const justOver = applyDeliveryFeeRule(rule(), { distanceMeters: 2_100, subtotalCentavos: 50_000 });
    expect(justOver.deliveryFeeCentavos).toBe(4_000); // ₱39 + ₱1

    const threeKm = applyDeliveryFeeRule(rule(), { distanceMeters: 3_000, subtotalCentavos: 50_000 });
    expect(threeKm.deliveryFeeCentavos).toBe(4_900); // ₱39 + ₱10

    expect(justOver.deliveryFeeCentavos).toBeLessThan(threeKm.deliveryFeeCentavos);
  });

  it('rounds to whole centavos', () => {
    const quote = applyDeliveryFeeRule(rule(), { distanceMeters: 2_333, subtotalCentavos: 50_000 });
    expect(Number.isInteger(quote.deliveryFeeCentavos)).toBe(true);
    expect(quote.deliveryFeeCentavos).toBe(3_900 + Math.round((333 / 1_000) * 1_000));
  });

  it('respects the ceiling on a very long trip', () => {
    const quote = applyDeliveryFeeRule(rule(), { distanceMeters: 400_000, subtotalCentavos: 50_000 });
    expect(quote.deliveryFeeCentavos).toBe(20_000);
  });

  it('respects the floor when the base is below the minimum', () => {
    const quote = applyDeliveryFeeRule(
      rule({ baseFeeCentavos: 1_000, minimumFeeCentavos: 3_900 }),
      { distanceMeters: 0, subtotalCentavos: 50_000 },
    );
    expect(quote.deliveryFeeCentavos).toBe(3_900);
  });

  it('treats a negative distance as zero rather than a discount', () => {
    const quote = applyDeliveryFeeRule(rule(), { distanceMeters: -5_000, subtotalCentavos: 50_000 });
    expect(quote.distanceMeters).toBe(0);
    expect(quote.deliveryFeeCentavos).toBe(3_900);
  });
});

describe('the everybody-gets-it free delivery threshold', () => {
  it('waives the fee at or above the threshold', () => {
    const quote = applyDeliveryFeeRule(rule(), { distanceMeters: 8_000, subtotalCentavos: 100_000 });
    expect(quote.deliveryFeeCentavos).toBe(0);
    expect(quote.freeDeliveryFromThreshold).toBe(true);
  });

  it('does not waive it below the threshold', () => {
    const quote = applyDeliveryFeeRule(rule(), { distanceMeters: 8_000, subtotalCentavos: 99_999 });
    expect(quote.deliveryFeeCentavos).toBeGreaterThan(0);
    expect(quote.freeDeliveryFromThreshold).toBe(false);
  });

  it('is disabled when the rule sets no threshold', () => {
    const quote = applyDeliveryFeeRule(
      rule({ freeAboveSubtotalCentavos: null }),
      { distanceMeters: 1_000, subtotalCentavos: 10_000_000 },
    );
    expect(quote.freeDeliveryFromThreshold).toBe(false);
    expect(quote.deliveryFeeCentavos).toBe(3_900);
  });

  it('is distinct from the subscription benefit — this one applies to everybody', () => {
    // No subscription is involved here at all; the rule alone decides.
    const quote = applyDeliveryFeeRule(rule(), { distanceMeters: 1_000, subtotalCentavos: 150_000 });
    expect(quote.deliveryFeeCentavos).toBe(0);
  });
});

describe('small order fee', () => {
  it('applies below the threshold', () => {
    const quote = applyDeliveryFeeRule(rule(), { distanceMeters: 1_000, subtotalCentavos: 14_999 });
    expect(quote.smallOrderFeeCentavos).toBe(2_000);
  });

  it('does not apply at the threshold', () => {
    const quote = applyDeliveryFeeRule(rule(), { distanceMeters: 1_000, subtotalCentavos: 15_000 });
    expect(quote.smallOrderFeeCentavos).toBe(0);
  });

  it('is disabled when the rule sets no threshold', () => {
    const quote = applyDeliveryFeeRule(
      rule({ smallOrderThresholdCentavos: null }),
      { distanceMeters: 1_000, subtotalCentavos: 100 },
    );
    expect(quote.smallOrderFeeCentavos).toBe(0);
  });

  it('still applies when delivery itself is free', () => {
    // The two thresholds are independent; a free delivery does not forgive a
    // tiny basket. (With the seeded rule they cannot both fire, so force it.)
    const quote = applyDeliveryFeeRule(
      rule({ freeAboveSubtotalCentavos: 10_000, smallOrderThresholdCentavos: 20_000 }),
      { distanceMeters: 1_000, subtotalCentavos: 15_000 },
    );
    expect(quote.deliveryFeeCentavos).toBe(0);
    expect(quote.smallOrderFeeCentavos).toBe(2_000);
  });
});

describe('geo', () => {
  it('measures a known Manila distance within tolerance', () => {
    // Sampaloc to Kalayaan Ave, roughly 700m as the crow flies.
    const meters = haversineMeters(14.6152, 120.9899, 14.6091, 120.9884);
    expect(meters).toBeGreaterThan(500);
    expect(meters).toBeLessThan(900);
  });

  it('returns zero for the same point', () => {
    expect(haversineMeters(14.6, 120.98, 14.6, 120.98)).toBe(0);
  });

  it('is symmetric', () => {
    const there = haversineMeters(14.6152, 120.9899, 10.3157, 123.8854);
    const back = haversineMeters(10.3157, 123.8854, 14.6152, 120.9899);
    expect(there).toBeCloseTo(back, 6);
  });
});
