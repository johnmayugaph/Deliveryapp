import { LoyaltyEntryType } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getProgramme, getTiers } from '@/lib/loyalty/programme';
import {
  effectiveGivebackBasisPoints,
  outstandingLiabilityCentavos,
  programmeIsLive,
  tierFor,
  tierWindowStart,
  type ProgrammeFacts,
  type TierFacts,
} from '@/lib/loyalty/policy';

/**
 * The console's view of the points programme.
 *
 * The number this screen exists for is `liabilityCentavos`: what the
 * outstanding points would cost if everybody redeemed tomorrow. A points
 * programme is an obligation denominated in the operator's money, and the
 * figure that matters is not how many points exist but what they are worth —
 * which is two rates away from the point count and easy to get wrong by a
 * factor of ten.
 *
 * It sits next to the expiry setting on purpose. With no expiry configured that
 * number only ever goes up.
 */
export interface LoyaltyOverview {
  programme: ProgrammeFacts;
  isLive: boolean;
  tiers: (TierFacts & { holders: number })[];

  /** Points earned, redeemed and expired since the beginning. */
  pointsEarned: number;
  pointsRedeemed: number;
  pointsExpired: number;
  /** Outstanding: what is still held across every account. */
  pointsOutstanding: number;

  /** What the outstanding points would cost in credits, at today's rate. */
  liabilityCentavos: number;
  /** Credits actually granted by redemption, from the credits ledger. */
  redeemedCentavos: number;
  /** Percentage of food value given back, in basis points. */
  givebackBasisPoints: number;

  accountsHoldingPoints: number;
  /** Accounts with a balance too small to ever redeem, and their total. */
  strandedAccounts: number;
  strandedPoints: number;
}

export async function loyaltyOverview(): Promise<LoyaltyOverview> {
  const programme = await getProgramme();

  const [byType, accounts, tiers, redeemedCredits] = await Promise.all([
    prisma.loyaltyEntry.groupBy({ by: ['type'], _sum: { points: true } }),
    prisma.loyaltyAccount.aggregate({
      where: { pointsBalance: { gt: 0 } },
      _count: { _all: true },
      _sum: { pointsBalance: true },
    }),
    getTiers(),
    // From the CREDITS ledger via the join, not by re-deriving from points:
    // what was actually granted is the truth about what was paid out, and a
    // disagreement between the two is the thing worth being able to see.
    prisma.walletTransaction.aggregate({
      where: { loyaltyRedemption: { isNot: null } },
      _sum: { amountCentavos: true },
    }),
  ]);

  const sum = (type: LoyaltyEntryType): number =>
    Math.abs(byType.find((row) => row.type === type)?._sum.points ?? 0);

  const pointsOutstanding = accounts._sum.pointsBalance ?? 0;

  // Accounts holding points they can never spend, because the balance is below
  // one block. Worth showing: a large stranded total means the block size is
  // set too high and the programme is quietly not paying out.
  const stranded =
    programme.redemptionBlockPoints > 0
      ? await prisma.loyaltyAccount.aggregate({
          where: {
            pointsBalance: { gt: 0, lt: programme.redemptionBlockPoints },
          },
          _count: { _all: true },
          _sum: { pointsBalance: true },
        })
      : { _count: { _all: 0 }, _sum: { pointsBalance: 0 } };

  // How many accounts sit in each tier.
  //
  // One `groupBy` over the earnings inside the window, bucketed in memory —
  // not a count per tier. The first version of this was a query per tier with
  // a spread that duplicated the `entries` key, so every tier reported the
  // same number: the same wrong figure repeated down the column, which reads
  // as data rather than as a bug.
  const earnedPerAccount = await prisma.loyaltyEntry.groupBy({
    by: ['accountId'],
    where: {
      type: LoyaltyEntryType.EARNED,
      createdAt: { gte: tierWindowStart(programme, new Date()) },
    },
    _sum: { points: true },
  });

  const ladder = [...tiers].sort((a, b) => a.thresholdPoints - b.thresholdPoints);
  const holders = new Map<string, number>(ladder.map((tier) => [tier.id, 0]));
  for (const row of earnedPerAccount) {
    const earned = row._sum.points ?? 0;
    // The highest tier this account's window earnings clear — the same rule
    // `tierFor` applies for the customer, so the console and their own screen
    // cannot disagree about who is what.
    const reached = tierFor(ladder, earned).current;
    if (reached) holders.set(reached.id, (holders.get(reached.id) ?? 0) + 1);
  }

  const holderCounts = ladder.map((tier) => ({
    ...tier,
    holders: holders.get(tier.id) ?? 0,
  }));

  return {
    programme,
    isLive: programmeIsLive(programme),
    tiers: holderCounts,

    pointsEarned: sum(LoyaltyEntryType.EARNED),
    pointsRedeemed: sum(LoyaltyEntryType.REDEEMED),
    pointsExpired: sum(LoyaltyEntryType.EXPIRED),
    pointsOutstanding,

    liabilityCentavos: outstandingLiabilityCentavos(programme, pointsOutstanding),
    redeemedCentavos: redeemedCredits._sum.amountCentavos ?? 0,
    givebackBasisPoints: effectiveGivebackBasisPoints(programme),

    accountsHoldingPoints: accounts._count._all,
    strandedAccounts: stranded._count._all,
    strandedPoints: stranded._sum.pointsBalance ?? 0,
  };
}
