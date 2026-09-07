import {
  NotificationKind,
  StoreRole,
  type Store,
  type StoreInvite,
  type StoreMember,
  type User,
} from '@prisma/client';
import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import { enqueueNotification } from '@/lib/notifications/enqueue';
import { normalisePhilippineMobile } from '@/lib/auth/phone';
import {
  AlreadyAMemberError,
  InviteNotFoundError,
  LastOwnerError,
  assertCanChangeRole,
  assertCanGrant,
  assertCanRemove,
  inviteExpiry,
  inviteIsLive,
  STORE_ROLE_LABELS,
  wouldStrandStore,
} from './staff-policy';

/**
 * Adding, moving and removing a store's people.
 *
 * Until this existed, `StoreMember` rows were written by the seed or by hand,
 * which meant onboarding a partner shop involved somebody with database access
 * for every waiter they hired. That is the sort of friction that ends with one
 * shared login for the whole staff, which is worse than any of the failure
 * modes this file guards against.
 *
 * THE ONE THING THAT MAKES THIS HARDER THAN A FORM: the person a shop owner
 * wants to add usually has no account yet. The two obvious answers are both
 * bad — fabricate an account for an unverified number, or tell the owner to
 * come back after their staff have registered. So access can be offered to a
 * PHONE NUMBER, held as a `StoreInvite`, and redeemed on the first sign-in
 * from that number, which is the moment the OTP has proved who holds the SIM.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: text the number. Nothing here sends an
 * SMS, and that is a decision rather than an omission. An invite form that
 * texted an arbitrary number would be a way for any shop owner to send
 * messages to strangers at our expense, from our sender name. The invited
 * person hears about it from the person inviting them — who knows them, which
 * is why they are being hired — and gets an in-app notification the moment
 * their account exists.
 */

export interface StaffMember extends StoreMember {
  user: Pick<User, 'id' | 'phone' | 'fullName' | 'displayName'>;
  invitedBy: Pick<User, 'id' | 'fullName' | 'displayName' | 'phone'> | null;
}

export interface StaffList {
  members: StaffMember[];
  /** Live only: accepted, revoked and expired invitations are not shown. */
  invites: (StoreInvite & {
    invitedBy: Pick<User, 'id' | 'fullName' | 'displayName' | 'phone'>;
  })[];
}

const PERSON = { id: true, fullName: true, displayName: true, phone: true } as const;

