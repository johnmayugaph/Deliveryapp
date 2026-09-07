import { ErrorSource, UserRole, type ErrorReport } from '@prisma/client';
import { prisma } from '@/lib/prisma';

/**
 * Reading the error log, and deciding who to tell.
 *
 * Separate from `report.ts` because the write path has to be safe to call from
 * inside a failure and this does not: these run on an admin page and on the
 * cron, where throwing is fine and being wrong is not.
 */

export interface ErrorListFilter {
  /** Open by default. Resolved rows are history, not a work queue. */
  includeResolved?: boolean;
  limit?: number;
}

export interface ErrorSummary {
  open: number;
  /** Distinct faults first seen in the last day. The "is it getting worse" number. */
  newToday: number;
  /** Total occurrences across every open fault. */
  occurrences: number;
  /** The most recent occurrence of anything, resolved or not. */
  lastSeenAt: Date | null;
}

export async function errorSummary(now = new Date()): Promise<ErrorSummary> {
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [open, newToday, aggregate, latest] = await Promise.all([
    prisma.errorReport.count({ where: { resolvedAt: null } }),
    prisma.errorReport.count({
      where: { resolvedAt: null, firstSeenAt: { gte: dayAgo } },
    }),
    prisma.errorReport.aggregate({
      where: { resolvedAt: null },
      _sum: { occurrences: true },
    }),
    prisma.errorReport.findFirst({
      orderBy: { lastSeenAt: 'desc' },
      select: { lastSeenAt: true },
    }),
  ]);

  return {
    open,
    newToday,
    occurrences: aggregate._sum.occurrences ?? 0,
    lastSeenAt: latest?.lastSeenAt ?? null,
  };
}

/**
 * The list the console shows.
 *
 * Ordered by most recent occurrence, not by count. A fault that happened four
 * hundred times last Tuesday and stopped is less urgent than one that happened
 * twice in the last minute, and sorting by volume buries the second under the
 * first.
 */
export async function listErrorReports(filter: ErrorListFilter = {}) {
  return prisma.errorReport.findMany({
    where: filter.includeResolved ? {} : { resolvedAt: null },
    orderBy: { lastSeenAt: 'desc' },
    take: filter.limit ?? 50,
    include: {
      user: { select: { id: true, fullName: true, phone: true } },
      resolvedBy: { select: { id: true, fullName: true, phone: true } },
    },
  });
}

export async function errorReportById(id: string) {
  return prisma.errorReport.findUnique({
    where: { id },
    include: {
      user: { select: { id: true, fullName: true, phone: true } },
      resolvedBy: { select: { id: true, fullName: true, phone: true } },
    },
  });
}

/** English for a source. One place, so a sixth one is one line. */
export const ERROR_SOURCE_LABEL: Readonly<Record<ErrorSource, string>> = {
  [ErrorSource.SERVER_REQUEST]: 'Page or route',
  [ErrorSource.SERVER_ACTION]: 'Form or button',
  [ErrorSource.CRON]: 'Background sweep',
  [ErrorSource.CLIENT]: "In someone's browser",
  [ErrorSource.BACKGROUND]: 'Script or job',
};

/**
 * Faults that nobody has been told about yet.
 *
 * `alertedAt` rather than a "notified" flag on a notification, because the
 * question is about the FAULT, not about a message: one alert per distinct
 * thing that broke, however many times it then happens. An error loop
 * producing ten thousand occurrences produces one notification.
 */
export async function unalertedErrorReports(limit = 5): Promise<ErrorReport[]> {
  return prisma.errorReport.findMany({
    where: { alertedAt: null, resolvedAt: null },
    orderBy: { firstSeenAt: 'asc' },
    // Bounded low on purpose. If twenty things broke at once, an administrator
    // needs to know that something is very wrong — not to receive twenty
    // notifications, which is indistinguishable from spam and gets muted.
    take: limit,
  });
}

export async function markErrorAlerted(id: string, now = new Date()): Promise<void> {
  await prisma.errorReport.update({ where: { id }, data: { alertedAt: now } });
}

/**
 * Who to tell.
 *
 * Every unblocked administrator, and nobody else. Not SUPPORT_AGENT: a support
 * agent answers customers and cannot deploy a fix, so waking them at 2am with
 * a stack trace is noise with no action attached.
 */
export async function administratorsToAlert(): Promise<{ id: string }[]> {
  return prisma.user.findMany({
    where: { roles: { has: UserRole.ADMIN }, isBlocked: false, isDemo: false },
    select: { id: true },
  });
}
