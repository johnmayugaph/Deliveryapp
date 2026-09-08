import { LoyaltyEntryType, type SupportTicket, type User } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getProgramme, getTiersWithBenefits } from '@/lib/loyalty/programme';
import { tierFor, tierWindowStart } from '@/lib/loyalty/policy';
import { supportPriorityFor } from '@/lib/loyalty/tier-benefits';
import {
  PRIORITY_RANK,
  QUEUE_STATUSES,
  SUPPORT_RESPONSE_TARGET_MINUTES,
  WAITING_STATUSES,
  waitingMinutes,
} from './policy';

/**
 * The console's reads.
 *
 * Separate from `tickets.ts` for the same reason `monitoring/queries.ts` is
 * separate from the reporter: these are the operator's questions, and none of
 * them take a user id — an agent reads any ticket, which is exactly why the
 * customer-facing functions do not live here.
 */

export type QueueRow = SupportTicket & {
  user: Pick<User, 'id' | 'fullName' | 'displayName' | 'phone'>;
  assignedAgent: Pick<User, 'id' | 'fullName' | 'displayName' | 'phone'> | null;
  _count: { messages: number };
  /** Minutes since the last thing happened on the thread. */
  waitedMinutes: number;
  /**
   * Minutes of apparent wait added by the customer's loyalty tier, and zero
   * for almost everybody. Carried on the row so the console can SHOW it —
   * an agent looking at a queue reordered by something invisible is an agent
   * who thinks the queue is broken.
   */
  tierBoostMinutes: number;
  /** The tier that granted it, for the badge beside the ticket. */
  tierName: string | null;
};

/**
 * The queue, worst first.
 *
 * Ordered in TypeScript rather than in SQL, and deliberately. Postgres sorts an
 * enum by its declaration order, so `orderBy: { priority: 'desc' }` happens to
 * put URGENT first today — and would silently reorder the whole queue the day
 * somebody tidies the enum. `PRIORITY_RANK` says the order out loud instead.
 * The cost is fetching the window before sorting it, which for a queue measured
 * in tens of rows is nothing.
 *
 * ### Where a loyalty tier fits, and where it does not
 *
 * SUPPORT_PRIORITY adds minutes of apparent wait, so a suki's ticket sorts
 * ahead of ones sent inside that window and behind anything older. It is a
 * tie-break inside a priority band and **never crosses one**: an URGENT ticket
 * from somebody who has never ordered still outranks a NORMAL one from the
 * most loyal customer on the platform, because urgency is about what has
 * happened to them and loyalty is about what they have spent.
 *
 * The boost is also visible on the row. A queue that reorders itself for a
 * reason the agent cannot see is one they will assume is broken.
 */
export async function supportQueue(
  options: { includeFinished?: boolean; limit?: number } = {},
): Promise<QueueRow[]> {
  const rows = await prisma.supportTicket.findMany({
    where: options.includeFinished
      ? {}
      : { status: { in: [...QUEUE_STATUSES] } },
    orderBy: { lastMessageAt: 'asc' },
    take: options.limit ?? 200,
    include: {
      user: { select: { id: true, fullName: true, displayName: true, phone: true } },
      assignedAgent: {
        select: { id: true, fullName: true, displayName: true, phone: true },
      },
      _count: { select: { messages: true } },
    },
  });

  const now = new Date();
  const boosts = await supportBoostsFor(
    rows.map((row) => row.userId),
    now,
  );

  return rows
    .map((row) => {
      const boost = boosts.get(row.userId);
      return {
        ...row,
        waitedMinutes: waitingMinutes({ since: row.lastMessageAt, now }),
        tierBoostMinutes: boost?.minutes ?? 0,
        tierName: boost?.tierName ?? null,
      };
    })
    .sort((left, right) => {
      const byPriority = PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority];
      if (byPriority !== 0) return byPriority;
      // Longest ignored first, within a priority — plus whatever the
      // customer's tier is worth, which cannot lift them out of the band.
      const leftWait = left.waitedMinutes + left.tierBoostMinutes;
      const rightWait = right.waitedMinutes + right.tierBoostMinutes;
      return rightWait - leftWait;
    });
}

/**
 * The support boost for each of these customers, and which tier granted it.
 *
 * Same shape and same reasoning as `dispatchBoostsFor`: one read of the ladder
 * and one grouped aggregate, rather than a round trip per ticket. Returns an
 * empty map — so everybody sorts on real waiting time alone — when the
 * programme is off or no tier confers the perk, which is the shipped state.
 */
