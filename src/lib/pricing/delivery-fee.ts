import type { DeliveryFeeRule, ServiceKey } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { haversineMeters } from '@/lib/geo';

/**
 * Distance-based delivery pricing.
 *
 * Every number comes from a `DeliveryFeeRule` row — this module contains no
 * rates of its own, so tuning a fee is a database edit rather than a deploy.
 * The arithmetic is pure and separated from the lookup, the same split as the
 * subscription benefits, so the rounding and the thresholds are testable.
 */

export class NoDeliveryFeeRuleError extends Error {
  constructor(readonly serviceType: ServiceKey, readonly cityId: string) {
    super(
      `No delivery fee rule for service "${serviceType}" in city "${cityId}". ` +
        'Refusing to quote rather than guess a rate.',
    );
    this.name = 'NoDeliveryFeeRuleError';
  }
}

export interface DeliveryQuote {
  distanceMeters: number;
  deliveryFeeCentavos: number;
  serviceFeeCentavos: number;
  smallOrderFeeCentavos: number;
  /** True when the subtotal cleared `freeAboveSubtotalCentavos`. */
  freeDeliveryFromThreshold: boolean;
  ruleId: string;
}

/**
 * Applies a rule to a distance and a subtotal.
 *
 * Beyond the included distance, the per-kilometre rate is charged **pro rata**
 * rather than in whole-kilometre steps — a 2.1km trip should not cost the same
 * as a 3km one.
 */
export function applyDeliveryFeeRule(
  rule: Pick<
    DeliveryFeeRule,
    | 'id'
    | 'baseFeeCentavos'
    | 'includedMeters'
    | 'perKilometreCentavos'
    | 'minimumFeeCentavos'
    | 'maximumFeeCentavos'
    | 'freeAboveSubtotalCentavos'
    | 'smallOrderThresholdCentavos'
    | 'smallOrderFeeCentavos'
    | 'serviceFeeCentavos'
  >,
  input: { distanceMeters: number; subtotalCentavos: number },
): DeliveryQuote {
  const distanceMeters = Math.max(0, Math.round(input.distanceMeters));

  const chargeableMeters = Math.max(0, distanceMeters - rule.includedMeters);
  const distanceComponent = Math.round(
    (chargeableMeters / 1_000) * rule.perKilometreCentavos,
  );

  let deliveryFeeCentavos = rule.baseFeeCentavos + distanceComponent;
  deliveryFeeCentavos = Math.max(deliveryFeeCentavos, rule.minimumFeeCentavos);
  if (rule.maximumFeeCentavos !== null) {
    deliveryFeeCentavos = Math.min(deliveryFeeCentavos, rule.maximumFeeCentavos);
  }

  // The everybody-gets-it threshold, distinct from the subscription benefit.
  const freeDeliveryFromThreshold =
    rule.freeAboveSubtotalCentavos !== null &&
    input.subtotalCentavos >= rule.freeAboveSubtotalCentavos;
  if (freeDeliveryFromThreshold) {
    deliveryFeeCentavos = 0;
  }

  const smallOrderFeeCentavos =
    rule.smallOrderThresholdCentavos !== null &&
    input.subtotalCentavos < rule.smallOrderThresholdCentavos
      ? rule.smallOrderFeeCentavos
      : 0;

  return {
    distanceMeters,
    deliveryFeeCentavos,
    serviceFeeCentavos: rule.serviceFeeCentavos,
    smallOrderFeeCentavos,
    freeDeliveryFromThreshold,
    ruleId: rule.id,
  };
}

/**
 * The rule that applies to a service in a city: the city-specific row if there
 * is one, otherwise the service's fallback row (`cityId: null`).
 */
export async function findDeliveryFeeRule(
  serviceType: ServiceKey,
  cityId: string,
): Promise<DeliveryFeeRule | null> {
  const rules = await prisma.deliveryFeeRule.findMany({
    where: {
      serviceType,
      isActive: true,
      OR: [{ cityId }, { cityId: null }],
    },
  });

  // A city-specific rule always beats the fallback.
  return rules.find((rule) => rule.cityId === cityId) ?? rules.find((r) => r.cityId === null) ?? null;
}

/** Quotes delivery for a pickup/dropoff pair. Throws rather than guessing. */
export async function quoteDeliveryFee(input: {
  serviceType: ServiceKey;
  cityId: string;
  subtotalCentavos: number;
  pickup: { latitude: number; longitude: number };
  dropoff: { latitude: number; longitude: number };
}): Promise<DeliveryQuote> {
  const rule = await findDeliveryFeeRule(input.serviceType, input.cityId);
  if (!rule) {
    throw new NoDeliveryFeeRuleError(input.serviceType, input.cityId);
  }

  const distanceMeters = haversineMeters(
    input.pickup.latitude,
    input.pickup.longitude,
    input.dropoff.latitude,
    input.dropoff.longitude,
  );

  return applyDeliveryFeeRule(rule, {
    distanceMeters,
    subtotalCentavos: input.subtotalCentavos,
  });
}
