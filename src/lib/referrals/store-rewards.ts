import {
  NotificationKind,
  ReferralStatus,
  SettlementEntryType,
  StoreRole,
} from '@prisma/client';
import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import { positionOf, recordSettlementEntry } from '@/lib/settlement/ledger';
import { enqueueNotification } from '@/lib/notifications/enqueue';
import { getStoreProgramme } from '@/lib/referrals/store-programme';
import { monthStart } from '@/lib/referrals/rewards';
import {
  STORE_REWARD_REFUSAL_TEXT,
  rewardForStoreReferral,
  storePaysNothing,
} from '@/lib/referrals/store-policy';

/**
 * Paying a shop for bringing a shop.
 *
 * Runs inside the order-completion transaction, immediately after the
 * settlement accrual that the qualification depends on — the shop's earnings
 * are read from the ledger, and the line this order just wrote has to be in it
 * or a shop would qualify one order late, every time.
 *
 * Accrues, does not pay: the bonus becomes a `REFERRAL_BONUS` line on the
 * shop's settlement balance and leaves in the payout somebody records. Same
 * rail as the rider bonus, same reason, and the same care with the words —
 * "owed", never "paid".
 */

export interface StoreRewardOutcome {
  referrerCentavos: number;
  refereeCentavos: number;
  settled: boolean;
}

const NOTHING: StoreRewardOutcome = {
  referrerCentavos: 0,
  refereeCentavos: 0,
  settled: false,
};

/**
 * Settles the store referral this order's earnings qualify, if any.
 *
 * Returns immediately for the ordinary case — an order from a shop nobody
 * introduced, or one whose referral is already settled. One lookup on a unique
 * index, which is the right cost on every completion for a feature most orders
 * have nothing to do with.
 */
export async function payStoreReferralForOrder(
  input: { storeId: string | null },
  client?: PrismaTransactionClient,
  now: Date = new Date(),
): Promise<StoreRewardOutcome> {
  const db = client ?? prisma;
  if (!input.storeId) return NOTHING;

  const referral = await db.storeReferral.findUnique({
    where: { refereeStoreId: input.storeId },
    select: {
      id: true,
      status: true,
      referrerStoreId: true,
      refereeStoreId: true,
      referrerStore: { select: { id: true, name: true, isVisible: true } },
      refereeStore: { select: { id: true, name: true } },
    },
  });
  if (!referral || referral.status !== ReferralStatus.ATTRIBUTED) return NOTHING;

  const programme = await getStoreProgramme(db);

  // From the LEDGER, and from inside this transaction, so the accrual this
  // completion just wrote counts. `earnedCentavos` sums ORDER_EARNINGS only —
  // a bonus this shop was itself paid does not help it qualify, which would
  // otherwise let a chain of introductions bootstrap itself.
  const position = await positionOf(
    { party: 'STORE', storeId: referral.refereeStoreId },
    db,
  );

  const [rewardedThisMonth, rewardedEver] = await Promise.all([
    db.storeReferral.count({
      where: {
        referrerStoreId: referral.referrerStoreId,
        status: ReferralStatus.REWARDED,
        rewardedAt: { gte: monthStart(now) },
      },
    }),
    db.storeReferral.count({
      where: {
        referrerStoreId: referral.referrerStoreId,
        status: ReferralStatus.REWARDED,
      },
    }),
  ]);

  const decision = rewardForStoreReferral({
    programme,
    earnedCentavos: position.earnedCentavos,
    rewardedThisMonth,
    rewardedEver,
    referrerIsVisible: referral.referrerStore.isVisible,
  });

  // Not there yet. The row stays open and the next order asks again.
  if (decision.referrerRefusal === 'NOT_ENOUGH_EARNINGS') return NOTHING;

  if (storePaysNothing(decision)) {
    const reason =
      STORE_REWARD_REFUSAL_TEXT[
        decision.referrerRefusal ?? decision.refereeRefusal ?? 'NOTHING_TO_PAY'
      ];

    const closed = await db.storeReferral.updateMany({
      where: { id: referral.id, status: ReferralStatus.ATTRIBUTED },
      data: {
        status: ReferralStatus.NOT_REWARDED,
        blockedReason: reason,
        qualifyingEarningsCentavos: position.earnedCentavos,
      },
    });
    if (closed.count !== 1) return NOTHING;

    await tellStore(
      referral.referrerStore.id,
      'REFERRER',
      0,
      reason,
      referral.id,
      db,
      now,
    );
    return { referrerCentavos: 0, refereeCentavos: 0, settled: true };
  }

  // A compare-and-set, for the reason the rider version documents at length:
  // two orders from the same shop completing at once both read the row as
  // ATTRIBUTED, and the loser writing would raise the immutability trigger
  // out of a completion transaction and fail somebody's ORDER.
  const claimed = await db.storeReferral.updateMany({
    where: { id: referral.id, status: ReferralStatus.ATTRIBUTED },
    data: {
      status: ReferralStatus.REWARDED,
      referrerRewardCentavos: decision.referrerCentavos,
      refereeRewardCentavos: decision.refereeCentavos,
      rewardedAt: now,
      qualifyingEarningsCentavos: position.earnedCentavos,
      ...(decision.referrerRefusal
        ? { blockedReason: STORE_REWARD_REFUSAL_TEXT[decision.referrerRefusal] }
        : {}),
    },
  });
  if (claimed.count !== 1) return NOTHING;

  if (decision.referrerCentavos > 0) {
    await accrue(
      {
        storeId: referral.referrerStoreId,
        amountCentavos: decision.referrerCentavos,
        description: `Bonus for introducing ${referral.refereeStore.name}`,
        referralId: referral.id,
        side: 'referrer',
        earnedCentavos: position.earnedCentavos,
      },
      db,
    );
  }

  if (decision.refereeCentavos > 0) {
    await accrue(
      {
        storeId: referral.refereeStoreId,
        amountCentavos: decision.refereeCentavos,
        description: 'Welcome bonus for your first sales on TARA',
        referralId: referral.id,
        side: 'referee',
        earnedCentavos: position.earnedCentavos,
      },
      db,
    );
  }

  await tellStore(
    referral.referrerStore.id,
    'REFERRER',
    decision.referrerCentavos,
    decision.referrerRefusal
      ? STORE_REWARD_REFUSAL_TEXT[decision.referrerRefusal]
      : null,
    referral.id,
    db,
    now,
  );
  if (decision.refereeCentavos > 0) {
    await tellStore(
      referral.refereeStore.id,
      'REFEREE',
      decision.refereeCentavos,
      null,
      referral.id,
      db,
      now,
    );
  }

  return {
    referrerCentavos: decision.referrerCentavos,
    refereeCentavos: decision.refereeCentavos,
    settled: true,
  };
}

