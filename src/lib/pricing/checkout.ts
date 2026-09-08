import {
  SubscriptionStatus,
  type ServiceKey,
  type SubscriptionBenefit,
} from '@prisma/client';
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
} from '@/lib/pricing/benefits';

export type { AppliedBenefitLine } from '@/lib/pricing/benefits';

/**
 * Checkout pricing.
 *
 * Orchestration only: it reads the Service registry, the customer's active
 * subscription and their credits balance, then hands the arithmetic to the pure
 * `applyBenefits`. Splitting it this way is what lets the benefit rules be
 * tested exhaustively without a database.
 *
 * No service-key branch appears here or in `benefits.ts`. Scoping is data.
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
  walletCreditAppliedCentavos: number;
  totalCentavos: number;
  /** Credits to grant once the order completes. Not deducted from the total. */
  creditBackCentavos: number;
  appliedBenefits: AppliedBenefitLine[];
  /** Which subscription produced the benefits, for the receipt. */
  subscriptionId: string | null;
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

  const subscription = await getActiveSubscription(input.customerId);

  const usageByBenefitId = new Map<string, BenefitUsageSnapshot>();
  if (subscription) {
    const usageRows = await prisma.subscriptionBenefitUsage.findMany({
      where: {
        userSubscriptionId: subscription.id,
        periodStart: currentPeriodStart(),
      },
    });
    for (const row of usageRows) {
      usageByBenefitId.set(row.benefitId, {
        usageCount: row.usageCount,
        creditedCentavos: row.creditedCentavos,
      });
    }
  }

  const { outcome, subscriptionBenefitsDropped } = bestOutcome({
    serviceType: input.serviceType,
    fees,
    benefits: subscription?.plan.benefits ?? [],
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
    walletCreditAppliedCentavos,
    totalCentavos: outcome.payableCentavos - walletCreditAppliedCentavos,
    creditBackCentavos: outcome.creditBackCentavos,
    appliedBenefits: outcome.appliedBenefits,
    subscriptionId: subscription?.id ?? null,
    subscriptionBenefitsDropped,
    spendableCreditsCentavos,
  };
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
 */
function bestOutcome(input: {
  serviceType: ServiceKey;
  fees: FeeInputs;
  benefits: readonly SubscriptionBenefit[];
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
 */
export async function commitBenefitUsage(
  input: {
    subscriptionId: string;
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

      await tx.orderAppliedBenefit.create({
        data: {
          orderId: input.orderId,
          benefitId: line.benefitId,
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
