import { BenefitSource, SubscriptionStatus, type ServiceKey } from '@prisma/client';
import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import { assertNonNegativeInteger, CURRENCY } from '@/lib/money';
import { assertServiceOrderable } from '@/lib/services/registry';
import { getSpendableCentavos } from '@/lib/wallet/ledger';
import {
  applyBenefits,
  type AppliedBenefitLine,
  type BenefitOutcome,
  type BenefitUsageSnapshot,
  type FeeInputs,
  type SourcedBenefit,
} from '@/lib/pricing/benefits';
import { tierBenefitsForUser } from '@/lib/loyalty/programme';
import { billBenefitsOf } from '@/lib/loyalty/tier-benefits';

export type { AppliedBenefitLine } from '@/lib/pricing/benefits';

/**
 * Checkout pricing.
 *
 * Orchestration only: it reads the Service registry, the customer's active
 * subscription, their loyalty tier and their credits balance, then hands the
 * arithmetic to the pure `applyBenefits`. Splitting it this way is what lets
 * the benefit rules be tested exhaustively without a database.
 *
 * No service-key branch appears here or in `benefits.ts`. Scoping is data.
 *
 * ### Two things confer benefits, and one engine prices them
 *
 * A subscription plan and a loyalty tier both carry benefit rows of the same
 * three types with the same columns, and both come through `applyBenefits`
 * tagged with their source. What this module decides is the ORDER they are
 * offered in, which matters in exactly one case and is documented at
 * `sourcedBenefitsFor`.
 */

export interface PriceQuoteInput {
  serviceType: ServiceKey;
  customerId: string;
  cityId?: string;
  subtotalCentavos: number;
  baseDeliveryFeeCentavos: number;
  serviceFeeCentavos?: number;
  smallOrderFeeCentavos?: number;
  surgeCentavos?: number;
  tipCentavos?: number;
  /** Voucher/campaign discount, already resolved by the caller. */
  promoDiscountCentavos?: number;
  /**
   * False when the promo code refuses to be combined with a subscription's
   * benefits. Defaults to true, which is what a caller with no code should
   * pass. See `bestOutcome` for what "does not stack" actually resolves to —
   * it is not "drop the plan".
   */
  promoStacksWithSubscription?: boolean;
  /** How much of the credits balance the customer asked to spend. */
  requestedWalletCreditCentavos?: number;
}

export interface PriceQuote {
  serviceType: ServiceKey;
  currency: string;
  subtotalCentavos: number;
  deliveryFeeCentavos: number;
  serviceFeeCentavos: number;
  smallOrderFeeCentavos: number;
  surgeCentavos: number;
  tipCentavos: number;
  promoDiscountCentavos: number;
  subscriptionDiscountCentavos: number;
  /** Taken off by a loyalty tier's benefits, never mixed with the line above. */
  loyaltyDiscountCentavos: number;
  walletCreditAppliedCentavos: number;
  totalCentavos: number;
  /** Credits to grant once the order completes. Not deducted from the total. */
  creditBackCentavos: number;
  appliedBenefits: AppliedBenefitLine[];
  /** Which subscription produced the benefits, for the receipt. */
  subscriptionId: string | null;
  /** The tier that produced any loyalty benefits, for the checkout screen. */
  loyaltyTierName: string | null;
  /**
   * True when a non-stacking promo code beat the customer's plan and their
   * benefits were set aside for this order. The checkout screen says so —
   * a subscriber whose free delivery quietly vanished deserves the sentence.
   */
  subscriptionBenefitsDropped: boolean;
  /** Credits available but not spent, so the UI can offer them. */
  spendableCreditsCentavos: number;
}

/** First instant of the current calendar month, UTC. Benefit caps reset here. */
export function currentPeriodStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** The customer's live subscription, with its plan's structured benefits. */
export async function getActiveSubscription(userId: string) {
  return prisma.userSubscription.findFirst({
    where: {
      userId,
      status: SubscriptionStatus.ACTIVE,
      renewsAt: { gt: new Date() },
      endedAt: null,
      // An inactive plan grants nothing, even to someone already on it. This is
      // what makes the seeded plan safe to leave in place until we launch it.
      plan: { isActive: true },
    },
    include: { plan: { include: { benefits: true } } },
    orderBy: { startedAt: 'desc' },
  });
}

