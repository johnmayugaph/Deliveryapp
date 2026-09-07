import { BenefitType, type ServiceKey, type SubscriptionBenefit } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { formatCentavos } from '@/lib/money';

/**
 * Reading plans and describing what they contain.
 *
 * The plan card is built from the benefit ROWS, not from a hardcoded feature
 * list. `displayLabel` is the marketing line and the pricing engine never reads
 * it; the mechanics under it — the minimum order, the monthly cap, the ceiling —
 * are read off the same columns the engine uses, so a card cannot promise
 * something the engine will not honour.
 *
 * No service-key branch appears here either. A benefit scoped to a vertical
 * names it in `serviceKeys`, and this file resolves those keys through the
 * registry for display.
 */

export type PlanWithBenefits = Awaited<ReturnType<typeof getLaunchedPlan>>;

const planInclude = {
  benefits: { orderBy: { sortOrder: 'asc' } },
} as const;

/**
 * The plan a customer may enroll in right now, or null.
 *
 * `isActive` is the launch switch, and it is the only launch switch: the pricing
 * engine, this reader and the enrollment layer all gate on it, so flipping one
 * boolean turns the tier on everywhere with no deploy. Nothing else in the app
 * decides whether subscriptions exist.
 */
export async function getLaunchedPlan() {
  return prisma.subscriptionPlan.findFirst({
    where: { isActive: true },
    orderBy: { sortOrder: 'asc' },
    include: planInclude,
  });
}

/**
 * A plan by slug regardless of `isActive` — for the admin script that flips the
 * switch, which necessarily has to find a plan that is still off.
 */
export async function getPlanBySlug(slug: string) {
  return prisma.subscriptionPlan.findUnique({
    where: { slug },
    include: planInclude,
  });
}

/** Every plan, launched or not. The activation script lists these. */
export async function listAllPlans() {
  return prisma.subscriptionPlan.findMany({
    orderBy: { sortOrder: 'asc' },
    include: planInclude,
  });
}

/**
 * The mechanics of a benefit, in the customer's language, derived from its
 * columns.
 *
 * Each line is a promise the pricing engine actually keeps — `minimumOrderCentavos`
 * is the same column `applyBenefits` compares the subtotal against. A benefit
 * type that gains a column gains a line here, and the switch is exhaustive so
 * the compiler says so.
 */
export function benefitTerms(
  benefit: Pick<
    SubscriptionBenefit,
    | 'type'
    | 'percentBasisPoints'
    | 'minimumOrderCentavos'
    | 'monthlyUsageCap'
    | 'maxDiscountCentavos'
    | 'monthlyCeilingCentavos'
  >,
): string[] {
  const terms: string[] = [];
  switch (benefit.type) {
    case BenefitType.FREE_DELIVERY:
      if (benefit.minimumOrderCentavos !== null) {
        terms.push(`Minimum order ${formatCentavos(benefit.minimumOrderCentavos)}`);
      }
      terms.push(
        benefit.monthlyUsageCap === null
          ? 'Walang limitasyon kada buwan'
          : `${benefit.monthlyUsageCap}x kada buwan`,
      );
      break;
    case BenefitType.DISCOUNT_PERCENT:
      if (benefit.percentBasisPoints !== null) {
        terms.push(`${formatBasisPoints(benefit.percentBasisPoints)} off`);
      }
      if (benefit.maxDiscountCentavos !== null) {
        terms.push(`Hanggang ${formatCentavos(benefit.maxDiscountCentavos)} kada order`);
      }
      break;
    case BenefitType.CREDIT_BACK_PERCENT:
      if (benefit.percentBasisPoints !== null) {
        terms.push(`${formatBasisPoints(benefit.percentBasisPoints)} pabalik na credits`);
      }
      if (benefit.monthlyCeilingCentavos !== null) {
        terms.push(`Hanggang ${formatCentavos(benefit.monthlyCeilingCentavos)} kada buwan`);
      }
      terms.push('Dumarating pagkatapos ng order');
      break;
  }
  return terms;
}

/** 1250 → "12.5%", 500 → "5%". */
export function formatBasisPoints(basisPoints: number): string {
  const percent = basisPoints / 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;
}

/**
 * Which services a benefit applies to, for display. An empty `serviceKeys`
 * means every active service, which is a different sentence from a list of one.
 */
export function benefitScopeLabel(
  benefit: Pick<SubscriptionBenefit, 'serviceKeys'>,
  displayNameByKey: ReadonlyMap<ServiceKey, string>,
): string {
  if (benefit.serviceKeys.length === 0) {
    return 'Lahat ng service';
  }
  return benefit.serviceKeys
    .map((key) => displayNameByKey.get(key) ?? key)
    .join(', ');
}
