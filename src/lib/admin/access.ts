import { cache } from 'react';
import { AdminAction, UserRole, type Prisma, type User } from '@prisma/client';
import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import { getCurrentUser } from '@/lib/auth/session';

/**
 * Who may use the console, and the record of what they did with it.
 *
 * Two rules, and everything else here serves them.
 *
 * **Authorisation is resolved server-side on every read and every write.** Not
 * in middleware — middleware runs on the edge runtime where Prisma is
 * unavailable, so it can see that a session cookie exists but not whose it is
 * or what roles it carries. A layout check is not enough either: a server
 * action is its own entry point and is reachable by anybody who can post to
 * it, so each one calls `requireAdmin()` itself.
 *
 * **Nothing privileged happens without an audit row.** The write and its audit
 * entry go in one transaction, so there is no ordering in which the action
 * lands and the record does not. The alternative — log afterwards — loses the
 * record exactly when the process dies mid-action, which is the case somebody
 * will later need to reconstruct.
 */

export class AdminAccessRequiredError extends Error {
  constructor() {
    super('That is only available to an administrator.');
    this.name = 'AdminAccessRequiredError';
  }
}

export class AuditReasonRequiredError extends Error {
  constructor() {
    super(
      'A reason of at least 8 characters is required. An audit entry that ' +
        'says only what changed is one nobody can act on — name the ticket, ' +
        'the person who asked, or the incident.',
    );
    this.name = 'AuditReasonRequiredError';
  }
}

/** The shortest reason that could mean something: "tkt 4821". */
export const MIN_AUDIT_REASON_LENGTH = 8;

/**
 * The ceiling on a single credits correction.
 *
 * Lives here rather than beside the action because a `'use server'` module may
 * export only async functions — and because a limit on what support can do is
 * policy, which belongs with the rest of the access rules.
 *
 * The number is the point: this is for correcting a mistake the system made,
 * not for issuing credit. A promotion belongs in a campaign with its own
 * approval, not in a support form field.
 */
export const MAX_ADJUSTMENT_CENTAVOS = 500_00;

/** What every console action answers with: a verdict and a sentence. */
export interface AdminActionResult {
  ok: boolean;
  message: string;
}

export function isAdmin(user: Pick<User, 'roles'> | null): boolean {
  return user !== null && user.roles.includes(UserRole.ADMIN);
}

/**
 * The signed-in administrator, or null.
 *
 * Cached per request: the layout, the navigation and the page body all want it.
 */
export const getAdminUser = cache(async (): Promise<User | null> => {
  const user = await getCurrentUser();
  if (!isAdmin(user)) return null;
  // A blocked account keeps its roles, so this has to be checked separately —
  // blocking somebody who is also an admin should stop them, not just stop
  // them ordering lunch.
  if (user!.isBlocked) return null;
  return user;
});

/** Throws unless the caller is an administrator. Every action calls this. */
export async function requireAdmin(): Promise<User> {
  const user = await getAdminUser();
  if (!user) throw new AdminAccessRequiredError();
  return user;
}

export function normaliseReason(raw: unknown): string {
  const reason = String(raw ?? '').trim();
  if (reason.length < MIN_AUDIT_REASON_LENGTH) throw new AuditReasonRequiredError();
  // The column is not a place for an essay, and a truncated reason is still a
  // reason. 500 characters is more than anybody types into a form field.
  return reason.slice(0, 500);
}

export interface AuditInput {
  actorId: string;
  action: AdminAction;
  subjectType: string;
  subjectId: string;
  /** Something a person recognises without a lookup. */
  subjectLabel: string;
  reason: string;
  detail?: Prisma.InputJsonValue;
}

/**
 * Writes the audit row.
 *
 * Takes an optional transaction client so the caller can put this in the same
 * transaction as the change it describes — which every caller here does.
 */
export async function recordAdminAction(
  input: AuditInput,
  client?: PrismaTransactionClient,
): Promise<{ id: string }> {
  const db = client ?? prisma;
  return db.adminAuditEvent.create({
    data: {
      actorId: input.actorId,
      action: input.action,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      subjectLabel: input.subjectLabel,
      reason: normaliseReason(input.reason),
      ...(input.detail === undefined ? {} : { detail: input.detail }),
    },
    select: { id: true },
  });
}

export interface AuditFilter {
  action?: AdminAction;
  actorId?: string;
  subjectType?: string;
  subjectId?: string;
  limit?: number;
}

export async function listAdminActions(filter: AuditFilter = {}) {
  return prisma.adminAuditEvent.findMany({
    where: {
      ...(filter.action ? { action: filter.action } : {}),
      ...(filter.actorId ? { actorId: filter.actorId } : {}),
      ...(filter.subjectType ? { subjectType: filter.subjectType } : {}),
      ...(filter.subjectId ? { subjectId: filter.subjectId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: filter.limit ?? 100,
    include: {
      actor: { select: { id: true, fullName: true, displayName: true, phone: true } },
    },
  });
}

/** English for the log and the confirmation copy. One place, not per screen. */
export const ADMIN_ACTION_LABEL: Readonly<Record<AdminAction, string>> = {
  [AdminAction.SERVICE_AVAILABILITY_CHANGED]: 'Service switched on or off',
  [AdminAction.SERVICE_CITY_CHANGED]: 'Service launched or withdrawn in a city',
  [AdminAction.USER_BLOCK_CHANGED]: 'Account blocked or unblocked',
  [AdminAction.CREDITS_ADJUSTED]: 'Credits adjusted',
  [AdminAction.DELIVERY_REQUEUED]: 'Notification delivery requeued',
  [AdminAction.SUBSCRIPTION_CHANGED]: 'Subscription granted or ended',
};
