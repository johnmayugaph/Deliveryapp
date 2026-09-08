import { OrderStatus } from '@prisma/client';
import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import {
  REFUSAL_TEXT,
  codeLooksPlausible,
  normalisePromoCode,
  resolvePromo,
  type PromoFacts,
  type PromoOrderFacts,
  type PromoQuote,
  type PromoUsageFacts,
} from '@/lib/promo/policy';

/**
 * Reading a code and working out what it takes off.
 *
 * The split that matters: **resolving is free and consuming is not.**
 *
 * A quote runs on every keystroke at checkout. If resolving consumed a use, a
 * customer who typed a code and then changed their address would have burned
 * it — which is exactly the mistake `commitBenefitUsage` exists to avoid for a
 * subscription's monthly allowance, and the comment there says so. So this
 * module only reads. `consumePromoCode` in `consume.ts` is the other half, and
 * it runs inside the placement transaction.
 *
 * Usage is COUNTED from `PromoRedemption` every time, never read from a cached
 * counter on the code. A cached count is a second truth, and the moment it
 * drifts a code either stops working early or keeps working past its budget —
 * with nobody able to say which.
 */

/** A resolved promo, plus what it took to resolve it. */
export interface ResolvedPromo extends PromoQuote {
  /** The code as normalised, echoed back so a caller can store it. */
  code: string;
  /** Null when no code matched at all. */
  promoId: string | null;
}

const NO_CODE: ResolvedPromo = {
  code: '',
  promoId: null,
  discountCentavos: 0,
  label: null,
  refusal: null,
  stacksWithSubscription: true,
};

/** Loads a code by its normalised form, or null. */
export async function findPromoCode(
  raw: string,
  client?: PrismaTransactionClient,
): Promise<PromoFacts | null> {
  const code = normalisePromoCode(raw);
  // A code that cannot be a code is not looked up. A round trip cannot fix a
  // typo, and this is a public field somebody may hammer.
  if (!codeLooksPlausible(code)) return null;

  const db = client ?? prisma;
  const row = await db.promoCode.findUnique({ where: { code } });
  return row;
}

/** How the code has been used, counted. */
export async function usageFor(
  promoId: string,
  client?: PrismaTransactionClient,
): Promise<PromoUsageFacts> {
  const db = client ?? prisma;
  const aggregate = await db.promoRedemption.aggregate({
    where: { promoCodeId: promoId },
    _count: { _all: true },
    _sum: { discountCentavos: true },
  });
  return {
    redemptions: aggregate._count._all,
    spentCentavos: aggregate._sum.discountCentavos ?? 0,
  };
}

/**
 * Resolves a code against a cart. Reads only; consumes nothing.
 *
 * An absent or empty code is not a refusal — it is the ordinary case of
 * somebody not using one — so it comes back with no discount and no message
 * rather than an error the checkout screen would have to suppress.
 */
export async function resolvePromoForOrder(
  input: {
    code: string | null | undefined;
    customerId: string;
    order: PromoOrderFacts;
  },
  client?: PrismaTransactionClient,
  now: Date = new Date(),
): Promise<ResolvedPromo> {
  if (!input.code || input.code.trim().length === 0) return NO_CODE;

  const db = client ?? prisma;
  const promo = await findPromoCode(input.code, db);
  const code = normalisePromoCode(input.code);

  if (!promo) {
    // Deliberately the same answer as expired, exhausted and switched off. See
    // the note in `policy.ts`: distinguishing them turns this field into an
    // oracle for finding real codes.
    return {
      ...NO_CODE,
      code,
      refusal: 'UNAVAILABLE',
    };
  }

  const [usage, completedOrderCount, timesUsed] = await Promise.all([
    usageFor(promo.id, db),
    // A COMPLETED order, not any order: somebody whose only order was
    // cancelled has never been served, so a first-order code should still
    // work for them.
    db.order.count({
      where: { customerId: input.customerId, status: OrderStatus.COMPLETED },
    }),
    db.promoRedemption.count({
      where: { promoCodeId: promo.id, userId: input.customerId },
    }),
  ]);

  const quote = resolvePromo({
    promo,
    order: input.order,
    customer: { completedOrderCount, timesUsed },
    usage,
    now,
  });

  return { ...quote, code, promoId: promo.id };
}

/** The sentence for a refusal, or null when there is nothing to say. */
export function messageFor(resolved: ResolvedPromo): string | null {
  return resolved.refusal === null ? null : REFUSAL_TEXT[resolved.refusal];
}
