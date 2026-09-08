import {
  PaymentMethod,
  SettlementEntryType,
  SettlementParty,
} from '@prisma/client';

/**
 * Who is owed what, and who is holding whose money.
 *
 * Pure — imports nothing but types, so it is testable without a database and
 * safe to import from a client component. (Five features have now had a page
 * 500 by reaching `next/headers` through a chain that started in a module like
 * this one; hence the rule and the guard test.)
 *
 * The two ideas that carry the file:
 *
 *   1. **Every centavo of an order is assigned to exactly one party.**
 *      `splitOrderValue` divides the gross between the store, the rider and
 *      the platform, and asserts the result rather than trusting it: the three
 *      shares must sum to the gross and none may be negative. A settlement
 *      feature whose parts do not sum is one that quietly loses somebody's
 *      money, and "quietly" is the problem.
 *   2. **The direction depends on who physically collected.** On a cash order
 *      the rider took the whole total at the door, so they end up owing TARA;
 *      on a prepaid order TARA owes them. Same ledger, opposite sign, and
 *      pretending otherwise is how a rider gets paid twice.
 */

/** What the customer's money is worth before any discount is applied. */
export interface OrderMoney {
  subtotalCentavos: number;
  deliveryFeeCentavos: number;
  serviceFeeCentavos: number;
  smallOrderFeeCentavos: number;
  surgeCentavos: number;
  tipCentavos: number;
  /** What the customer actually paid, after discounts and credits. */
  totalCentavos: number;
}

/**
 * Every way the customer paid less than the gross, which TARA absorbed.
 *
 * This sum used to live inline in `accrueOrderSettlement`, and it was the only
 * copy — which was fine until a shop's own screen needed to tell it what the
 * platform had covered on an order. A second copy of this expression is a
 * screen that can disagree with what settlement actually paid, and the
 * disagreement would surface as a shop being told a number that does not
 * match its balance.
 *
 * Every one of these reduces what the CUSTOMER paid and none of them reduce
 * the shop's subtotal or the rider's fee. Credits are in here for the same
 * reason as the discounts: TARA granted them, so spending them is TARA's cost.
 *
 * A test reads the `Order` model and asserts every discount-shaped column is
 * named here, because a fifth one added and forgotten would silently come out
 * of a partner's pay.
 */
export interface OrderAbsorbed {
  promoDiscountCentavos: number;
  subscriptionDiscountCentavos: number;
  loyaltyDiscountCentavos: number;
  walletCreditAppliedCentavos: number;
}

export function platformAbsorbedCentavos(order: OrderAbsorbed): number {
  return (
    order.promoDiscountCentavos +
    order.subscriptionDiscountCentavos +
    order.loyaltyDiscountCentavos +
    order.walletCreditAppliedCentavos
  );
}

/**
 * The gross value of an order: what it is worth to everybody together, before
 * TARA gives any of it away.
 *
 * Deliberately NOT `totalCentavos`. A subscription that waives a delivery fee,
 * a promo, and credits spent all reduce what the CUSTOMER pays without
 * reducing what the shop cooked or what the rider rode. TARA absorbs the
 * difference, and settlement has to be computed on the gross or the absorption
 * silently comes out of a partner's pay.
 */
export function grossOrderCentavos(order: OrderMoney): number {
  return (
    order.subtotalCentavos +
    order.deliveryFeeCentavos +
    order.serviceFeeCentavos +
    order.smallOrderFeeCentavos +
    order.surgeCentavos +
    order.tipCentavos
  );
}

/** Basis points of the subtotal that TARA keeps. 250 = 2.5%. */
export const MAX_COMMISSION_BASIS_POINTS = 5_000;

export class InvalidCommissionError extends Error {
  constructor(readonly basisPoints: number) {
    super(
      `A commission of ${basisPoints} basis points is not a rate this app will ` +
        `store. Whole basis points from 0 to ${MAX_COMMISSION_BASIS_POINTS} ` +
        '(half the food) — anything more is a typo, not a deal.',
    );
    this.name = 'InvalidCommissionError';
  }
}

export function assertCommissionInRange(basisPoints: number): void {
  if (
    !Number.isInteger(basisPoints) ||
    basisPoints < 0 ||
    basisPoints > MAX_COMMISSION_BASIS_POINTS
  ) {
    throw new InvalidCommissionError(basisPoints);
  }
}

/**
 * TARA's cut of the food.
 *
 * Rounded DOWN, so a fraction of a centavo stays with the shop rather than
 * with us. That is the right direction for a rounding rule nobody will ever
 * audit: over thousands of orders it costs TARA a few pesos and it can never
 * be described as shaving money off a partner.
 */
export function commissionCentavos(
  subtotalCentavos: number,
  basisPoints: number,
): number {
  assertCommissionInRange(basisPoints);
  if (subtotalCentavos <= 0) return 0;
  return Math.floor((subtotalCentavos * basisPoints) / 10_000);
}

