import { LoyaltyEntryType } from '@prisma/client';
import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import { recordLoyaltyEntry } from '@/lib/loyalty/ledger';
import { getProgramme } from '@/lib/loyalty/programme';

/**
 * Expiring points that were never redeemed.
 *
 * The one thing credits deliberately never do, and the only mechanism that
 * bounds what this programme can come to owe. Without it the outstanding
 * liability only ever grows, and it grows fastest among the customers who
 * stopped ordering — which is the worst possible shape for it.
 *
 * How the netting works is on `livePortions` below.
 *
 * ### Why it is one row per account rather than one per earning
 *
 * A single EXPIRED row per account per sweep, described with the date it
 * relates to. Writing one per consumed earning would be a truer audit trail
 * and would also mean a customer with two years of weekly orders gets a
 * hundred rows in their history on one Tuesday, which is a history nobody can
 * read. The earnings themselves are still in the ledger with their dates, so
 * nothing is lost.
 */

export interface ExpiryPassResult {
  accounts: number;
  pointsExpired: number;
}

/** One earning still contributing to the balance, after netting. */
interface LivePortion {
  points: number;
  expiresAt: Date;
}

/**
 * The earnings still standing behind an account's balance, oldest first.
 *
 * The heart of expiry, and the one walk both callers share — an earlier
 * version had this loop written out twice, once for "what has expired" and
 * once for "what expires next", which is two chances to net the spending
 * differently and no way to notice.
 *
 * ### Oldest first, netted against what has been spent
 *
 * Redemptions are not attributed to particular earnings. A customer who earned
 * 300 in January and 300 in March, then redeemed 500, holds 100 — but WHICH
 * 100? It has to be the newest, because the alternative punishes exactly the
 * behaviour the programme rewards: somebody who redeems promptly would find
 * their remainder expiring on January's clock. So spending consumes the oldest
 * earnings first, which is both the kindest reading and the one every airline
 * and telco uses.
 *
 * Positive adjustments are not in here: they carry no expiry date, so they sit
 * in the balance and never expire, which is what a null `expiresAt` means.
 */
async function livePortions(
  accountId: string,
  client?: PrismaTransactionClient,
): Promise<LivePortion[]> {
  const db = client ?? prisma;

  const [earnings, spentAggregate] = await Promise.all([
    db.loyaltyEntry.findMany({
      where: {
        accountId,
        type: LoyaltyEntryType.EARNED,
        expiresAt: { not: null },
      },
      orderBy: { expiresAt: 'asc' },
      select: { points: true, expiresAt: true },
    }),
    // Everything that has left the balance: redemptions, previous expiries,
    // and any negative adjustment.
    db.loyaltyEntry.aggregate({
      where: {
        accountId,
        type: {
          in: [
            LoyaltyEntryType.REDEEMED,
            LoyaltyEntryType.EXPIRED,
            LoyaltyEntryType.ADJUSTED,
          ],
        },
        points: { lt: 0 },
      },
      _sum: { points: true },
    }),
  ]);

  // A positive number: how much of the earnings has already gone.
  let alreadyGone = Math.abs(spentAggregate._sum.points ?? 0);

  const live: LivePortion[] = [];
  for (const earning of earnings) {
    if (earning.expiresAt === null) continue;
    if (alreadyGone >= earning.points) {
      alreadyGone -= earning.points;
      continue;
    }
    live.push({ points: earning.points - alreadyGone, expiresAt: earning.expiresAt });
    alreadyGone = 0;
  }
  return live;
}

/**
 * How many of an account's points are past their expiry.
 *
 * Exported for the customer's own screen, which needs to say what expires and
 * when without waiting for the sweep to tell it.
 */
export async function expiredPointsFor(
  accountId: string,
  now: Date,
  client?: PrismaTransactionClient,
): Promise<{ points: number; oldestExpiry: Date | null }> {
  const past = (await livePortions(accountId, client)).filter(
    (portion) => portion.expiresAt <= now,
  );
  return {
    points: past.reduce((total, portion) => total + portion.points, 0),
    oldestExpiry: past[0]?.expiresAt ?? null,
  };
}

/**
 * What expires NEXT and when, for the screen.
 *
 * Told before it happens rather than after. A balance that quietly shrank is
 * indistinguishable from a bug, and a customer who is warned can spend.
 */
export async function nextExpiryFor(
  accountId: string,
  now: Date,
  client?: PrismaTransactionClient,
): Promise<{ points: number; at: Date } | null> {
  const upcoming = (await livePortions(accountId, client)).find(
    (portion) => portion.expiresAt > now,
  );
  return upcoming ? { points: upcoming.points, at: upcoming.expiresAt } : null;
}

/**
 * One sweep: expire what is past its date, across every account holding points.
 *
 * Scoped to accounts with a positive balance, so the cost is bounded by how
 * many customers actually hold points rather than by how many have ever
 * ordered.
 */
export async function expireLoyaltyPoints(
  now: Date = new Date(),
): Promise<ExpiryPassResult> {
  const programme = await getProgramme();
  // Nothing to do when the programme never sets an expiry. Reading it first
  // means the common case is one indexed query.
  if (programme.expiryMonths <= 0) return { accounts: 0, pointsExpired: 0 };

  const accounts = await prisma.loyaltyAccount.findMany({
    where: {
      pointsBalance: { gt: 0 },
      entries: {
        some: {
          type: LoyaltyEntryType.EARNED,
          expiresAt: { not: null, lte: now },
        },
      },
    },
    select: { id: true, userId: true },
  });

  const result: ExpiryPassResult = { accounts: 0, pointsExpired: 0 };

  for (const account of accounts) {
    try {
      const { points, oldestExpiry } = await expiredPointsFor(account.id, now);
      if (points <= 0) continue;

      await recordLoyaltyEntry({
        accountId: account.id,
        type: LoyaltyEntryType.EXPIRED,
        points,
        description: oldestExpiry
          ? `${points} points expired (earned before ${oldestExpiry.toISOString().slice(0, 10)})`
          : `${points} points expired`,
      });

      result.accounts += 1;
      result.pointsExpired += points;
    } catch {
      // One account's expiry must not stop the rest. A row that could not be
      // written stays unexpired until the next sweep, which errs towards the
      // customer keeping points rather than losing them to a transient fault.
    }
  }

  return result;
}
