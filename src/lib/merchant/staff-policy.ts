import { StoreRole } from '@prisma/client';

/**
 * Who may hand out access to a store, and to whom.
 *
 * Pure, and expressed as maps keyed by every `StoreRole`, so adding a role is
 * a compile error until somebody decides what it may do. Nothing here touches
 * the database — which matters, because these are the rules a privilege
 * escalation would go through, and they should be readable in one screen and
 * testable without one.
 */

export class CannotGrantRoleError extends Error {
  constructor(readonly actor: StoreRole, readonly requested: StoreRole) {
    super(
      requested === StoreRole.STAFF
        ? 'Only a manager or the owner can add staff.'
        : 'Only the owner can make somebody a manager or an owner.',
    );
    this.name = 'CannotGrantRoleError';
  }
}

/**
 * Separate from `CannotGrantRoleError`, and the reason is the sentence.
 *
 * When a manager tries to demote the owner, the check that fails is "may you
 * touch an OWNER" — but the role they REQUESTED is `STAFF`, so the grant error
 * would tell them "only a manager or the owner can add staff", which they are
 * and which is not the problem. A misleading refusal is worse than a blunt one:
 * it sends somebody to ask for the wrong permission.
 */
export class CannotChangeRoleError extends Error {
  constructor(readonly actor: StoreRole, readonly current: StoreRole) {
    super(
      actor === StoreRole.STAFF
        ? "Only a manager or the owner can change somebody's role."
        : 'Only the owner can change what an owner or a manager is.',
    );
    this.name = 'CannotChangeRoleError';
  }
}

export class CannotRemoveError extends Error {
  constructor() {
    super('Only the owner can remove somebody else. You can always leave yourself.');
    this.name = 'CannotRemoveError';
  }
}

export class LastOwnerError extends Error {
  constructor() {
    super(
      'A store has to keep at least one owner. Make somebody else the owner ' +
        'first, then change or remove this one.',
    );
    this.name = 'LastOwnerError';
  }
}

export class AlreadyAMemberError extends Error {
  constructor() {
    super('That number already has access to this store. Change their role instead.');
    this.name = 'AlreadyAMemberError';
  }
}

export class InviteNotFoundError extends Error {
  constructor() {
    super('That invitation is no longer there.');
    this.name = 'InviteNotFoundError';
  }
}

/**
 * The highest role each role may hand out.
 *
 * The asymmetry is deliberate. A MANAGER may add STAFF but not another
 * manager: only an owner decides who else can change prices and settings, and
 * a manager who could appoint peers could build a majority that outvotes the
 * person whose business it is.
 *
 * An OWNER may appoint another OWNER, because ownership is the one role that
 * has to be transferable by the person holding it. Otherwise handing a store
 * to a new proprietor — or adding the spouse who actually runs it — needs a
 * support ticket, and the thing people do when a screen will not let them is
 * share the login.
 */
export const HIGHEST_GRANTABLE: Readonly<Record<StoreRole, StoreRole | null>> = {
  [StoreRole.OWNER]: StoreRole.OWNER,
  [StoreRole.MANAGER]: StoreRole.STAFF,
  [StoreRole.STAFF]: null,
};

/**
 * Human labels for the roles, in Filipino where that is what people say.
 *
 * Here rather than in `access.ts` for a mechanical reason worth knowing: this
 * module is pure, and `access.ts` reaches for the session, which reaches for
 * `next/headers`. A client component importing the labels from there drags the
 * whole server-only chain into the browser bundle, and the build says so —
 * eventually. One shared constant is not worth that.
 */
export const STORE_ROLE_LABELS: Readonly<Record<StoreRole, string>> = {
  [StoreRole.OWNER]: 'May-ari',
  [StoreRole.MANAGER]: 'Manager',
  [StoreRole.STAFF]: 'Staff',
};

/** Most-privileged first, so "at least this role" is an index comparison. */
const ROLE_RANK: Readonly<Record<StoreRole, number>> = {
  [StoreRole.OWNER]: 3,
  [StoreRole.MANAGER]: 2,
  [StoreRole.STAFF]: 1,
};

export function canGrant(actor: StoreRole, requested: StoreRole): boolean {
  const ceiling = HIGHEST_GRANTABLE[actor];
  if (ceiling === null) return false;
  return ROLE_RANK[requested] <= ROLE_RANK[ceiling];
}