/** Every centavo of an order, by who it belongs to. */
export interface OrderSplit {
  /** The food, less commission. */
  storeCentavos: number;
  /** The delivery fee and the whole tip. */
  riderCentavos: number;
  /** Fees, surge and commission. Absorbs every discount TARA gave away. */
  platformCentavos: number;
  /** The three above, summed. Equals `grossOrderCentavos`. */
  grossCentavos: number;
  /** What TARA gave away: promos, subscription waivers, credits spent. */
  discountedCentavos: number;
  /** Platform share less what it gave away. Negative on a loss-making order. */
  platformNetCentavos: number;
}

export class SettlementDoesNotBalanceError extends Error {
  constructor(readonly detail: string) {
    super(`Settlement does not balance: ${detail}`);
    this.name = 'SettlementDoesNotBalanceError';
  }
}

/**
 * Divides an order between the shop, the rider and TARA.
 *
 * The rider's share comes from `partnerEarningsCentavos`, passed in rather
 * than recomputed, because the fleet screens already show a partner that
 * number and two functions computing "what the rider earns" is how the app
 * ends up promising one figure and settling another. If the rule changes —
 * surge going to riders, say, which is arguable — it changes in one place and
 * both follow.
 *
 * Then the platform gets **the remainder**, not its own formula. That is the
 * whole trick: defining the last share as what is left makes the split
 * exhaustive by construction, so no future fee can be introduced and silently
 * belong to nobody. The assertion below is a belt on top of that.
 */
export function splitOrderValue(input: {
  order: OrderMoney;
  /** From `partnerEarningsCentavos`. Zero for an order nobody delivered. */
  riderCentavos: number;
  commissionBasisPoints: number;
  /** Promo, subscription waiver and credits, which TARA absorbs. */
  discountedCentavos: number;
}): OrderSplit {
  const grossCentavos = grossOrderCentavos(input.order);
  const commission = commissionCentavos(
    input.order.subtotalCentavos,
    input.commissionBasisPoints,
  );

  const storeCentavos = input.order.subtotalCentavos - commission;
  const riderCentavos = input.riderCentavos;
  const platformCentavos = grossCentavos - storeCentavos - riderCentavos;

  const sum = storeCentavos + riderCentavos + platformCentavos;
  if (sum !== grossCentavos) {
    // Unreachable while `platformCentavos` is the remainder, and kept because
    // the day somebody gives the platform its own formula is the day this
    // stops being unreachable.
    throw new SettlementDoesNotBalanceError(
      `${storeCentavos} + ${riderCentavos} + ${platformCentavos} = ${sum}, expected ${grossCentavos}`,
    );
  }
  // No share may be negative, the platform's included. A sum can balance
  // while one part is negative — pay a rider more than the order is worth and
  // the platform silently absorbs the difference as a negative share — so
  // "balances" is not enough on its own. The platform's share is the one that
  // would absorb it, which is exactly why it has to be checked: it is the
  // remainder, and a remainder never complains.
  if (storeCentavos < 0 || riderCentavos < 0 || platformCentavos < 0) {
    throw new SettlementDoesNotBalanceError(
      `no share may be negative (store ${storeCentavos}, rider ${riderCentavos}, ` +
        `platform ${platformCentavos}) — a rider paid more than the order is ` +
        'worth would otherwise net out against us without a word',
    );
  }

  return {
    storeCentavos,
    riderCentavos,
    platformCentavos,
    grossCentavos,
    discountedCentavos: input.discountedCentavos,
    platformNetCentavos: platformCentavos - input.discountedCentavos,
  };
}

/** Who ends up holding the customer's money. */
export type Collector = 'RIDER' | 'PLATFORM';

/**
 * Who physically has the cash once the order is done.
 *
 * Keyed by every method, so a new instrument is a compile error here rather
 * than a default that puts somebody else's money in the wrong pocket.
 */
export const COLLECTED_BY: Readonly<Record<PaymentMethod, Collector>> = {
  // The rider takes the whole total at the door, so they are holding the
  // shop's money and ours until they remit it.
  [PaymentMethod.CASH_ON_DELIVERY]: 'RIDER',
  // Arrived in our account before the shop was told.
  [PaymentMethod.MANUAL_TRANSFER]: 'PLATFORM',
  // Nothing was collected from anybody: the customer spent credits we granted.
  // The shop and the rider are still owed real money, and it comes from us —
  // which is precisely what a credit costs, recognised at redemption.
  [PaymentMethod.WALLET_CREDIT]: 'PLATFORM',
};

export function collectorFor(method: PaymentMethod): Collector {
  return COLLECTED_BY[method];
}

