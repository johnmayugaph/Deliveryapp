import { LoyaltyEntryType } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getProgramme, tierForUser } from '@/lib/loyalty/programme';
import { nextExpiryFor } from '@/lib/loyalty/expiry';
import {
  largestRedemption,
  pointsValueCentavos,
  programmeIsLive,
  type ProgrammeFacts,
  type RedemptionQuote,
  type TierFacts,
} from '@/lib/loyalty/policy';

/** Everything the customer's points screen shows. */
export interface PointsSummary {
  programme: ProgrammeFacts;
  isLive: boolean;
  points: number;
  /** What that balance is worth, so the screen never shows points alone. */
  valueCentavos: number;
  /** The largest whole-block redemption available, for the one-tap control. */
  offer: RedemptionQuote;
  current: TierFacts | null;
  next: TierFacts | null;
  pointsToNext: number;
  earnedInWindow: number;
  nextExpiry: { points: number; at: Date } | null;
  history: {
    id: string;
    type: LoyaltyEntryType;
    points: number;
    description: string;
    createdAt: Date;
  }[];
}

/**
 * One customer's points standing.
 *
 * The value in pesos is computed alongside the points and never omitted. A
 * screen that says "1,437 points" and nothing else asks the customer to do the
 * programme's arithmetic for it, and the answer they guess will be wrong in
 * whichever direction disappoints them.
 */
export async function pointsSummary(
  userId: string,
  now: Date = new Date(),
): Promise<PointsSummary> {
  const programme = await getProgramme();
  const isLive = programmeIsLive(programme);

  const account = await prisma.loyaltyAccount.findUnique({
    where: { userId },
    select: { id: true, pointsBalance: true },
  });

  const [tier, history, nextExpiry] = await Promise.all([
    tierForUser(userId, now),
    account
      ? prisma.loyaltyEntry.findMany({
          where: { accountId: account.id },
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: {
            id: true,
            type: true,
            points: true,
            description: true,
            createdAt: true,
          },
        })
      : Promise.resolve([]),
    account ? nextExpiryFor(account.id, now) : Promise.resolve(null),
  ]);

  const points = account?.pointsBalance ?? 0;

  return {
    programme,
    isLive,
    points,
    valueCentavos: pointsValueCentavos(programme, points),
    offer: largestRedemption(programme, points),
    current: tier.current,
    next: tier.next,
    pointsToNext: tier.pointsToNext,
    earnedInWindow: tier.earnedInWindow,
    nextExpiry,
    history,
  };
}