export async function listStaff(
  storeId: string,
  now: Date = new Date(),
): Promise<StaffList> {
  const [members, invites] = await Promise.all([
    prisma.storeMember.findMany({
      where: { storeId },
      include: {
        user: { select: PERSON },
        invitedBy: { select: PERSON },
      },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    }),
    prisma.storeInvite.findMany({
      where: { storeId, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
      include: { invitedBy: { select: PERSON } },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  return { members, invites };
}

// --- Adding somebody ---------------------------------------------------------

export type InviteOutcome =
  | { kind: 'ADDED'; member: StoreMember; phone: string }
  | { kind: 'INVITED'; invite: StoreInvite; phone: string };

/**
 * Offers access to a phone number.
 *
 * Two paths, and which one happens is not a choice the caller makes — it
 * depends on whether that number already has an account:
 *
 *   account exists → the membership is created now, and they are notified
 *   no account     → a `StoreInvite` waits for their first sign-in
 *
 * The role is checked against the ACTOR's role first, because everything after
 * that point is a privilege grant.
 */
export async function inviteToStore(input: {
  storeId: string;
  actorId: string;
  actorRole: StoreRole;
  rawPhone: string;
  role: StoreRole;
}): Promise<InviteOutcome> {
  assertCanGrant(input.actorRole, input.role);

  // Throws InvalidPhoneNumberError, which the action turns into a sentence.
  const phone = normalisePhilippineMobile(input.rawPhone);

  const [store, existing] = await Promise.all([
    prisma.store.findUniqueOrThrow({ where: { id: input.storeId } }),
    prisma.user.findUnique({ where: { phone }, select: { id: true } }),
  ]);

  if (existing) {
    const already = await prisma.storeMember.findUnique({
      where: { storeId_userId: { storeId: input.storeId, userId: existing.id } },
      select: { id: true },
    });
    if (already) throw new AlreadyAMemberError();

    const member = await prisma.$transaction(async (tx) => {
      const created = await tx.storeMember.create({
        data: {
          storeId: input.storeId,
          userId: existing.id,
          role: input.role,
          invitedById: input.actorId,
        },
      });
      // Any invite for this number is now spent — otherwise it would sit there
      // and be "redeemed" again on their next sign-in, silently restoring a
      // role somebody had since changed.
      await tx.storeInvite.updateMany({
        where: { storeId: input.storeId, phone, acceptedAt: null },
        data: { acceptedAt: new Date(), acceptedById: existing.id },
      });
      await notifyAccessChanged(
        { userId: existing.id, store, role: input.role, event: 'GRANTED' },
        tx,
      );
      return created;
    });

    return { kind: 'ADDED', member, phone };
  }

  // Nobody owns that number here yet. Upsert rather than create: re-inviting
  // the same number should refresh the offer — a new expiry, possibly a new
  // role, revocation cleared — not fail or leave two rows.
  const invite = await prisma.storeInvite.upsert({
    where: { storeId_phone: { storeId: input.storeId, phone } },
    create: {
      storeId: input.storeId,
      phone,
      role: input.role,
      invitedById: input.actorId,
      expiresAt: inviteExpiry(),
    },
    update: {
      role: input.role,
      invitedById: input.actorId,
      expiresAt: inviteExpiry(),
      revokedAt: null,
      acceptedAt: null,
      acceptedById: null,
    },
  });

  return { kind: 'INVITED', invite, phone };
}

// --- Changing and removing ---------------------------------------------------

export async function changeStoreRole(input: {
  storeId: string;
  actorId: string;
  actorRole: StoreRole;
  memberId: string;
  role: StoreRole;
}): Promise<StoreMember> {
  const [member, members, store] = await Promise.all([
    prisma.storeMember.findFirst({
      where: { id: input.memberId, storeId: input.storeId },
    }),
    prisma.storeMember.findMany({
      where: { storeId: input.storeId },
      select: { userId: true, role: true },
    }),
    prisma.store.findUniqueOrThrow({ where: { id: input.storeId } }),
  ]);
  if (!member) throw new InviteNotFoundError();

  assertCanChangeRole(input.actorRole, member.role, input.role);

  if (
    wouldStrandStore({ members, userId: member.userId, nextRole: input.role })
  ) {
    throw new LastOwnerError();
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.storeMember.update({
      where: { id: member.id },
      data: { role: input.role },
    });
    // Not told when somebody changes their own role — they are looking at the
    // screen that did it.
    if (member.userId !== input.actorId) {
      await notifyAccessChanged(
        { userId: member.userId, store, role: input.role, event: 'ROLE_CHANGED' },
        tx,
      );
    }
    return updated;
  });
}

export async function removeFromStore(input: {
  storeId: string;
  actorId: string;
  actorRole: StoreRole;
  memberId: string;
}): Promise<{ userId: string; wasSelf: boolean }> {
  const [member, members, store] = await Promise.all([
    prisma.storeMember.findFirst({
      where: { id: input.memberId, storeId: input.storeId },
    }),
    prisma.storeMember.findMany({
      where: { storeId: input.storeId },
      select: { userId: true, role: true },
    }),
    prisma.store.findUniqueOrThrow({ where: { id: input.storeId } }),
  ]);
  if (!member) throw new InviteNotFoundError();

  const isSelf = member.userId === input.actorId;
  assertCanRemove(input.actorRole, isSelf);

  if (wouldStrandStore({ members, userId: member.userId, nextRole: null })) {
    throw new LastOwnerError();
  }

  await prisma.$transaction(async (tx) => {
    await tx.storeMember.delete({ where: { id: member.id } });
    if (!isSelf) {
      await notifyAccessChanged(
        { userId: member.userId, store, role: member.role, event: 'REMOVED' },
        tx,
      );
    }
  });

  return { userId: member.userId, wasSelf: isSelf };
}

/** Withdraws an offer that has not been taken up. */
export async function revokeInvite(input: {
  storeId: string;
  inviteId: string;
}): Promise<StoreInvite> {
  const invite = await prisma.storeInvite.findFirst({
    where: { id: input.inviteId, storeId: input.storeId },
  });
  if (!invite || !inviteIsLive(invite)) throw new InviteNotFoundError();

  return prisma.storeInvite.update({
    where: { id: invite.id },
    data: { revokedAt: new Date() },
  });
}

// --- The console's own path --------------------------------------------------

/**
 * Store access granted by an ADMINISTRATOR rather than by the shop.
 *
 * Separate from `inviteToStore` for one reason: there is nobody at a brand-new
 * partner store who could invite the first owner, so the console has to be
 * able to create one. It therefore does not take an `actorRole` and does not
 * consult `HIGHEST_GRANTABLE` — the console's authority comes from
 * `requireAdmin()` and is recorded in the audit log by the action that calls
 * this, which is the console's equivalent of the same protection.
 *
 * Everything else still holds: a number is normalised, an existing membership
 * is a conflict rather than a silent overwrite, and a store cannot be left
 * without an owner.
 */
export async function grantStoreAccessAsAdmin(
  input: {
    storeId: string;
    adminId: string;
    rawPhone: string;
    role: StoreRole;
  },
  client?: PrismaTransactionClient,
): Promise<InviteOutcome> {
  const db = client ?? prisma;
  const phone = normalisePhilippineMobile(input.rawPhone);

  const store = await db.store.findUniqueOrThrow({ where: { id: input.storeId } });
  const existing = await db.user.findUnique({
    where: { phone },
    select: { id: true },
  });

  if (existing) {
    const already = await db.storeMember.findUnique({
      where: { storeId_userId: { storeId: input.storeId, userId: existing.id } },
      select: { id: true },
    });
    if (already) throw new AlreadyAMemberError();

    const member = await db.storeMember.create({
      data: {
        storeId: input.storeId,
        userId: existing.id,
        role: input.role,
        invitedById: input.adminId,
      },
    });
    await db.storeInvite.updateMany({
      where: { storeId: input.storeId, phone, acceptedAt: null },
      data: { acceptedAt: new Date(), acceptedById: existing.id },
    });
    await notifyAccessChanged(
      { userId: existing.id, store, role: input.role, event: 'GRANTED' },
      client,
    );
    return { kind: 'ADDED', member, phone };
  }

  const invite = await db.storeInvite.upsert({
    where: { storeId_phone: { storeId: input.storeId, phone } },
    create: {
      storeId: input.storeId,
      phone,
      role: input.role,
      invitedById: input.adminId,
      expiresAt: inviteExpiry(),
    },
    update: {
      role: input.role,
      invitedById: input.adminId,
      expiresAt: inviteExpiry(),
      revokedAt: null,
      acceptedAt: null,
      acceptedById: null,
    },
  });
  return { kind: 'INVITED', invite, phone };
}

/**
 * Takes store access away, from the console.
 *
 * Unlike the shop's own version this has no self-removal case — an
 * administrator is never a member of the store they are administering — but
 * the last-owner rule applies just the same. Leaving a store with nobody in
 * charge from the console would be exactly as broken as doing it from the shop.
 */
export async function revokeStoreAccessAsAdmin(input: {
  storeId: string;
  memberId: string;
}): Promise<{ userId: string; role: StoreRole }> {
  const [member, members, store] = await Promise.all([
    prisma.storeMember.findFirst({
      where: { id: input.memberId, storeId: input.storeId },
    }),
    prisma.storeMember.findMany({
      where: { storeId: input.storeId },
      select: { userId: true, role: true },
    }),
    prisma.store.findUniqueOrThrow({ where: { id: input.storeId } }),
  ]);
  if (!member) throw new InviteNotFoundError();

  if (wouldStrandStore({ members, userId: member.userId, nextRole: null })) {
    throw new LastOwnerError();
  }

  await prisma.$transaction(async (tx) => {
    await tx.storeMember.delete({ where: { id: member.id } });
    await notifyAccessChanged(
      { userId: member.userId, store, role: member.role, event: 'REMOVED' },
      tx,
    );
  });

  return { userId: member.userId, role: member.role };
}

// --- Redemption --------------------------------------------------------------

export interface RedeemedInvite {
  storeId: string;
  storeName: string;
  role: StoreRole;
}

/**
 * Turns live invitations for a number into real memberships.
 *
 * Called from `checkLoginCode`, right after the OTP has been verified and the
 * account upserted. That is the only honest moment for it: before then nobody
 * has proved they hold the number, and an invite is a grant to whoever does.
 *
 * Never throws. A failure here must not stop somebody signing in — the invite
 * stays live and is redeemed on their next attempt, whereas a login that fails
 * because of a store invitation would be baffling and unfixable by the person
 * it happened to.
 */
export async function redeemStoreInvites(input: {
  userId: string;
  phone: string;
  now?: Date;
}): Promise<RedeemedInvite[]> {
  const now = input.now ?? new Date();
  const redeemed: RedeemedInvite[] = [];

  try {
    const invites = await prisma.storeInvite.findMany({
      where: {
        phone: input.phone,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      include: { store: true },
    });

    for (const invite of invites) {
      await prisma.$transaction(async (tx) => {
        // Somebody may already have been added directly in the meantime. The
        // existing membership wins: it is the more recent decision, and an
        // invite must not quietly demote or promote anybody.
        const existing = await tx.storeMember.findUnique({
          where: {
            storeId_userId: { storeId: invite.storeId, userId: input.userId },
          },
          select: { id: true },
        });

        if (!existing) {
          await tx.storeMember.create({
            data: {
              storeId: invite.storeId,
              userId: input.userId,
              role: invite.role,
              invitedById: invite.invitedById,
            },
          });
          // Told, and this is the one place it really matters: somebody
          // invited before they had an account signs in, lands on the customer
          // home screen, and would otherwise have no idea a shop is waiting
          // for them.
          await notifyAccessChanged(
            {
              userId: input.userId,
              store: invite.store,
              role: invite.role,
              event: 'GRANTED',
            },
            tx,
          );
          redeemed.push({
            storeId: invite.storeId,
            storeName: invite.store.name,
            role: invite.role,
          });
        }

        await tx.storeInvite.update({
          where: { id: invite.id },
          data: { acceptedAt: now, acceptedById: input.userId },
        });
      });
    }
  } catch {
    // Swallowed on purpose — see the note above. Nothing is lost: an
    // unaccepted invite is still unaccepted.
    return redeemed;
  }

  return redeemed;
}

/**
 * Clears out invitations nobody took up.
 *
 * Tidying rather than enforcement: an expired invite already redeems nothing,
 * because `redeemStoreInvites` filters on `expiresAt`. This keeps the table
 * from accumulating offers to numbers that never signed up.
 */
export async function pruneExpiredInvites(now: Date = new Date()): Promise<number> {
  const { count } = await prisma.storeInvite.deleteMany({
    where: { acceptedAt: null, expiresAt: { lt: now } },
  });
  return count;
}

// --- Telling people ----------------------------------------------------------

async function notifyAccessChanged(
  input: {
    userId: string;
    store: Store;
    role: StoreRole;
    event: 'GRANTED' | 'ROLE_CHANGED' | 'REMOVED';
  },
  client?: PrismaTransactionClient,
): Promise<void> {
  await enqueueNotification(
    {
      userId: input.userId,
      kind: NotificationKind.STORE_ACCESS_CHANGED,
      context: {
        storeName: input.store.name,
        storeRoleLabel: STORE_ROLE_LABELS[input.role],
        storeAccessEvent: input.event,
      },
      // A removal has nowhere useful to send them, and a link into a store
      // they can no longer open would be worse than no link.
      ...(input.event === 'REMOVED' ? {} : { href: `/merchant/${input.store.id}` }),
      // Keyed on the moment, not on the membership: somebody added, removed
      // and added again has been told three true things.
      dedupeKey: `store-access:${input.store.id}:${input.userId}:${input.event}:${Date.now()}`,
    },
    client,
  );
}