/**
 * Which direction each entry moves a partner's balance.
 *
 * A balance is what TARA OWES the partner. Callers pass a magnitude and the
 * sign comes from here — the same rule the credits and payment ledgers follow,
 * because a caller who picks the sign can book a payout as an earning and
 * nobody notices until a partner complains.
 */
export const ENTRY_DIRECTION: Readonly<Record<SettlementEntryType, -1 | 1>> = {
  [SettlementEntryType.ORDER_EARNINGS]: 1,
  [SettlementEntryType.CASH_REMITTED]: 1,
  [SettlementEntryType.REFERRAL_BONUS]: 1,
  [SettlementEntryType.CASH_COLLECTED]: -1,
  [SettlementEntryType.PAYOUT_SENT]: -1,
  // Signed by the caller, and the only type that is. An admin correction
  // legitimately goes either way.
  [SettlementEntryType.ADJUSTMENT]: 1,
};

export class InvalidSettlementEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSettlementEntryError';
  }
}

export function signedSettlementAmount(
  type: SettlementEntryType,
  amountCentavos: number,
): number {
  if (!Number.isInteger(amountCentavos)) {
    throw new InvalidSettlementEntryError(
      `Settlement amounts must be whole centavos, got ${amountCentavos}`,
    );
  }
  if (amountCentavos === 0) {
    throw new InvalidSettlementEntryError(
      'A settlement entry of zero centavos means nothing',
    );
  }

  if (type === SettlementEntryType.ADJUSTMENT) {
    return amountCentavos;
  }

  if (amountCentavos < 0) {
    throw new InvalidSettlementEntryError(
      `Pass a magnitude, not a signed amount: ${type} has a fixed direction`,
    );
  }

  return ENTRY_DIRECTION[type] * amountCentavos;
}

/** Types a person has to justify, because each asserts something off-system. */
export const REFERENCE_REQUIRED_TYPES: readonly SettlementEntryType[] = [
  SettlementEntryType.PAYOUT_SENT,
  SettlementEntryType.CASH_REMITTED,
  SettlementEntryType.ADJUSTMENT,
];

export function referenceIsRequired(type: SettlementEntryType): boolean {
  return REFERENCE_REQUIRED_TYPES.includes(type);
}

/**
 * Types the system writes itself, with no human asserting anything.
 *
 * These are the ones that need no actor and no reference: nobody claimed
 * anything happened in the real world, so there is nothing to make checkable.
 */
export const ACCRUAL_TYPES: readonly SettlementEntryType[] = [
  SettlementEntryType.ORDER_EARNINGS,
  SettlementEntryType.CASH_COLLECTED,
  SettlementEntryType.REFERRAL_BONUS,
];

export function isAccrual(type: SettlementEntryType): boolean {
  return ACCRUAL_TYPES.includes(type);
}

/**
 * Types that arise from ONE order and must name it.
 *
 * This used to be the same list as `ACCRUAL_TYPES`, and splitting them is what
 * `REFERRAL_BONUS` forced. A bonus is an accrual — the system writes it, no
 * person claims it — and it has no order, because it arises from a delivery
 * made by somebody ELSE. Putting that order on the referrer's statement line
 * would tell them they earned it on a job they never rode.
 *
 * The delivery that qualified it is on the `PartnerReferral` row, which is
 * where the two can be tied together.
 */
export const ORDER_DERIVED_TYPES: readonly SettlementEntryType[] = [
  SettlementEntryType.ORDER_EARNINGS,
  SettlementEntryType.CASH_COLLECTED,
];

export function arisesFromOneOrder(type: SettlementEntryType): boolean {
  return ORDER_DERIVED_TYPES.includes(type);
}

/** A partner's position, summed from their entries. */
export interface Position {
  /** Positive: TARA owes them. Negative: they are holding TARA's money. */
  balanceCentavos: number;
  earnedCentavos: number;
  collectedCentavos: number;
  paidOutCentavos: number;
  remittedCentavos: number;
  /**
   * Invite bonuses. Kept OUT of `earnedCentavos` deliberately: a rider
   * comparing what they earned against the jobs they rode should not find a
   * bonus mixed into the total, and an operator looking at what riding costs
   * should not find recruitment in it either.
   */
  bonusCentavos: number;
}

