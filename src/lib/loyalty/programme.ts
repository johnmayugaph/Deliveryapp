import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import {
  PROGRAMME_OFF,
  tierFor,
  tierWindowStart,
  type ProgrammeFacts,
  type TierFacts,
} from '@/lib/loyalty/policy';
import { LoyaltyEntryType } from '@prisma/client';

/** Always this. One row, enforced by `loyalty_programme_singleton`. */
export const PROGRAMME_ID = 'default';

/**
 * The programme, or OFF.
 *
 * Absent means off, which is the shipped state: a points programme is a
 * liability denominated in the operator's money, and the code has no business
 * choosing its size.
 */
export async function getProgramme(
  client?: PrismaTransactionClient,
): Promise<ProgrammeFacts> {
  const db = client ?? prisma;
  const row = await db.loyaltyProgramme.findUnique({ where: { id: PROGRAMME_ID } });
  if (!row) return PROGRAMME_OFF;
  return {
    isActive: row.isActive,
    pointsPerPesoBasisPoints: row.pointsPerPesoBasisPoints,
    pointsPerPesoRedeemed: row.pointsPerPesoRedeemed,
    redemptionBlockPoints: row.redemptionBlockPoints,
    expiryMonths: row.expiryMonths,
    tierWindowMonths: row.tierWindowMonths,
  };
}

export async function getTiers(
  client?: PrismaTransactionClient,
): Promise<TierFacts[]> {
  const db = client ?? prisma;
  const rows = await db.loyaltyTier.findMany({
    orderBy: { thresholdPoints: 'asc' },
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    thresholdPoints: row.thresholdPoints,
    earnMultiplierBasisPoints: row.earnMultiplierBasisPoints,
    blurb: row.blurb,
  }));
}

/**
 * Points EARNED inside the rolling window, which is what a tier is calculated
 * from.
 *
 * Earned, not the balance. Redeeming must not demote somebody: spending points
 * is the thing the programme wants, and a tier that punished it would teach
 * people to hoard and then teach them the programme is a trick. Expired points
 * still count towards the window they were earned in, for the same reason —
 * the customer did place those orders.
 */
export async function pointsEarnedInWindow(
  userId: string,
  programme: ProgrammeFacts,
  now: Date = new Date(),
  client?: PrismaTransactionClient,
): Promise<number> {
  const db = client ?? prisma;
  const account = await db.loyaltyAccount.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (!account) return 0;

  const earned = await db.loyaltyEntry.aggregate({
    where: {
      accountId: account.id,
      type: LoyaltyEntryType.EARNED,
      createdAt: { gte: tierWindowStart(programme, now) },
    },
    _sum: { points: true },
  });
  return earned._sum.points ?? 0;
}

/** A user's current tier, and how far to the next. */
export async function tierForUser(
  userId: string,
  now: Date = new Date(),
  client?: PrismaTransactionClient,
): Promise<{
  programme: ProgrammeFacts;
  tiers: TierFacts[];
  earnedInWindow: number;
  current: TierFacts | null;
  next: TierFacts | null;
  pointsToNext: number;
}> {
  const programme = await getProgramme(client);
  const [tiers, earnedInWindow] = await Promise.all([
    getTiers(client),
    pointsEarnedInWindow(userId, programme, now, client),
  ]);
  return { programme, tiers, earnedInWindow, ...tierFor(tiers, earnedInWindow) };
}