/**
 * Produces a full price breakdown for a prospective order.
 *
 * Reads but never writes. Committing benefit usage happens in
 * `commitBenefitUsage` once the order exists, so an abandoned checkout does not
 * burn someone's monthly free deliveries.
 */
export async function quoteOrderPrice(input: PriceQuoteInput): Promise<PriceQuote> {
  assertNonNegativeInteger(input.subtotalCentavos, 'subtotalCentavos');
  assertNonNegativeInteger(input.baseDeliveryFeeCentavos, 'baseDeliveryFeeCentavos');

  // Registry check first: never quote a price for a vertical we cannot serve.
  await assertServiceOrderable(input.serviceType, input.cityId);

  const fees = {
    subtotalCentavos: input.subtotalCentavos,
    deliveryFeeCentavos: input.baseDeliveryFeeCentavos,
    serviceFeeCentavos: input.serviceFeeCentavos ?? 0,
    smallOrderFeeCentavos: input.smallOrderFeeCentavos ?? 0,
    surgeCentavos: input.surgeCentavos ?? 0,
    tipCentavos: input.tipCentavos ?? 0,
    promoDiscountCentavos: input.promoDiscountCentavos ?? 0,
  };

  const periodStart = currentPeriodStart();
  const [subscription, loyalty] = await Promise.all([
    getActiveSubscription(input.customerId),
    tierBenefitsForUser(input.customerId),
  ]);

  const usageByBenefitId = new Map<string, BenefitUsageSnapshot>();
  if (subscription) {
    const usageRows = await prisma.subscriptionBenefitUsage.findMany({
      where: { userSubscriptionId: subscription.id, periodStart },
    });
    for (const row of usageRows) {
      usageByBenefitId.set(row.benefitId, {
        usageCount: row.usageCount,
        creditedCentavos: row.creditedCentavos,
      });
    }
  }

  const tierBillBenefits = billBenefitsOf(loyalty.benefits);
  if (tierBillBenefits.length > 0) {
    // The tier's own caps, counted against the PERSON — a tier is not a row
    // somebody pays for, so there is no subscription to hang the month on.
    const usageRows = await prisma.loyaltyBenefitUsage.findMany({
      where: {
        userId: input.customerId,
        tierBenefitId: { in: tierBillBenefits.map((benefit) => benefit.id) },
        periodStart,
      },
    });
    for (const row of usageRows) {
      // One map keyed by benefit id, shared by both kinds. Ids are cuids from
      // two tables and cannot collide; if they ever could, this map would
      // silently give one benefit another's allowance.
      usageByBenefitId.set(row.tierBenefitId, {
        usageCount: row.usageCount,
        creditedCentavos: row.creditedCentavos,
      });
    }
  }

  const { outcome, subscriptionBenefitsDropped } = bestOutcome({
    serviceType: input.serviceType,
    fees,
    benefits: sourcedBenefitsFor({
      planBenefits: subscription?.plan.benefits ?? [],
      tierBenefits: tierBillBenefits,
    }),
    usageByBenefitId,
    stacks: input.promoStacksWithSubscription ?? true,
  });

  // Credits last: capped at what is actually owed, so a balance can zero a bill
  // but never create a payable of less than nothing.
  const spendableCreditsCentavos = await getSpendableCentavos(input.customerId);
  const requested = Math.max(0, input.requestedWalletCreditCentavos ?? 0);
  const walletCreditAppliedCentavos = Math.min(
    requested,
    spendableCreditsCentavos,
    outcome.payableCentavos,
  );

  return {
    serviceType: input.serviceType,
    currency: CURRENCY,
    subtotalCentavos: fees.subtotalCentavos,
    deliveryFeeCentavos: outcome.deliveryFeeCentavos,
    serviceFeeCentavos: fees.serviceFeeCentavos,
    smallOrderFeeCentavos: fees.smallOrderFeeCentavos,
    surgeCentavos: fees.surgeCentavos,
    tipCentavos: fees.tipCentavos,
    promoDiscountCentavos: outcome.promoDiscountCentavos,
    subscriptionDiscountCentavos: outcome.subscriptionDiscountCentavos,
    loyaltyDiscountCentavos: outcome.loyaltyDiscountCentavos,
    walletCreditAppliedCentavos,
    totalCentavos: outcome.payableCentavos - walletCreditAppliedCentavos,
    creditBackCentavos: outcome.creditBackCentavos,
    appliedBenefits: outcome.appliedBenefits,
    subscriptionId: subscription?.id ?? null,
    loyaltyTierName: outcome.loyaltyDiscountCentavos > 0 || outcome.appliedBenefits.some(
      (line) => line.source === BenefitSource.LOYALTY_TIER,
    )
      ? loyalty.tier?.name ?? null
      : null,
    subscriptionBenefitsDropped,
    spendableCreditsCentavos,
  };
}

