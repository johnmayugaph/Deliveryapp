import { TierBenefitType } from '@prisma/client';
import {
  dispatchPriorityFor,
  type TierBenefitFacts,
} from '@/lib/loyalty/tier-benefits';

/**
 * What a loyalty tier means to the shop cooking the food.
 *
 * A shop's interest in the tier ladder is narrow and specific, and it is not
 * the customer's interest. A customer wants to know what they get; a shop
 * wants to know two things:
 *
 *   1. **Does this come out of my money?** For every benefit in this app the
 *      answer is no — `accrueOrderSettlement` pays the shop its subtotal less
 *      the same commission whatever discounts the customer had — and that is
 *      worth saying out loud, because a shop cannot verify it from an order
 *      card that shows only a subtotal. The suspicion that the platform's
 *      generosity is being funded out of the shop's margin is the reasonable
 *      first guess, and nowhere in the app currently answers it.
 *
 *   2. **Does it change what happens in my kitchen?** For one benefit the
 *      answer is yes. DISPATCH_PRIORITY reorders the rider fan-out, and that
 *      queue is global: a suki's order can be offered a rider ahead of an
 *      equally old order, including this shop's own next one.
 *
 * So the ladder is presented to a shop in exactly those two groups, and the
 * mapping is compile enforced over the whole enum — a seventh benefit type
 * cannot be added without somebody deciding which of these a shop is told.
 *
 * Pure: imports the benefit types and the priority reader, nothing else.
 */

/** Which of the shop's two questions a benefit is an answer to. */
export type MerchantRelevance =
  /** Reduces what the customer pays. Never reduces what the shop is paid. */
  | 'PLATFORM_PAYS'
  /** Changes the order the shop's food is collected in. */
  | 'AFFECTS_THE_KITCHEN'
  /** Nothing a shop can see or act on. Deliberately not shown. */
  | 'NOT_THE_SHOPS_CONCERN';

/**
 * Where each benefit falls, for a shop.
 *
 * The three bill benefits are all PLATFORM_PAYS for the same reason and it is
 * the settlement split, not a policy stated here: the discount is subtracted
 * from the customer's total and from the platform's share, and the store entry
 * is computed from `subtotalCentavos` and the commission alone.
 *
 * SUPPORT_PRIORITY and POINTS_NEVER_EXPIRE are between TARA and the customer.
 * Listing them would pad a screen a shop owner reads between orders with two
 * lines they can do nothing with, which is how a screen stops being read.
 */
export const MERCHANT_RELEVANCE: Readonly<
  Record<TierBenefitType, MerchantRelevance>
> = {
  [TierBenefitType.FREE_DELIVERY]: 'PLATFORM_PAYS',
  [TierBenefitType.DISCOUNT_PERCENT]: 'PLATFORM_PAYS',
  [TierBenefitType.CREDIT_BACK_PERCENT]: 'PLATFORM_PAYS',
  [TierBenefitType.DISPATCH_PRIORITY]: 'AFFECTS_THE_KITCHEN',
  [TierBenefitType.SUPPORT_PRIORITY]: 'NOT_THE_SHOPS_CONCERN',
  [TierBenefitType.POINTS_NEVER_EXPIRE]: 'NOT_THE_SHOPS_CONCERN',
};

/**
 * How a benefit reads to a shop.
 *
 * Written from the shop's side of the counter, which is a different sentence
 * from the customer's even for the same row. The customer's screen says "free
 * delivery four times a month"; a shop does not care about the allowance, it
 * cares that the waived fee was never its fee.
 */
