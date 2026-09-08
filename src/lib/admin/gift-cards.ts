import { prisma } from '@/lib/prisma';
import { giftCardStatus, type GiftCardStatus } from '@/lib/gift-cards/policy';

/**
 * The console's view of the gift cards.
 *
 * One number carries this screen: **what is still outstanding.** A gift card
 * is the first thing in this app that puts spendable money in the hands of a
 * bearer — a referral needs somebody to sign up and order, loyalty needs
 * somebody to have ordered, a promo code needs an order at checkout — so the
 * face value of every card that has been printed and not yet redeemed is a
 * real liability sitting on paper we no longer control.
 *
 * Unlike the loyalty liability it has no natural ceiling except the one we
 * choose per card, and unlike a promo campaign it cannot be switched off in
 * aggregate: each card has to be cancelled individually, and only while it is
 * unredeemed.
 */

export interface GiftCardRow {
  id: string;
  reference: string;
  amountCentavos: number;
  status: GiftCardStatus;
  issuedReason: string;
  note: string | null;
  expiresAt: Date | null;
  createdAt: Date;

  issuedByName: string | null;
  redeemedAt: Date | null;
  redeemedByName: string | null;
  redeemedByPhone: string | null;
  voidedAt: Date | null;
  voidedByName: string | null;
  voidReason: string | null;
}

export interface GiftCardOverview {
  cards: GiftCardRow[];
  /** Face value of every card still redeemable. The figure that matters. */
  outstandingCentavos: number;
  outstandingCount: number;
  /** Cards that lapsed unredeemed — money we promised and nobody claimed. */
  expiredCentavos: number;
  expiredCount: number;
  redeemedCentavos: number;
  redeemedCount: number;
  issuedThisMonthCentavos: number;
}

/** First instant of the current calendar month, UTC. */
function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

const named = (user: { fullName: string | null; displayName: string | null } | null) =>
  user?.displayName ?? user?.fullName ?? null;

export async function giftCardOverview(
  now: Date = new Date(),
): Promise<GiftCardOverview> {
  const [rows, outstanding, thisMonth] = await Promise.all([
    prisma.giftCard.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        issuedBy: { select: { fullName: true, displayName: true } },
        redeemedBy: { select: { fullName: true, displayName: true, phone: true } },
        voidedBy: { select: { fullName: true, displayName: true } },
      },
    }),
    // The outstanding total comes from a QUERY rather than from the page of
    // rows above: the list is capped at 200 for the screen's sake, and a
    // liability computed from a truncated list would quietly understate itself
    // the day somebody issues the 201st card.
    prisma.giftCard.aggregate({
      where: {
        redeemedAt: null,
        voidedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      _sum: { amountCentavos: true },
      _count: { _all: true },
    }),
    prisma.giftCard.aggregate({
      where: { createdAt: { gte: monthStart(now) } },
      _sum: { amountCentavos: true },
    }),
  ]);

  const [expired, redeemed] = await Promise.all([
    prisma.giftCard.aggregate({
      where: { redeemedAt: null, voidedAt: null, expiresAt: { lte: now } },
      _sum: { amountCentavos: true },
      _count: { _all: true },
    }),
    prisma.giftCard.aggregate({
      where: { redeemedAt: { not: null } },
      _sum: { amountCentavos: true },
      _count: { _all: true },
    }),
  ]);

  const cards: GiftCardRow[] = rows.map((row) => ({
    id: row.id,
    reference: row.reference,
    amountCentavos: row.amountCentavos,
    // Derived through the same function the customer's redemption uses, so the
    // console and the refusal can never disagree about what state a card is
    // in.
    status: giftCardStatus(row, now),
    issuedReason: row.issuedReason,
    note: row.note,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    issuedByName: named(row.issuedBy),
    redeemedAt: row.redeemedAt,
    redeemedByName: named(row.redeemedBy),
    redeemedByPhone: row.redeemedBy?.phone ?? null,
    voidedAt: row.voidedAt,
    voidedByName: named(row.voidedBy),
    voidReason: row.voidReason,
  }));

  return {
    cards,
    outstandingCentavos: outstanding._sum.amountCentavos ?? 0,
    outstandingCount: outstanding._count._all,
    expiredCentavos: expired._sum.amountCentavos ?? 0,
    expiredCount: expired._count._all,
    redeemedCentavos: redeemed._sum.amountCentavos ?? 0,
    redeemedCount: redeemed._count._all,
    issuedThisMonthCentavos: thisMonth._sum.amountCentavos ?? 0,
  };
}
