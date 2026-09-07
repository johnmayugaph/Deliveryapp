import type { SupportTicket, User } from '@prisma/client';
import { prisma } from '@/lib/prisma';
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
  return rows
    .map((row) => ({
      ...row,
      waitedMinutes: waitingMinutes({ since: row.lastMessageAt, now }),
    }))
    .sort((left, right) => {
      const byPriority = PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority];
      if (byPriority !== 0) return byPriority;
      // Longest ignored first, within a priority.
      return right.waitedMinutes - left.waitedMinutes;
    });
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