const MERCHANT_BENEFIT_LINE: Readonly<Record<TierBenefitType, string>> = {
  [TierBenefitType.FREE_DELIVERY]:
    'Delivery is free for them. The fee was never yours — it goes to the rider, ' +
    'and TARA covers it.',
  [TierBenefitType.DISCOUNT_PERCENT]:
    'They get a percentage off. It comes off TARA’s share, not off your food.',
  [TierBenefitType.CREDIT_BACK_PERCENT]:
    'They earn credits back after the order. Nothing is taken off this bill at all.',
  [TierBenefitType.DISPATCH_PRIORITY]:
    'Their order is offered to riders as though it had been placed earlier, so ' +
    'it is collected sooner.',
  [TierBenefitType.SUPPORT_PRIORITY]:
    'Their support messages are answered sooner. Between them and TARA.',
  [TierBenefitType.POINTS_NEVER_EXPIRE]:
    'Their points do not expire. Between them and TARA.',
};

export interface MerchantBenefitLine {
  type: TierBenefitType;
  relevance: MerchantRelevance;
  line: string;
}

/** A tier, as a shop needs to read it. */
export interface MerchantTierView {
  tierId: string;
  name: string;
  thresholdPoints: number;
  /** What the platform pays for on this tier's orders. */
  platformPays: MerchantBenefitLine[];
  /** What changes in the kitchen. Empty on most tiers. */
  affectsTheKitchen: MerchantBenefitLine[];
  /**
   * How many minutes of head start this tier's orders get in the rider
   * fan-out. Zero when the tier confers no dispatch priority.
   */
  dispatchHeadStartMinutes: number;
}

export interface TierLadderRow {
  id: string;
  name: string;
  thresholdPoints: number;
  benefits: readonly TierBenefitFacts[];
}

/**
 * Turns the ladder into what a shop sees.
 *
 * Tiers that confer nothing a shop is told about are dropped rather than
 * listed empty: a row saying a tier exists and does nothing visible here is
 * noise, and the shop's own numbers panel already says how many of its orders
 * come from tier customers.
 */
export function merchantTierViews(
  ladder: readonly TierLadderRow[],
): MerchantTierView[] {
  return ladder
    .map((tier) => {
      const lines = tier.benefits.map((benefit) => ({
        type: benefit.type,
        relevance: MERCHANT_RELEVANCE[benefit.type],
        line: MERCHANT_BENEFIT_LINE[benefit.type],
      }));

      return {
        tierId: tier.id,
        name: tier.name,
        thresholdPoints: tier.thresholdPoints,
        platformPays: lines.filter((row) => row.relevance === 'PLATFORM_PAYS'),
        affectsTheKitchen: lines.filter(
          (row) => row.relevance === 'AFFECTS_THE_KITCHEN',
        ),
        // Read through the same function the fan-out uses, so the number on
        // this screen is the number that actually orders the queue — including
        // its ceiling. A screen promising a head start the dispatcher then
        // clamps would be worse than showing nothing.
        dispatchHeadStartMinutes: dispatchPriorityFor(tier.benefits),
      };
    })
    .filter(
      (view) =>
        view.platformPays.length > 0 || view.affectsTheKitchen.length > 0,
    )
    .sort((a, b) => a.thresholdPoints - b.thresholdPoints);
}

/**
 * Below this many completed orders, the share is shown as a fraction rather
 * than a percentage.
 *
 * A shop with three orders was being told "67%", which is arithmetically
 * correct and reads as a finding. Two of three is two of three; one more order
 * either way moves that figure by thirty points, and a number that volatile
 * presented as a percentage invites a shop to conclude something about its
 * business that the data cannot support.
 */
export const MIN_ORDERS_FOR_A_SHARE = 20;

/** Whether the share is worth stating as a percentage at all. */
export function shareIsMeaningful(totalOrders: number): boolean {
  return totalOrders >= MIN_ORDERS_FOR_A_SHARE;
}

/**
 * Does any tier reorder the rider queue?
 *
 * The dispatch-priority explanation is the one paragraph on the screen that
 * describes something being taken as well as given, and putting it in front of
 * a shop whose customers get no such thing would be inventing a worry.
 */
export function anyTierJumpsTheQueue(
  views: readonly MerchantTierView[],
): boolean {
  return views.some((view) => view.dispatchHeadStartMinutes > 0);
}
