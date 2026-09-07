import Link from 'next/link';
import { notFound } from 'next/navigation';
import { StoreRole } from '@prisma/client';
import { requireAdmin } from '@/lib/admin/access';
import { consoleStoreDetail } from '@/lib/admin/stores';
import {
  describeInviteWindow,
  inviteIsLive,
  STORE_ROLE_LABELS,
} from '@/lib/merchant/staff-policy';
import {
  grantStoreAccessAction,
  revokeStoreAccessAction,
  setStoreVisibilityAction,
} from '@/lib/actions/admin-actions';
import { ReasonForm } from '@/components/admin/ReasonForm';
import { Empty, Panel, PersonLink, Pill, Stat, manilaTime } from '@/components/admin/primitives';
import { displayNameFor } from '@/lib/auth/session';
import { formatPhilippineMobile } from '@/lib/auth/phone';

export const dynamic = 'force-dynamic';

/**
 * One partner shop.
 *
 * The console's job here is narrow on purpose: whether customers can see the
 * shop, and who has the keys. The menu, the prep time and the day-to-day staff
 * are the shop's own, and duplicating those controls would mean two screens
 * that disagree.
 */
export default async function AdminStoreDetailPage({
  params,
}: {
  params: Promise<{ storeId: string }>;
}) {
  const { storeId } = await params;
  await requireAdmin();

  const store = await consoleStoreDetail(storeId);
  if (!store) notFound();

  const now = new Date();
  const liveInvites = store.invites.filter((invite) => inviteIsLive(invite, now));
  const owners = store.members.filter((member) => member.role === StoreRole.OWNER);

  return (
    <div className="space-y-5">
      <div>
        <Link href="/admin/stores" className="text-[11px] font-semibold text-brand-700">
          ← Stores
        </Link>
        <h1 className="mt-1 text-lg font-bold">{store.name}</h1>
        <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
          <span>{store.city.name}</span>
          <span>·</span>
          <span>{store.addressLine}</span>
          <Pill tone={store.isVisible ? 'good' : 'warn'}>
            {store.isVisible ? 'Visible' : 'Hidden'}
          </Pill>
          <Pill tone={store.isOpen ? 'good' : 'neutral'}>
            {store.isOpen ? 'Open' : 'Closed'}
          </Pill>
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Menu items" value={String(store._count.menuItems)} />
        <Stat label="People" value={String(store.members.length)} />
        <Stat
          label="Owners"
          value={String(owners.length)}
          note={owners.length === 0 ? 'nobody can run it' : undefined}
        />
        <Stat label="Invitations waiting" value={String(liveInvites.length)} />
      </div>

      <Panel
        title="Visible to customers"
        description="A shop with no menu that customers can find is worse than one they cannot: they open it, see nothing, and conclude the app is broken."
      >
        <div className="px-4 py-3">
          <ReasonForm
            action={setStoreVisibilityAction}
            hidden={{ storeId: store.id, visible: store.isVisible ? '0' : '1' }}
            submitLabel={store.isVisible ? 'Hide from customers' : 'Make visible'}
            tone={store.isVisible ? 'danger' : 'default'}
          >
            {store.isVisible
              ? 'Customers can find this shop and order from it now.'
              : store._count.menuItems === 0
                ? 'This shop has no menu yet, so it cannot be made visible. The owner adds items from the store back office.'
                : 'Customers cannot find this shop yet.'}
          </ReasonForm>
        </div>
      </Panel>

      <Panel
        title="Who has the keys"
        description="The shop manages its own staff. Use this to name the first owner, or to fix access when nobody at the shop can."
      >
        {store.members.length === 0 ? (
          <Empty>
            Nobody can run this shop. Name an owner below or it can never open.
          </Empty>
        ) : (
          <ul className="divide-y divide-black/5">
            {store.members.map((member) => (
              <li key={member.id} className="px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <span>
                    <PersonLink user={member.user} />
                    <span className="block text-[11px] text-ink-faint">
                      {STORE_ROLE_LABELS[member.role]} · since{' '}
                      {manilaTime(member.createdAt)}
                    </span>
                  </span>
                  <div className="min-w-[16rem]">
                    <ReasonForm
                      action={revokeStoreAccessAction}
                      hidden={{ storeId: store.id, memberId: member.id }}
                      submitLabel="Remove"
                      tone="danger"
                      placeholder="Left the business, ticket number, who asked"
                    >
                      {member.role === StoreRole.OWNER && owners.length === 1
                        ? 'The only owner. Name another owner first — a shop cannot be left with nobody in charge.'
                        : `Removes ${displayNameFor(member.user)}'s access. They are told.`}
                    </ReasonForm>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="border-t border-black/5 px-4 py-3">
          <h3 className="text-[12px] font-bold">Give somebody access</h3>
          <div className="mt-2 max-w-md">
            <ReasonForm
              action={grantStoreAccessAction}
              hidden={{ storeId: store.id }}
              submitLabel="Give access"
              placeholder="Signed partner agreement, onboarding call 7 Sep"
              extraFields={
                <div className="flex flex-wrap items-end gap-2">
                  <label className="min-w-[9rem] flex-1">
                    <span className="block text-[11px] font-semibold text-ink-muted">
                      Mobile number
                    </span>
                    <input
                      name="phone"
                      required
                      type="tel"
                      inputMode="numeric"
                      placeholder="09XX XXX XXXX"
                      className="mt-1 w-full rounded-lg border border-black/10 bg-surface px-2.5 py-1.5 text-[13px] tabular-nums"
                    />
                  </label>
                  <label>
                    <span className="block text-[11px] font-semibold text-ink-muted">
                      Role
                    </span>
                    <select
                      name="role"
                      defaultValue={StoreRole.OWNER}
                      className="mt-1 rounded-lg border border-black/10 bg-surface px-2 py-1.5 text-[13px] font-semibold"
                    >
                      {Object.values(StoreRole).map((role) => (
                        <option key={role} value={role}>
                          {STORE_ROLE_LABELS[role]}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              }
            >
              If that number has no TARA account yet, the invitation waits for
              their first sign-in. Nothing is texted to them — an invite form
              that could message any number would be a way to spend our SMS
              credit on strangers.
            </ReasonForm>
          </div>
        </div>
      </Panel>

      {liveInvites.length > 0 ? (
        <Panel
          title="Invitations waiting"
          description="Numbers with no account yet. They become real access on the first sign-in, and lapse if nobody uses them."
        >
          <ul className="divide-y divide-black/5">
            {liveInvites.map((invite) => (
              <li
                key={invite.id}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-[13px]"
              >
                <span className="tabular-nums">{formatPhilippineMobile(invite.phone)}</span>
                <span className="text-[11px] text-ink-faint">
                  {STORE_ROLE_LABELS[invite.role]} ·{' '}
                  {describeInviteWindow(invite.expiresAt, now)}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}