/** Every role the actor may choose from, for the form's select. */
export function grantableRoles(actor: StoreRole): StoreRole[] {
  return Object.values(StoreRole).filter((role) => canGrant(actor, role));
}

export function assertCanGrant(actor: StoreRole, requested: StoreRole): void {
  if (!canGrant(actor, requested)) throw new CannotGrantRoleError(actor, requested);
}

/**
 * Whether the actor may take somebody's access away.
 *
 * Anybody may remove THEMSELVES. That is not a loophole: a person who has
 * stopped working at a shop should not need the owner's cooperation to stop
 * appearing in its staff list, and the last-owner rule below still stops the
 * one departure that would strand the store.
 */
export function canRemove(actor: StoreRole, isSelf: boolean): boolean {
  return isSelf || actor === StoreRole.OWNER;
}

export function assertCanRemove(actor: StoreRole, isSelf: boolean): void {
  if (!canRemove(actor, isSelf)) throw new CannotRemoveError();
}

/**
 * Changing an existing member's role.
 *
 * Judged against BOTH roles: an actor who may grant MANAGER but not OWNER must
 * not be able to demote an owner either, or a manager could remove the
 * proprietor's control by "changing their role" rather than by removing them.
 */
export function canChangeRole(
  actor: StoreRole,
  current: StoreRole,
  next: StoreRole,
): boolean {
  return canGrant(actor, next) && canGrant(actor, current);
}

export function assertCanChangeRole(
  actor: StoreRole,
  current: StoreRole,
  next: StoreRole,
): void {
  // Order matters for the MESSAGE, not the outcome: the role somebody already
  // holds is checked first, so a manager reaching for the owner is told that
  // rather than being told something true but irrelevant about staff.
  if (!canGrant(actor, current)) {
    throw new CannotChangeRoleError(actor, current);
  }
  if (!canGrant(actor, next)) {
    throw new CannotGrantRoleError(actor, next);
  }
}

/**
 * Whether a change would leave the store with nobody in charge.
 *
 * The database enforces this too — see `prisma/sql/store_members.sql` — and
 * that is the enforcement that counts, because it holds for code paths that do
 * not exist yet. This function exists so the person gets a sentence explaining
 * what to do instead of a Postgres error, and the two must agree.
 */
export function wouldStrandStore(input: {
  /** Every current member of the store. */
  members: readonly { userId: string; role: StoreRole }[];
  /** The member being changed or removed. */
  userId: string;
  /** Their new role, or null when they are being removed. */
  nextRole: StoreRole | null;
}): boolean {
  const owners = input.members.filter((member) => member.role === StoreRole.OWNER);
  const isOwner = owners.some((member) => member.userId === input.userId);
  if (!isOwner) return false;
  if (owners.length > 1) return false;
  // The only owner. Fine only if they are staying an owner.
  return input.nextRole !== StoreRole.OWNER;
}

// --- Invitations -------------------------------------------------------------

/**
 * How long an invitation is good for.
 *
 * An invite is a grant to whoever can receive an SMS on that number, and
 * Philippine prepaid numbers are recycled after a period of inactivity. A
 * fortnight is long enough for somebody to get around to installing an app and
 * short enough that a forgotten invite does not hand a stranger the order
 * queue two years later.
 */
export const INVITE_VALID_DAYS = 14;

export function inviteExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + INVITE_VALID_DAYS * 24 * 60 * 60 * 1000);
}

/** Still redeemable: not accepted, not revoked, not expired. */
export function inviteIsLive(
  invite: { acceptedAt: Date | null; revokedAt: Date | null; expiresAt: Date },
  now: Date = new Date(),
): boolean {
  return (
    invite.acceptedAt === null &&
    invite.revokedAt === null &&
    invite.expiresAt.getTime() > now.getTime()
  );
}

/** "3 days left", for the pending list. */
export function describeInviteWindow(expiresAt: Date, now: Date = new Date()): string {
  const ms = expiresAt.getTime() - now.getTime();
  if (ms <= 0) return 'expired';
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days >= 1) return `${days} day${days === 1 ? '' : 's'} left`;
  const hours = Math.max(1, Math.floor(ms / (60 * 60 * 1000)));
  return `${hours} hour${hours === 1 ? '' : 's'} left`;
}