/**
 * One bonus line on the settlement ledger.
 *
 * No `orderId`, and here the reason is even plainer than for a rider: the
 * order belongs to the OTHER shop's customer. A line saying "you earned this
 * on order DA-…" on the introducing shop's statement would name an order they
 * never cooked for.
 */
async function accrue(
  input: {
    storeId: string;
    amountCentavos: number;
    description: string;
    referralId: string;
    side: 'referrer' | 'referee';
    earnedCentavos: number;
  },
  db: PrismaTransactionClient,
): Promise<void> {
  await recordSettlementEntry(
    {
      ref: { party: 'STORE', storeId: input.storeId },
      type: SettlementEntryType.REFERRAL_BONUS,
      amountCentavos: input.amountCentavos,
      description: input.description,
      idempotencyKey: `store-referral-${input.side}:${input.referralId}`,
      metadata: {
        storeReferralId: input.referralId,
        side: input.side,
        qualifyingEarningsCentavos: input.earnedCentavos,
      },
    },
    db,
  );
}

/**
 * Tells a shop what happened, either way.
 *
 * To the OWNERS and managers, not to whoever is working the counter — the same
 * rule the ratings digest follows, and for the same reason: what the business
 * is owed is the owner's business, and a till screen is not private.
 *
 * Swallowed on failure, like every other enqueue here.
 */
async function tellStore(
  storeId: string,
  role: 'REFERRER' | 'REFEREE',
  amountCentavos: number,
  reason: string | null,
  referralId: string,
  db: PrismaTransactionClient,
  now: Date,
): Promise<void> {
  try {
    const members = await db.storeMember.findMany({
      where: { storeId, role: { in: [StoreRole.OWNER, StoreRole.MANAGER] } },
      select: { userId: true },
    });

    for (const member of members) {
      await enqueueNotification(
        {
          userId: member.userId,
          kind: NotificationKind.STORE_REFERRAL_SETTLED,
          href: `/merchant/${storeId}/payouts`,
          context: {
            amountCentavos,
            inviteRole: role,
            ...(reason ? { reason } : {}),
          },
          dedupeKey: `store-referral:${referralId}:${role}:${member.userId}`,
          now,
        },
        db,
      );
    }
  } catch {
    // Losing a notification is bad; losing the money it was about is worse.
  }
}