export function positionFrom(
  entries: readonly { type: SettlementEntryType; amountCentavos: number }[],
): Position {
  let balanceCentavos = 0;
  let earnedCentavos = 0;
  let collectedCentavos = 0;
  let paidOutCentavos = 0;
  let remittedCentavos = 0;
  let bonusCentavos = 0;

  for (const entry of entries) {
    balanceCentavos += entry.amountCentavos;
    switch (entry.type) {
      case SettlementEntryType.ORDER_EARNINGS:
        earnedCentavos += entry.amountCentavos;
        break;
      case SettlementEntryType.CASH_COLLECTED:
        collectedCentavos += -entry.amountCentavos;
        break;
      case SettlementEntryType.PAYOUT_SENT:
        paidOutCentavos += -entry.amountCentavos;
        break;
      case SettlementEntryType.CASH_REMITTED:
        remittedCentavos += entry.amountCentavos;
        break;
      case SettlementEntryType.REFERRAL_BONUS:
        bonusCentavos += entry.amountCentavos;
        break;
      case SettlementEntryType.ADJUSTMENT:
        // Counted in the balance and in no category. An adjustment is by
        // definition the case the categories did not anticipate, and filing it
        // under one of them would make that category a lie.
        break;
    }
  }

  return {
    balanceCentavos,
    earnedCentavos,
    collectedCentavos,
    paidOutCentavos,
    remittedCentavos,
    bonusCentavos,
  };
}

/**
 * The most a payout to this partner may be.
 *
 * Never more than we owe. Paying beyond the balance is not generosity, it is
 * an unrecorded loan that the next accrual silently swallows — and on a rider
 * with a negative balance it would be handing money to somebody who is already
 * holding ours.
 */
export function payableCentavos(position: Position): number {
  return Math.max(0, position.balanceCentavos);
}

/** What a rider still has to hand over. The float the business worries about. */
export function owedToPlatformCentavos(position: Position): number {
  return Math.max(0, -position.balanceCentavos);
}

/** Which side of the console a partner belongs on. */
export function settlementSideFor(
  position: Position,
): 'WE_OWE' | 'THEY_OWE' | 'SQUARE' {
  if (position.balanceCentavos > 0) return 'WE_OWE';
  if (position.balanceCentavos < 0) return 'THEY_OWE';
  return 'SQUARE';
}

/** What a partner is told, in their own terms. */
export function describePosition(
  position: Position,
  party: SettlementParty,
): string {
  const side = settlementSideFor(position);
  if (side === 'SQUARE') return 'You are square with TARA.';
  if (side === 'WE_OWE') return 'This is what TARA owes you.';
  return party === SettlementParty.FLEET_PARTNER
    ? 'This is cash you collected that belongs to TARA and the stores. Hand it in.'
    : 'This is money owed back to TARA.';
}

/** Human label for a ledger line. */
export const ENTRY_LABEL: Readonly<Record<SettlementEntryType, string>> = {
  [SettlementEntryType.ORDER_EARNINGS]: 'Earned',
  [SettlementEntryType.CASH_COLLECTED]: 'Cash you collected',
  [SettlementEntryType.PAYOUT_SENT]: 'Paid to you',
  [SettlementEntryType.CASH_REMITTED]: 'Cash handed in',
  // Not "Earned": a rider reading their statement should be able to tell the
  // ₱500 they got for bringing a friend from the ₱500 they got for riding.
  [SettlementEntryType.REFERRAL_BONUS]: 'Invite bonus',
  [SettlementEntryType.ADJUSTMENT]: 'Adjustment',
};

/**
 * Labels that read wrong for one party, overridden for that party.
 *
 * There is exactly one so far, and it is worth the machinery. A rider was
 * invited: they typed a code into an application. A shop was not — its
 * introduction was a conversation somebody at TARA recorded, and its own
 * referral panel says *"There is no code to share"* in as many words. A line
 * reading "Invite bonus" directly above that names a thing the same screen
 * has just said does not exist.
 *
 * Same money, same entry type, one different word. Found in a browser, on the
 * shop's own statement.
 */
const ENTRY_LABEL_BY_PARTY: Readonly<
  Partial<Record<SettlementParty, Partial<Record<SettlementEntryType, string>>>>
> = {
  [SettlementParty.STORE]: {
    [SettlementEntryType.REFERRAL_BONUS]: 'Referral bonus',
  },
};

/**
 * The label to show one party for one kind of line.
 *
 * Falls back to `ENTRY_LABEL` for every pair with no override, so a new entry
 * type needs no entry here and a new party inherits the general wording.
 */
export function entryLabel(
  type: SettlementEntryType,
  party?: SettlementParty,
): string {
  return (
    (party ? ENTRY_LABEL_BY_PARTY[party]?.[type] : undefined) ??
    ENTRY_LABEL[type]
  );
}

/**
 * The heading over a party's total bonuses, for the tile on their own screen.
 *
 * The plural of `entryLabel(REFERRAL_BONUS, party)` in every case so far, but
 * kept as its own function rather than a naive `+ 'es'`: the two words differ
 * in their plural ("Invite bonuses", "Referral bonuses") only by accident,
 * and a third party's wording should not be produced by string surgery on a
 * label written for somebody else.
 */
export function bonusTotalLabel(party: SettlementParty): string {
  return party === SettlementParty.STORE
    ? 'Referral bonuses'
    : 'Invite bonuses';
}