async function supportBoostsFor(
  userIds: readonly string[],
  now: Date,
): Promise<Map<string, { minutes: number; tierName: string }>> {
  const boosts = new Map<string, { minutes: number; tierName: string }>();
  if (userIds.length === 0) return boosts;

  const programme = await getProgramme();
  if (!programme.isActive) return boosts;

  const tiers = await getTiersWithBenefits();
  if (tiers.every((tier) => supportPriorityFor(tier.benefits) === 0)) {
    return boosts;
  }

  const accounts = await prisma.loyaltyAccount.findMany({
    where: { userId: { in: [...new Set(userIds)] } },
    select: { id: true, userId: true },
  });
  if (accounts.length === 0) return boosts;

  const earned = await prisma.loyaltyEntry.groupBy({
    by: ['accountId'],
    where: {
      accountId: { in: accounts.map((account) => account.id) },
      type: LoyaltyEntryType.EARNED,
      createdAt: { gte: tierWindowStart(programme, now) },
    },
    _sum: { points: true },
  });
  const pointsByAccount = new Map(
    earned.map((row) => [row.accountId, row._sum.points ?? 0]),
  );

  for (const account of accounts) {
    const { current } = tierFor(tiers, pointsByAccount.get(account.id) ?? 0);
    if (current === null) continue;
    const tier = tiers.find((row) => row.id === current.id);
    if (!tier) continue;
    const minutes = supportPriorityFor(tier.benefits);
    if (minutes > 0) boosts.set(account.userId, { minutes, tierName: tier.name });
  }

  return boosts;
}

export type AgentTicket = SupportTicket & {
  user: Pick<User, 'id' | 'fullName' | 'displayName' | 'phone' | 'isBlocked'>;
  assignedAgent: Pick<User, 'id' | 'fullName' | 'displayName' | 'phone'> | null;
  relatedOrder: { id: string; orderNumber: string; status: string } | null;
  messages: {
    id: string;
    body: string;
    isFromSupport: boolean;
    createdAt: Date;
    author: Pick<User, 'id' | 'fullName' | 'displayName' | 'phone'> | null;
  }[];
};

export async function getTicketForAgent(ticketId: string): Promise<AgentTicket | null> {
  return prisma.supportTicket.findUnique({
    where: { id: ticketId },
    include: {
      user: {
        select: {
          id: true,
          fullName: true,
          displayName: true,
          phone: true,
          isBlocked: true,
        },
      },
      assignedAgent: {
        select: { id: true, fullName: true, displayName: true, phone: true },
      },
      relatedOrder: { select: { id: true, orderNumber: true, status: true } },
      messages: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          body: true,
          isFromSupport: true,
          createdAt: true,
          author: {
            select: { id: true, fullName: true, displayName: true, phone: true },
          },
        },
      },
    },
  });
}

export interface SupportSummary {
  /** Threads where somebody is waiting on us. */
  waiting: number;
  /** Of those, the ones nobody has answered even once. */
  neverAnswered: number;
  /** The longest anybody has been waiting, in minutes. Zero for an empty queue. */
  longestWaitMinutes: number;
  /** Answered at least once, in the last week, and how quickly. */
  answeredThisWeek: number;
  medianFirstReplyMinutes: number | null;
}

/**
 * The numbers for the overview.
 *
 * `neverAnswered` is separated out on purpose: ten threads mid-conversation and
 * ten threads nobody has ever replied to are the same "waiting" count and
 * completely different situations.
 */
export async function supportSummary(now: Date = new Date()): Promise<SupportSummary> {
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [waitingRows, answered] = await Promise.all([
    prisma.supportTicket.findMany({
      where: { status: { in: [...WAITING_STATUSES] } },
      select: { createdAt: true, lastMessageAt: true, firstRespondedAt: true },
    }),
    prisma.supportTicket.findMany({
      where: { firstRespondedAt: { gte: weekAgo } },
      select: { createdAt: true, firstRespondedAt: true },
    }),
  ]);

  const longestWaitMinutes = waitingRows.reduce(
    (worst, row) =>
      Math.max(worst, waitingMinutes({ since: row.lastMessageAt, now })),
    0,
  );

  const replyMinutes = answered
    .map((row) =>
      row.firstRespondedAt === null
        ? null
        : waitingMinutes({ since: row.createdAt, now: row.firstRespondedAt }),
    )
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);

  return {
    waiting: waitingRows.length,
    neverAnswered: waitingRows.filter((row) => row.firstRespondedAt === null).length,
    longestWaitMinutes,
    answeredThisWeek: replyMinutes.length,
    medianFirstReplyMinutes: median(replyMinutes),
  };
}

/**
 * The median rather than the mean, because one ticket answered after three days
 * would otherwise make a week of prompt replies look terrible — and because the
 * question is "what does a typical customer experience".
 */
function median(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

/**
 * Tickets nobody has answered, past the target, not yet chased.
 *
 * The `alertedAt` check is what stops this being an alert every cron tick: the
 * sweep marks a ticket chased and moves on, exactly like a new error report.
 */
export async function ticketsNeedingChase(
  now: Date = new Date(),
  targetMinutes: number = SUPPORT_RESPONSE_TARGET_MINUTES,
): Promise<Pick<SupportTicket, 'id' | 'ticketNumber' | 'subject' | 'createdAt'>[]> {
  const cutoff = new Date(now.getTime() - targetMinutes * 60 * 1000);
  return prisma.supportTicket.findMany({
    where: {
      status: { in: [...WAITING_STATUSES] },
      firstRespondedAt: null,
      alertedAt: null,
      createdAt: { lte: cutoff },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, ticketNumber: true, subject: true, createdAt: true },
    take: 50,
  });
}

export async function markTicketChased(ticketId: string): Promise<void> {
  await prisma.supportTicket.update({
    where: { id: ticketId },
    data: { alertedAt: new Date() },
  });
}