/**
 * Both sets of benefits, in the order they should be offered.
 *
 * **The tier's go first, and that is the only thing this order decides.**
 * `applyBenefits` waives delivery once, taking the first benefit that
 * applies — so a customer who is both a Plus subscriber and a Tapat gets one
 * waiver and only one monthly allowance is spent. Whose it is is this
 * function's choice.
 *
 * It spends the TIER's. The subscriber PAID for their four free deliveries a
 * month; the tier's are a gift. Spending the gift first leaves the thing they
 * bought intact for later in the month, which is the outcome a customer would
 * choose if anybody asked them. Spending the paid allowance first would mean a
 * subscriber's own benefit quietly subsidising a benefit they would have had
 * anyway.
 *
 * Note it changes no total. Both waive the same fee; only the allowance
 * consumed differs, and only later in the month does that show up.
 */
export function sourcedBenefitsFor(input: {
  planBenefits: readonly SourcedBenefit['benefit'][];
  tierBenefits: readonly SourcedBenefit['benefit'][];
}): SourcedBenefit[] {
  return [
    ...input.tierBenefits.map((benefit) => ({
      benefit,
      source: BenefitSource.LOYALTY_TIER,
    })),
    ...input.planBenefits.map((benefit) => ({
      benefit,
      source: BenefitSource.SUBSCRIPTION,
    })),
  ];
}

/**
 * Applies benefits, honouring a promo code that refuses to stack.
 *
 * The naive reading of "does not stack" is: drop the plan's benefits, keep the
 * code. That reading makes the app punish the customer who pays us every
 * month. A Plus subscriber with free delivery types a ₱20 code, loses a ₱49
 * waiver, and pays ₱29 MORE than if they had typed nothing at all — and
 * nobody would ever explain that to them, because nobody would notice. The
 * screen would show a discount line and a bigger total.
 *
 * So both bills are priced and the cheaper one wins. When the plan wins, the
 * code is not applied at all: `promoDiscountCentavos` comes back zero, which
 * is the signal `placeOrder` uses to leave the code unspent. The customer's
 * one allowed use and the campaign's budget both survive to be used somewhere
 * they actually help.
 *
 * Credit-back counts at face value in the comparison. It is not money off
 * this bill — the rest of this module is careful about that distinction — but
 * it is centavos in the ledger, spendable on the next order, and valuing it at
 * zero would trade a ₱50 credit for a ₱21 discount.
 *
 * A tie goes to the subscription, for the same reason: it leaves the code
 * unspent.
 *
 * **A loyalty tier's benefits are in the same comparison and set aside
 * together with the plan's.** A non-stacking code says "not with your
 * benefits", and a customer's tier benefits are benefits — pricing them
 * alongside the code would be reading the code's own condition selectively.
 * The customer still gets whichever bill is cheaper, which is the point of
 * the comparison; `subscriptionBenefitsDropped` is what the screen says, and
 * it is accurate for a subscriber and a shade broad for somebody who only has
 * a tier. Naming that: it is the price of one flag rather than two, and the
 * sentence it produces ("your benefits were set aside for this order") is
 * true either way.
 */
function bestOutcome(input: {
  serviceType: ServiceKey;
  fees: FeeInputs;
  benefits: readonly SourcedBenefit[];
  usageByBenefitId: ReadonlyMap<string, BenefitUsageSnapshot>;
  stacks: boolean;
}): { outcome: BenefitOutcome; subscriptionBenefitsDropped: boolean } {
  const { serviceType, fees, benefits, usageByBenefitId } = input;

  const both = () => applyBenefits({ serviceType, fees, benefits, usageByBenefitId });

  // Nothing to choose between: no code, no plan, or a code happy to stack.
  if (input.stacks || fees.promoDiscountCentavos === 0 || benefits.length === 0) {
    return { outcome: both(), subscriptionBenefitsDropped: false };
  }

  const promoOnly = applyBenefits({
    serviceType,
    fees,
    benefits: [],
    usageByBenefitId,
  });
  const planOnly = applyBenefits({
    serviceType,
    fees: { ...fees, promoDiscountCentavos: 0 },
    benefits,
    usageByBenefitId,
  });

  const netCost = (outcome: BenefitOutcome) =>
    outcome.payableCentavos - outcome.creditBackCentavos;

  if (netCost(promoOnly) < netCost(planOnly)) {
    return { outcome: promoOnly, subscriptionBenefitsDropped: true };
  }
  return { outcome: planOnly, subscriptionBenefitsDropped: false };
}

