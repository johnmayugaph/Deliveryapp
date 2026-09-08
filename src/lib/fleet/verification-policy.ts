import { VerificationStatus } from '@prisma/client';

/**
 * What a fleet approval means, and which decisions are allowed from where.
 *
 * Pure: no database, no session. The console and the partner's own screen both
 * read from here, which is the point — a rider looking at "Pending" and an
 * administrator looking at the same row must be looking at the same word.
 *
 * The rule this module exists to hold: **approval is per service, and it is
 * never automatic.** Being cleared to carry food says nothing about carrying a
 * passenger, and the whole reason `FleetPartnerServiceVerification` is a table
 * rather than a boolean is to make that impossible to forget. The console can
 * therefore only decide on a service the partner has actually APPLIED for —
 * approving a vertical nobody submitted documents for would be exactly the
 * mistake this shape prevents.
 */

/** One word per status, keyed so a sixth status is a compile error. */
export const VERIFICATION_STATUS_LABEL: Readonly<Record<VerificationStatus, string>> = {
  [VerificationStatus.NOT_SUBMITTED]: 'Not applied',
  [VerificationStatus.PENDING]: 'Pending',
  [VerificationStatus.APPROVED]: 'Approved',
  [VerificationStatus.REJECTED]: 'Rejected',
  [VerificationStatus.SUSPENDED]: 'Suspended',
};

/** Tailwind classes for the pill, in the same compile-enforced shape. */
export const VERIFICATION_STATUS_CLASSES: Readonly<Record<VerificationStatus, string>> = {
  [VerificationStatus.NOT_SUBMITTED]: 'bg-surface-sunken text-ink-faint',
  [VerificationStatus.PENDING]: 'bg-amber-50 text-amber-800',
  [VerificationStatus.APPROVED]: 'bg-emerald-50 text-emerald-800',
  [VerificationStatus.REJECTED]: 'bg-rose-50 text-rose-800',
  [VerificationStatus.SUSPENDED]: 'bg-rose-50 text-rose-800',
};

/** What the console may set a row to. Not the full enum: NOT_SUBMITTED is the
 *  absence of an application and PENDING is the partner's own act. */
export const DECIDABLE_STATUSES: readonly VerificationStatus[] = [
  VerificationStatus.APPROVED,
  VerificationStatus.REJECTED,
  VerificationStatus.SUSPENDED,
];

export function isDecision(value: string): value is VerificationStatus {
  return (DECIDABLE_STATUSES as readonly string[]).includes(value);
}

/**
 * Whether a row can be decided at all.
 *
 * An application the partner has never made is not a decision waiting to be
 * taken — it is a form nobody filled in. Everything else is fair game,
 * including a reversal: an approval withdrawn and a refusal reconsidered are
 * both real, and both leave an audit row saying who and why.
 */
export function canDecide(status: VerificationStatus): boolean {
  return status !== VerificationStatus.NOT_SUBMITTED;
}

/** Whether this row is what somebody is waiting on us for. */
export function isWaitingOnUs(status: VerificationStatus): boolean {
  return status === VerificationStatus.PENDING;
}

/** Whether this row lets the partner take work in that service today. */
export function permitsWork(status: VerificationStatus): boolean {
  return status === VerificationStatus.APPROVED;
}

/**
 * A rejection needs a reason and an approval does not.
 *
 * Not symmetry for its own sake. The refusal reason is shown to the applicant
 * on their own screen — it is the only thing that tells them what to fix — so
 * a refusal without one is a dead end for the person on the other side of it.
 * A suspension is a refusal in this respect too.
 */
export function reasonReachesThePartner(status: VerificationStatus): boolean {
  return status === VerificationStatus.REJECTED || status === VerificationStatus.SUSPENDED;
}

/**
 * The order a queue of applications should be worked in.
 *
 * Oldest submission first, and PENDING before everything else. A fleet queue
 * sorted newest-first is how the person who applied on Monday is still waiting
 * on Friday — the same reason the support queue sorts this way.
 */
export function queueRank(row: {
  status: VerificationStatus;
  submittedAt: Date | null;
  createdAt: Date;
}): number {
  const waiting = isWaitingOnUs(row.status) ? 0 : 1;
  const since = (row.submittedAt ?? row.createdAt).getTime();
  // Waiting rows first, then oldest first inside each group.
  return waiting * 1e15 + since;
}

/** How long somebody has been waiting, in words. */
export function describeWait(since: Date, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - since.getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * The sentence the partner is sent.
 *
 * Names the service, because "you have been approved" without saying for what
 * is not something anybody can act on — and carries the reason verbatim on a
 * refusal, for the same reason.
 */
export function describeDecision(input: {
  status: VerificationStatus;
  serviceName: string;
  reason?: string | null | undefined;
}): string {
  const service = input.serviceName;
  switch (input.status) {
    case VerificationStatus.APPROVED:
      return `You are approved for ${service}. Offers can reach you now.`;
    case VerificationStatus.REJECTED:
      return input.reason
        ? `Your ${service} application was not approved: ${input.reason}`
        : `Your ${service} application was not approved.`;
    case VerificationStatus.SUSPENDED:
      return input.reason
        ? `Your ${service} approval is suspended: ${input.reason}`
        : `Your ${service} approval is suspended.`;
    // The two the console cannot set, kept for exhaustiveness rather than
    // being reachable — a status added later must be answered here.
    case VerificationStatus.PENDING:
      return `Your ${service} application is with us.`;
    case VerificationStatus.NOT_SUBMITTED:
      return `You have not applied for ${service}.`;
  }
}
