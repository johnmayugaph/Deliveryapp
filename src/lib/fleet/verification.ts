import {
  NotificationKind,
  VerificationStatus,
  type FleetPartnerServiceVerification,
  type ServiceKey,
} from '@prisma/client';
import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import { enqueueNotification } from '@/lib/notifications/enqueue';
import { syncEnabledServices } from '@/lib/fleet/dispatch';
import {
  canDecide,
  permitsWork,
  reasonReachesThePartner,
} from '@/lib/fleet/verification-policy';

/**
 * Deciding whether somebody may take work.
 *
 * This used to be a shell script and nothing else — `npm run fleet:approve`,
 * run over SSH by whoever had the database. That was honest for a while and it
 * stopped being: approving riders is a daily job somebody does from a phone
 * while looking at a photo of a licence, and a decision taken over SSH leaves
 * no audit row, sets no `decidedByUserId`, and never tells the rider.
 *
 * Four properties, and every one of them is why this is a module rather than
 * an `update` in the action:
 *
 *  1. **Per service, always.** Approval to carry food is not approval to carry
 *     a passenger. Nothing here can decide two services at once.
 *  2. **Only what was applied for.** A row the partner has never submitted is
 *     not a decision waiting to be taken, and clearing somebody for a vertical
 *     whose documents nobody looked at is exactly the mistake the per-service
 *     table exists to prevent.
 *  3. **`enabledServices` stays derived.** Dispatch reads that array on every
 *     candidate query; it is recalculated from the verification rows inside the
 *     same transaction, never assigned from what the caller intended.
 *  4. **The partner is told, in the same transaction.** A decision nobody hears
 *     about is a rider refreshing a screen that never changes.
 */

export class NotAnApplicationError extends Error {
  constructor(readonly serviceType: ServiceKey) {
    super(`This partner has not applied for ${serviceType}.`);
    this.name = 'NotAnApplicationError';
  }
}

export class UndecidableStatusError extends Error {
  constructor(readonly status: VerificationStatus) {
    super('That application cannot be decided from its current state.');
    this.name = 'UndecidableStatusError';
  }
}

export class DecisionNeedsReasonError extends Error {
  constructor() {
    super(
      'A refusal or a suspension needs a reason — the applicant is shown it, ' +
        'and it is the only thing that tells them what to fix.',
    );
    this.name = 'DecisionNeedsReasonError';
  }
}

export class AlreadyInThatStateError extends Error {
  constructor(readonly status: VerificationStatus) {
    super('That application is already in that state.');
    this.name = 'AlreadyInThatStateError';
  }
}

export interface DecisionInput {
  fleetPartnerId: string;
  serviceType: ServiceKey;
  status: VerificationStatus;
  /** Shown to the partner when it is a refusal. Required for one. */
  reason: string;
  decidedByUserId: string;
}

export interface DecisionOutcome {
  verification: FleetPartnerServiceVerification;
  enabledServices: ServiceKey[];
  serviceName: string;
}

/**
 * Records one decision, syncs the derived array, and tells the partner.
 *
 * The service NAME comes from the registry rather than the enum, so the
 * message a rider reads says "Kainan" and not "FOOD" — and so a vertical
 * renamed in the registry is renamed everywhere at once.
 */
export async function decideVerification(input: DecisionInput): Promise<DecisionOutcome> {
  if (reasonReachesThePartner(input.status) && input.reason.trim().length === 0) {
    throw new DecisionNeedsReasonError();
  }

  return prisma.$transaction(async (tx) => {
    const existing = await tx.fleetPartnerServiceVerification.findUnique({
      where: {
        fleetPartnerId_serviceType: {
          fleetPartnerId: input.fleetPartnerId,
          serviceType: input.serviceType,
        },
      },
      include: { service: { select: { displayName: true } } },
    });

    // Property 2. Deliberately not an upsert: the CLI creates a row where none
    // existed, which is how you end up approving a vertical nobody submitted
    // anything for.
    if (!existing) throw new NotAnApplicationError(input.serviceType);
    if (!canDecide(existing.status)) throw new UndecidableStatusError(existing.status);
    if (existing.status === input.status) throw new AlreadyInThatStateError(input.status);

    const now = new Date();
    const verification = await tx.fleetPartnerServiceVerification.update({
      where: { id: existing.id },
      data: {
        status: input.status,
        decidedAt: now,
        decidedByUserId: input.decidedByUserId,
        // Cleared on an approval: a stale refusal reason left on an approved
        // row is shown to the partner beside the word "Approved".
        rejectionReason: reasonReachesThePartner(input.status) ? input.reason : null,
      },
    });

    // Property 3.
    const enabledServices = await syncEnabledServices(input.fleetPartnerId, tx);

    // Property 4.
    const partner = await tx.fleetPartner.findUniqueOrThrow({
      where: { id: input.fleetPartnerId },
      select: { userId: true },
    });
    const serviceName = existing.service.displayName;

    await enqueueNotification(
      {
        userId: partner.userId,
        kind: NotificationKind.FLEET_VERIFICATION_DECIDED,
        context: {
          serviceName,
          verificationApproved: permitsWork(input.status),
          ...(reasonReachesThePartner(input.status) ? { reason: input.reason } : {}),
        },
        href: '/fleet/profile',
        // Keyed on the moment rather than on the row: an application refused,
        // reconsidered and approved is three true things to have been told.
        dedupeKey: `fleet-verification:${verification.id}:${input.status}:${now.getTime()}`,
      },
      tx,
    );

    return { verification, enabledServices, serviceName };
  });
}

/**
 * Stops a partner working, or lets them start again.
 *
 * Separate from a per-service decision because it is a different kind of
 * judgement: not "are these documents good" but "not today, whatever the
 * documents say". It leaves every approval intact, which is what makes
 * reinstating somebody one click rather than three decisions taken again.
 *
 * Online is cleared on suspension. Leaving somebody marked online while
 * suspended means dispatch keeps considering and skipping them, and the
 * partner's own screen says they are working when they are not.
 */
export async function setPartnerSuspended(input: {
  fleetPartnerId: string;
  isSuspended: boolean;
  client?: PrismaTransactionClient;
}): Promise<{ isSuspended: boolean }> {
  const db = input.client ?? prisma;
  const partner = await db.fleetPartner.update({
    where: { id: input.fleetPartnerId },
    data: {
      isSuspended: input.isSuspended,
      ...(input.isSuspended ? { isOnline: false } : {}),
    },
    select: { isSuspended: true },
  });
  return partner;
}