/**
 * Records that a quote's benefits were actually consumed. Called once, after the
 * order row exists.
 *
 * Split out from `quoteOrderPrice` on purpose: quoting happens on every
 * keystroke in checkout, and a quote must never burn a monthly allowance.
 *
 * Writes to one of two usage tables per line, chosen by the line's source. A
 * tier benefit's allowance is counted against the USER because a tier is not a
 * row anybody pays for — see `LoyaltyBenefitUsage` in the schema.
 */
export async function commitBenefitUsage(
  input: {
    /**
     * Null when the customer has no plan and every applied line came from
     * their tier. Required as soon as one SUBSCRIPTION line is present, and a
     * missing one then is a programming error rather than a state to absorb:
     * silently skipping it would let a subscriber's monthly allowance never be
     * spent, which nobody would notice until the free deliveries never ran out.
     */
    subscriptionId: string | null;
    customerId: string;
    orderId: string;
    appliedBenefits: readonly AppliedBenefitLine[];
  },
  options: { now?: Date; client?: PrismaTransactionClient } = {},
): Promise<void> {
  if (input.appliedBenefits.length === 0) {
    return;
  }
  const periodStart = currentPeriodStart(options.now ?? new Date());

  const run = async (tx: PrismaTransactionClient) => {
    for (const line of input.appliedBenefits) {
      if (line.source === BenefitSource.LOYALTY_TIER) {
        await tx.loyaltyBenefitUsage.upsert({
          where: {
            userId_tierBenefitId_periodStart: {
              userId: input.customerId,
              tierBenefitId: line.benefitId,
              periodStart,
            },
          },
          create: {
            userId: input.customerId,
            tierBenefitId: line.benefitId,
            periodStart,
            usageCount: 1,
            creditedCentavos: line.creditBackCentavos,
            discountedCentavos: line.amountCentavos,
          },
          update: {
            usageCount: { increment: 1 },
            creditedCentavos: { increment: line.creditBackCentavos },
            discountedCentavos: { increment: line.amountCentavos },
          },
        });
      } else {
        if (input.subscriptionId === null) {
          throw new Error(
            'commitBenefitUsage: a SUBSCRIPTION benefit line arrived with no ' +
              'subscription id. The quote and the commit disagree about where ' +
              "this order's benefits came from.",
          );
        }
        await tx.subscriptionBenefitUsage.upsert({
          where: {
            userSubscriptionId_benefitId_periodStart: {
              userSubscriptionId: input.subscriptionId,
              benefitId: line.benefitId,
              periodStart,
            },
          },
          create: {
            userSubscriptionId: input.subscriptionId,
            benefitId: line.benefitId,
            periodStart,
            usageCount: 1,
            creditedCentavos: line.creditBackCentavos,
            discountedCentavos: line.amountCentavos,
          },
          update: {
            usageCount: { increment: 1 },
            creditedCentavos: { increment: line.creditBackCentavos },
            discountedCentavos: { increment: line.amountCentavos },
          },
        });
      }

      // One receipt line either way, pointing at whichever table it came from.
      // `source` is stored rather than inferred from which id is null, so a
      // line whose benefit row is later deleted still knows what it was.
      await tx.orderAppliedBenefit.create({
        data: {
          orderId: input.orderId,
          source: line.source,
          benefitId:
            line.source === BenefitSource.SUBSCRIPTION ? line.benefitId : null,
          tierBenefitId:
            line.source === BenefitSource.LOYALTY_TIER ? line.benefitId : null,
          type: line.type,
          displayLabel: line.displayLabel,
          amountCentavos: line.amountCentavos,
          creditBackCentavos: line.creditBackCentavos,
        },
      });
    }
  };

  // Compose into the caller's transaction when given one, so placing an order
  // and consuming its benefits cannot half-succeed.
  if (options.client) {
    await run(options.client);
    return;
  }
  await prisma.$transaction(run);
}
