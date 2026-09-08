import { BenefitSource } from '@prisma/client';
import {
  platformAbsorbedCentavos,
  type OrderAbsorbed,
} from '@/lib/settlement/policy';

/**
 * What a FINISHED order can honestly tell a shop about a customer's benefits.
 *
 * The Regulars tab makes an aggregate claim — a status costs the shop nothing.
 * This is what makes that claim checkable one order at a time, which is worth
 * far more than a green box: a shop can pick the order it remembers and see
 * that the discount on it came out of TARA's share.
 *
 * ### What a past order knows, and what it cannot
 *
 * A customer's tier is DERIVED, from points earned in a rolling window. It is
 * not stored on the order. So for an order from three months ago there is no
 * way to say what tier that customer held at the time — and using today's tier
 * would be a fabrication about a receipt.
 *
 * What IS durable is `OrderAppliedBenefit`: it snapshots `displayLabel`,
 * `amountCentavos` and `source` at placement, precisely so a receipt survives
 * the benefit row being edited or deleted. So the honest statement is about
 * the BENEFIT rather than the customer:
 *
 *   - a status benefit applied to this order — provable, from the row;
 *   - it was called this and took off this much — snapshotted;
 *   - it came from this tier — recoverable only while that tier still exists,
 *     because a tier's benefit rows cascade with it. Absent that, the source
 *     is still known and the tier is simply unnamed.
 *
 * An order from a Tapat customer who ordered below the free-delivery minimum
 * has no benefit row at all, and this reports nothing for it. That is correct:
 * nothing happened on that order, and the shop's question about it is answered
 * by the aggregate on the other tab.
 *
 * Pure: imports the enum and the settlement sum, nothing else.
 */

/** One benefit that actually applied, as snapshotted on the order. */
export interface AppliedBenefitRow {
  source: BenefitSource;
  displayLabel: string;
  amountCentavos: number;
  /** The tier that conferred it, when the tier still exists. */
  tierName: string | null;
}

/**
 * Where a peso off came from, in the shop's terms.
 *
 * Keyed over the sources a shop can be shown, so a third one cannot be added
 * without deciding what a shop is told about it.
 */
const SOURCE_NOUN: Readonly<Record<BenefitSource, string>> = {
  [BenefitSource.LOYALTY_TIER]: 'a customer status',
  [BenefitSource.SUBSCRIPTION]: 'TARA Plus',
};

export interface OrderBenefitView {
  /** Everything TARA took off what the customer paid, in centavos. */
  absorbedCentavos: number;
  /** The benefit lines, in the order they were applied. */
  lines: AppliedBenefitRow[];
  /**
   * The tiers that conferred something here, named and de-duplicated. Empty
   * when no tier benefit applied, or when the tiers no longer exist.
   */
  tierNames: string[];
  /** True when any line came from a loyalty tier. */
  hasStatusBenefit: boolean;
  /**
   * True when money came off the bill from something with no benefit line —
   * a promo code, or credits spent. Those are recorded on the order's own
   * columns rather than as `OrderAppliedBenefit` rows, so without this the
   * lines would not add up to the total and a shop would be right to wonder.
   */
  hasUnlistedDiscount: boolean;
}

/**
 * What to tell a shop about one finished order.
 *
 * The total comes from `platformAbsorbedCentavos` — the same function
 * settlement uses to work out what it did NOT charge the shop for. Computing
 * it here separately is how a screen comes to disagree with a balance.
 */
export function orderBenefitView(
  order: OrderAbsorbed,
  benefits: readonly AppliedBenefitRow[],
): OrderBenefitView {
  const absorbedCentavos = platformAbsorbedCentavos(order);
  const lines = [...benefits];

  const tierNames = [
    ...new Set(
      lines
        .filter((line) => line.source === BenefitSource.LOYALTY_TIER)
        .map((line) => line.tierName)
        .filter((name): name is string => name !== null),
    ),
  ];

  const listed = lines.reduce((sum, line) => sum + line.amountCentavos, 0);

  return {
    absorbedCentavos,
    lines,
    tierNames,
    hasStatusBenefit: lines.some(
      (line) => line.source === BenefitSource.LOYALTY_TIER,
    ),
    hasUnlistedDiscount: absorbedCentavos > listed,
  };
}

/** How a single line reads to a shop. */
export function describeBenefitLine(line: AppliedBenefitRow): string {
  const from =
    line.source === BenefitSource.LOYALTY_TIER && line.tierName !== null
      ? line.tierName
      : SOURCE_NOUN[line.source];
  return `${line.displayLabel} · ${from}`;
}

/**
 * The sentence for money off that has no benefit line behind it.
 *
 * Two wordings, because a browser caught the one-wording version saying
 * &ldquo;The rest was a promo code&rdquo; on an order that had no benefit lines
 * at all — where there was no rest, that was the whole of it. A shop reading
 * &ldquo;the rest&rdquo; with nothing above it would reasonably look for the
 * part that was missing.
 */
export function unlistedDiscountNote(hasListedLines: boolean): string {
  return hasListedLines
    ? 'The rest was a promo code or credits the customer had.'
    : 'That was a promo code or credits the customer had.';
}

/**
 * The one sentence this whole feature exists to let a shop verify.
 *
 * Deliberately the same claim as the Regulars tab, in the same words, because
 * a shop reading two different phrasings of it would reasonably wonder whether
 * they mean two different things.
 */
export const ABSORBED_NOTE =
  'TARA covered this. Your share is the full food subtotal less your usual commission, exactly as if there had been no discount.';
