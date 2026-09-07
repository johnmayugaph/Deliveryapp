import { StoreRole } from '@prisma/client';
import { requireStoreAccess, roleSatisfies } from '@/lib/merchant/access';
import { listStaff } from '@/lib/merchant/staff';
import {
  canChangeRole,
  canRemove,
  describeInviteWindow,
  grantableRoles,
  STORE_ROLE_LABELS,
  wouldStrandStore,
} from '@/lib/merchant/staff-policy';
import { formatPhilippineMobile } from '@/lib/auth/phone';
import { displayNameFor } from '@/lib/auth/session';
import { StaffManager } from '@/components/merchant/StaffManager';

export const dynamic = 'force-dynamic';

/**
 * Who works at this store.
 *
 * The screen that replaced editing `StoreMember` rows by hand — which is what
 * onboarding every new waiter used to need, and which ends with one shared
 * login for the whole shop.
 *
 * Every "can I" question is answered HERE, on the server, from the viewer's
 * real membership, and passed down as booleans. The client component renders
 * controls; it never decides who may use them. The same policy functions run
 * again inside the actions, because a hidden button is not an authorisation
 * check.
 */
export default async function MerchantStaffPage({
  params,
}: {
  params: Promise<{ storeId: string }>;
}) {
  const { storeId } = await params;
  const access = await requireStoreAccess(storeId);
  const { members, invites } = await listStaff(access.store.id);

  const roster = members.map((member) => ({ userId: member.userId, role: member.role }));
  const now = new Date();

  return (
    <main className="space-y-4 px-4 py-4 pb-8">
      <div>
        <h1 className="text-base font-bold">Staff</h1>
        <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">
          {access.store.name} · you are {STORE_ROLE_LABELS[access.role].toLowerCase()}
        </p>
      </div>

      <StaffManager
        storeId={access.store.id}
        grantable={grantableRoles(access.role)}
        canInvite={grantableRoles(access.role).length > 0}
        canRevoke={roleSatisfies(access.role, StoreRole.MANAGER)}
        members={members.map((member) => ({
          memberId: member.id,
          userId: member.userId,
          name: displayNameFor(member.user),
          phone: formatPhilippineMobile(member.user.phone),
          role: member.role,
          isYou: member.userId === access.user.id,
          invitedBy: member.invitedBy ? displayNameFor(member.invitedBy) : null,
          // A row is editable only if the viewer could grant BOTH the role they
          // hold now and some other role — otherwise a manager could demote the
          // owner by "changing their role".
          canChange: grantableRoles(access.role).some(
            (role) =>
              role !== member.role &&
              canChangeRole(access.role, member.role, role) &&
              !wouldStrandStore({
                members: roster,
                userId: member.userId,
                nextRole: role,
              }),
          ),
          canRemove:
            canRemove(access.role, member.userId === access.user.id) &&
            !wouldStrandStore({
              members: roster,
              userId: member.userId,
              nextRole: null,
            }),
        }))}
        invites={invites.map((invite) => ({
          inviteId: invite.id,
          phone: formatPhilippineMobile(invite.phone),
          role: invite.role,
          invitedBy: displayNameFor(invite.invitedBy),
          window: describeInviteWindow(invite.expiresAt, now),
        }))}
      />
    </main>
  );
}
