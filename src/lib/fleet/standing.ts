import {
  canDecide,
  isWaitingOnUs,
  permitsWork,
  permitsWorkOn,
  type VerificationTerm,
} from '@/lib/fleet/verification-policy';
import { countOf } from '@/lib/text/count';

/**
 * Where a fleet partner stands overall, for the one row about it on a screen
 * that is not the fleet app.
 *
 * `/profile` is where somebody who delivers for TARA lands from the customer
 * side, and its fleet row said one of exactly two things:
 *
 *     enabledServices.length > 0 ? `Approved sa N service` : 'Awaiting approval'
 *
 * Three untrue readings came out of that, and every fact needed to avoid them
 * was already loaded on the page:
 *
 * **A suspended partner read "Approved sa 2 service".** The row never looked
 * at `isSuspended`. Suspension deliberately leaves the approvals intact — that
 * is what makes reinstating somebody one click instead of three decisions
 * taken again — so `enabledServices` stays populated and the count stays
 * right about a partner who cannot work at all. `setPartnerSuspended` names
 * this failure in its own comment: *"the partner's own screen says they are
 * working when they are not"*. It was talking about `isOnline`. The same
 * sentence was true one screen over about the whole row.
 *
 * **A refused applicant read "Awaiting approval".** Nothing distinguishes
 * PENDING from REJECTED in a count of zero, so somebody whose application was
 * turned down last week was told to keep waiting — and the reason they were
 * refused is on `/fleet/profile`, which they had no cause to open. The
 * verification rows that tell the two apart were being loaded on the profile
 * page, with a nested `service` join, and dropped: the file's own doc comment
 * claimed it rendered *"the per-service approvals that decide what work they
 * are actually offered"*.
 *
 * **An expired approval read as approved.** `enabledServices` is a
 * denormalised copy resynced only when somebody decides something, so a rider
 * whose licence lapsed keeps the key in the array. Reading the rows through
 * `permitsWorkOn` asks the question dispatch asks, at the moment of asking.
 *
 * So this module counts from the ROWS and not from the copy, and takes
 * suspension first. Every state points at `/fleet/profile`, where the
 * per-service list and any refusal reason actually live — this row's job is to
 * be true and to say whether it is worth opening.
 *
 * Pure: no database, no clock of its own.
 */

export type FleetStanding =
  /** Not a partner. The invitation, rather than a status. */
  | { kind: 'NOT_A_PARTNER' }
  /**
   * Suspended from all work, whatever the approvals say. First, because it
   * outranks every per-service fact — the same order `/fleet` uses.
   */
  | { kind: 'SUSPENDED' }
  /** Can take work today, in this many services. */
  | { kind: 'WORKING'; approved: number; waiting: number; isOnline: boolean }
  /**
   * Approved, but the documents behind every approval have run out. Kept
   * apart from WAITING because it is the one state the partner can fix
   * themselves, and being told to wait is the opposite of useful.
   */
  | { kind: 'EXPIRED' }
  /** Applied and waiting on us. */
  | { kind: 'WAITING'; waiting: number }
  /** Decided, and nothing was approved. */
  | { kind: 'REFUSED' }
  /** A partner record with nothing submitted against it. */
  | { kind: 'NOT_APPLIED' };

/**
 * Everything the standing depends on. Rows, not the derived array.
 *
 * Named for the Prisma relation so a selected `FleetPartner` passes straight
 * in — structural, like `InvoiceTimestamps` and `VerificationTerm`.
 */
export interface FleetFacts {
  isSuspended: boolean;
  isOnline: boolean;
  /** Every verification row for this partner, whatever its status. */
  serviceVerifications: readonly VerificationTerm[];
}

export function fleetStanding(facts: FleetFacts | null, now: Date): FleetStanding {
  if (facts === null) return { kind: 'NOT_A_PARTNER' };
  if (facts.isSuspended) return { kind: 'SUSPENDED' };

  const approved = facts.serviceVerifications.filter((row) => permitsWorkOn(row, now)).length;
  const waiting = facts.serviceVerifications.filter((row) => isWaitingOnUs(row.status)).length;

  if (approved > 0) {
    return { kind: 'WORKING', approved, waiting, isOnline: facts.isOnline };
  }

  // Approved on paper and not in force: the documents expired. `permitsWork`
  // without `permitsWorkOn` is exactly that gap.
  if (facts.serviceVerifications.some((row) => permitsWork(row.status))) {
    return { kind: 'EXPIRED' };
  }
  if (waiting > 0) return { kind: 'WAITING', waiting };
  /* A decision was taken and it went against them, or an approval was
     withdrawn one service at a time. Either way there is something to read.

     Through `canDecide`, which is the module that already draws this line:
     NOT_SUBMITTED is "a form nobody filled in", not a decision, and the first
     version of this asked `!isWaitingOnUs` instead — which called a partner
     with one blank row REFUSED. */
  if (facts.serviceVerifications.some((row) => canDecide(row.status))) {
    return { kind: 'REFUSED' };
  }
  return { kind: 'NOT_APPLIED' };
}

/** The row, ready to render. */
export interface FleetRow {
  title: string;
  note: string;
  /** Where the row goes. */
  href: string;
  /** Whether it should read as a problem rather than as information. */
  needsAttention: boolean;
}

/**
 * The copy.
 *
 * Taglish where the original was, and the wording of each state is the
 * partner's own question: not "what is your status" but "will offers reach
 * me". A suspended rider needs to know nothing will arrive and who to ask; a
 * refused one needs to know a decision exists and where the reason is.
 */
export function fleetRow(standing: FleetStanding): FleetRow {
  const OPEN = 'Buksan ang fleet app';

  switch (standing.kind) {
    case 'NOT_A_PARTNER':
      return {
        title: 'Become a fleet partner',
        note: 'Earn by delivering — same account.',
        href: '/fleet/apply',
        needsAttention: false,
      };
    case 'SUSPENDED':
      return {
        title: OPEN,
        note: 'Suspended — no offers will arrive. Contact support.',
        href: '/fleet',
        needsAttention: true,
      };
    case 'WORKING': {
      const parts = [`Approved sa ${countOf(standing.approved, 'service')}`];
      // A pending second application is worth a word: it is the difference
      // between "we forgot you" and "we have it".
      if (standing.waiting > 0) parts.push(`${standing.waiting} pending`);
      if (standing.isOnline) parts.push('online');
      return {
        title: OPEN,
        note: parts.join(' · '),
        href: '/fleet',
        needsAttention: false,
      };
    }
    case 'EXPIRED':
      return {
        title: OPEN,
        note: 'Your documents expired, so no offers arrive. Send new ones.',
        href: '/fleet/profile',
        needsAttention: true,
      };
    case 'WAITING':
      return {
        title: OPEN,
        note: `${countOf(standing.waiting, 'application')} with us. No offers until one is approved.`,
        href: '/fleet/profile',
        needsAttention: false,
      };
    case 'REFUSED':
      return {
        title: OPEN,
        // Does not repeat the reason. It is per service and it is verbatim
        // from the person who decided, so it belongs on the screen that shows
        // the row it belongs to.
        note: 'Walang approved na service. Tingnan kung bakit.',
        href: '/fleet/profile',
        needsAttention: true,
      };
    case 'NOT_APPLIED':
      return {
        title: OPEN,
        note: 'Pick a service to apply for.',
        href: '/fleet/profile',
        needsAttention: false,
      };
  }
}
