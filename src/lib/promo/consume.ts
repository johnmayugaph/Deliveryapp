import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import { resolvePromoForOrder } from '@/lib/promo/resolve';
import type { PromoOrderFacts } from '@/lib/promo/policy';

/**
 * Spending a use of a code, at the moment an order is placed.
 *
 * The other half of the split described in `resolve.ts`. This runs INSIDE the
 * placement transaction — which is already `Serializable`, because it touches
 * the credits ledger — and that is what makes the caps hold.
 *
 * Consider a code with a hundred uses and two hundred people at checkout. Every
 * one of them has a valid quote; the caps can only be enforced where the orders
 * are actually created, one at a time, against a count that cannot be stale.
 * Doing it anywhere else is how a campaign goes over its budget and nobody can
 * say when.
 *
 * ### Why it re-resolves rather than trusting the quote
 *
 * The discount that reaches this function is not the one the client sent, and
 * not even the one the quote computed a moment ago: it is recomputed here from
 * the code's rules and the order's own numbers. A client that could name its
 * own discount would be a client that could name its own price.
 */

export class PromoNoLongerValidError extends Error {
  constructor(
    readonly code: string,
    readonly reason: string,
  ) {
    super(
      `The code ${code} could not be applied: ${reason} ` +
        'Check the new total and place the order again.',
    );
    this.name = 'PromoNoLongerValidError';
  }
}

export interface ConsumedPromo {
  promoId: string;
  code: string;
  label: string;
  discountCentavos: number;
}

/**
 * Re-resolves and records the use. Returns null when no code was offered.
 *
 * Throws `PromoNoLongerValidError` when a code that was valid at quote time is
 * not valid now — a cap reached, a budget spent, a window closed while
 * somebody was choosing. Refusing is the only honest option: silently charging
 * the full price would be the app quoting one number and taking another, which
 * is the failure the surge work is arranged against as well.
 *
 * It also refuses when the code is still valid but worth LESS than the order
 * was priced at. That happens when a concurrent placement ate into a shared
 * budget, and it is the same refusal for the same reason: the two alternatives
 * are charging the customer more than the screen showed, or handing out a
 * discount the campaign's budget does not cover and cannot account for. The
 * customer re-quotes and sees the smaller figure. Under `Serializable` these
 * placements are ordered, so this is rare rather than routine.
 */
export async function consumePromoCode(
  input: {
    code: string | null | undefined;
    customerId: string;
    orderId: string;
    order: PromoOrderFacts;
    /**
     * What the order was actually priced with, from the caller's own re-quote.
     *
     * Never a client-supplied number: `placeOrder` passes
     * `quote.price.promoDiscountCentavos`, which it computed server-side
     * moments earlier, and it is checked below against a discount this
     * function resolves for itself: a figure LARGER than the code can justify
     * refuses rather than being recorded.
     */
    appliedCentavos: number;
  },
  tx: PrismaTransactionClient,
  now: Date = new Date(),
): Promise<ConsumedPromo | null> {
  if (!input.code || input.code.trim().length === 0) return null;

  const resolved = await resolvePromoForOrder(
    { code: input.code, customerId: input.customerId, order: input.order },
    tx,
    now,
  );

  if (resolved.refusal !== null || resolved.promoId === null) {
    throw new PromoNoLongerValidError(
      resolved.code,
      resolved.refusal === 'UNAVAILABLE'
        ? 'it is no longer available.'
        : 'it does not apply to this order.',
    );
  }

  if (resolved.discountCentavos < input.appliedCentavos) {
    throw new PromoNoLongerValidError(
      resolved.code,
      'it does not take off as much as it did a moment ago.',
    );
  }

  // The APPLIED figure, not the resolved one. They differ when the combined
  // discounts were clamped to what the order is worth, and what a campaign
  // cost us is what came off a bill — not what a rule offered. A receipt that
  // disagrees with the ledger is a receipt somebody has to reconcile by hand.
  const discountCentavos = input.appliedCentavos;

  // One redemption per order, ever — the unique index on `orderId` is what
  // makes a retried placement idempotent rather than double-counting a use
  // against the campaign's cap.
  await tx.promoRedemption.create({
    data: {
      promoCodeId: resolved.promoId,
      userId: input.customerId,
      orderId: input.orderId,
      discountCentavos,
    },
  });

  return {
    promoId: resolved.promoId,
    code: resolved.code,
    label: resolved.label ?? resolved.code,
    discountCentavos,
  };
}

/** Usage for the console, counted per code. */
export async function usageByCode(): Promise<
  Map<string, { redemptions: number; spentCentavos: number }>
> {
  const rows = await prisma.promoRedemption.groupBy({
    by: ['promoCodeId'],
    _count: { _all: true },
    _sum: { discountCentavos: true },
  });
  return new Map(
    rows.map((row) => [
      row.promoCodeId,
      {
        redemptions: row._count._all,
        spentCentavos: row._sum.discountCentavos ?? 0,
      },
    ]),
  );
}
