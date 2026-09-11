import Link from 'next/link';
import { notFound } from 'next/navigation';
import { StoreRole } from '@prisma/client';
import { requireAdmin } from '@/lib/admin/access';
import { consoleStoreDetail } from '@/lib/admin/stores';
import { storeAttributionFor } from '@/lib/admin/store-referrals';
import {
  describeInviteWindow,
  inviteIsLive,
  STORE_ROLE_LABELS,
} from '@/lib/merchant/staff-policy';
import {
  attributeStoreReferralAction,
  grantStoreAccessAction,
  revokeStoreAccessAction,
  setStoreBrandingAction,
  setStoreVisibilityAction,
} from '@/lib/actions/admin-actions';
import { ReferralStatus } from '@prisma/client';
import { formatCentavos } from '@/lib/money';
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

  const referral = await storeAttributionFor(store.id);

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

      {/*
        * THE IMAGES. These two columns existed from the first migration and
        * nothing in the console could write them — a shop onboarded here got
        * no logo and no banner, and the only fix was a psql prompt. That is
        * also why the storefront grew a tinted-initial fallback for both.
        *
        * Shown as well as edited: an operator should be able to see what is
        * live on a customer's screen without opening the storefront, because
        * the case that matters is a WRONG image, and you cannot fix what you
        * cannot see.
        */}
      <Panel
        title="Logo and banner"
        description="What customers see on the shop list and at the top of its page. Paste an https:// link, or leave a box empty to remove that image."
      >
        <div className="space-y-4 px-4 py-4">
          <div className="flex flex-wrap items-start gap-5">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wide text-ink-muted">
                Logo
              </p>
              {store.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={store.logoUrl}
                  alt=""
                  width={128}
                  height={128}
                  className="mt-1 h-16 w-16 rounded-xl object-cover ring-1 ring-black/5"
                />
              ) : (
                <p className="mt-1 flex h-16 w-16 items-center justify-center rounded-xl bg-surface-sunken text-[11px] text-ink-faint ring-1 ring-black/5">
                  None
                </p>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-bold uppercase tracking-wide text-ink-muted">
                Banner
              </p>
              {store.coverUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={store.coverUrl}
                  alt=""
                  width={640}
                  height={240}
                  className="mt-1 h-16 w-full max-w-sm rounded-xl object-cover ring-1 ring-black/5"
                />
              ) : (
                <p className="mt-1 flex h-16 w-full max-w-sm items-center justify-center rounded-xl bg-surface-sunken text-[11px] text-ink-faint ring-1 ring-black/5">
                  None
                </p>
              )}
            </div>
          </div>

          <ReasonForm
            action={setStoreBrandingAction}
            hidden={{ storeId: store.id }}
            submitLabel="Save images"
            extraFields={
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="text-[11px] font-bold text-ink-muted">Logo address</span>
                  <input
                    name="logoUrl"
                    type="text"
                    defaultValue={store.logoUrl ?? ''}
                    placeholder="https://…"
                    className="mt-0.5 w-full rounded-lg bg-surface-sunken px-3 py-2 font-mono text-[12px] ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                </label>
                <label className="block">
                  <span className="text-[11px] font-bold text-ink-muted">Banner address</span>
                  <input
                    name="coverUrl"
                    type="text"
                    defaultValue={store.coverUrl ?? ''}
                    placeholder="https://…"
                    className="mt-0.5 w-full rounded-lg bg-surface-sunken px-3 py-2 font-mono text-[12px] ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                </label>
              </div>
            }
          >
            A square logo and a wide banner read best — the storefront crops
            both to fit. An empty box removes that image.
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


      <Panel
        title="Who introduced this shop"
        description="The one referral attribution in TARA that a person makes. A shop does not sign itself up, so there is no code — this is the form instead, and your name goes on it."
      >
        {referral.existing ? (
          <div className="space-y-2 px-4 py-3">
            <p className="text-[13px]">
              <Link
                href={`/admin/stores/${referral.existing.referrerStoreId}`}
                className="font-semibold text-brand-700"
              >
                {referral.existing.referrerName}
              </Link>{' '}
              introduced this shop.{' '}
              <Pill
                tone={
                  referral.existing.status === ReferralStatus.REWARDED
                    ? 'good'
                    : referral.existing.status === ReferralStatus.NOT_REWARDED
                      ? 'bad'
                      : 'neutral'
                }
              >
                {referral.existing.status === ReferralStatus.REWARDED
                  ? 'Bonus owed'
                  : referral.existing.status === ReferralStatus.NOT_REWARDED
                    ? 'No bonus'
                    : 'Trading towards it'}
              </Pill>
            </p>
            <p className="text-xs leading-relaxed text-ink-muted">
              Recorded by {referral.existing.attributedByName} on{' '}
              {manilaTime(referral.existing.createdAt)} —{' '}
              <span className="italic">
                &ldquo;{referral.existing.attributionNote}&rdquo;
              </span>
            </p>
            {referral.existing.status === ReferralStatus.ATTRIBUTED ? (
              <p className="text-xs leading-relaxed text-ink-muted">
                This shop has earned{' '}
                <strong className="text-ink">
                  {formatCentavos(referral.earnedCentavos)}
                </strong>{' '}
                through TARA
                {referral.isLive ? (
                  <>
                    {' '}
                    of the{' '}
                    {formatCentavos(
                      referral.programme.qualifyingEarningsCentavos,
                    )}{' '}
                    the bonus needs. It is paid on the order that crosses that
                    line, into both shops&rsquo; settlement balances.
                  </>
                ) : (
                  <>
                    . Shop referrals are switched off, so nothing is owed on
                    this until they are switched back on.
                  </>
                )}
              </p>
            ) : (
              <p className="text-xs leading-relaxed text-ink-muted">
                {formatCentavos(referral.existing.referrerRewardCentavos)} to{' '}
                {referral.existing.referrerName},{' '}
                {formatCentavos(referral.existing.refereeRewardCentavos)} to
                this shop, against{' '}
                {formatCentavos(
                  referral.existing.qualifyingEarningsCentavos ?? 0,
                )}{' '}
                earned.
                {referral.existing.blockedReason
                  ? ` ${referral.existing.blockedReason}`
                  : ''}
              </p>
            )}
            <p className="text-[11px] leading-relaxed text-ink-faint">
              An attribution cannot be edited or moved to another shop. It is a
              claim somebody made about the world, and a bonus may already have
              been paid against it — if it is wrong, adjust the settlement
              balance instead, where the correction is recorded as one.
            </p>
          </div>
        ) : !referral.isLive ? (
          <Empty>
            Shop referrals are switched off, so there is nothing to record.
            Turn the programme on under Referrals first — attributing a shop
            while it is off would promise a bonus no rule would pay.
          </Empty>
        ) : referral.earnedCentavos > 0 ? (
          <Empty>
            This shop has already earned{' '}
            {formatCentavos(referral.earnedCentavos)} through TARA, so it was
            trading before anybody introduced it. Referrals are for shops that
            are new, and the rule refuses this one.
          </Empty>
        ) : referral.candidates.length === 0 ? (
          <Empty>
            No other visible shop in {store.city.name} to attribute this one
            to. A shop introduced by one in another city is possible — record
            it by hand.
          </Empty>
        ) : (
          <div className="border-t border-black/5 px-4 py-3">
            <div className="max-w-md">
              <ReasonForm
                action={attributeStoreReferralAction}
                hidden={{ storeId: store.id }}
                submitLabel="Record the introduction"
                placeholder="Owner named them on the onboarding call, 7 Sep"
                extraFields={
                  <label className="block">
                    <span className="block text-[11px] font-semibold text-ink-muted">
                      Introduced by
                    </span>
                    <select
                      name="referrerStoreId"
                      required
                      defaultValue=""
                      className="mt-1 w-full rounded-lg border border-black/10 bg-surface px-2 py-1.5 text-[13px] font-semibold"
                    >
                      <option value="" disabled>
                        Pick a shop in {store.city.name}
                      </option>
                      {referral.candidates.map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>
                          {candidate.name}
                        </option>
                      ))}
                    </select>
                  </label>
                }
              >
                Nothing is paid now. Once this shop has earned{' '}
                {formatCentavos(referral.programme.qualifyingEarningsCentavos)}{' '}
                through TARA,{' '}
                {formatCentavos(referral.programme.referrerCentavos)} is added
                to the introducing shop&rsquo;s settlement balance and{' '}
                {formatCentavos(referral.programme.refereeCentavos)} to this
                one, and both go out with their next payouts. Say who told you
                — the note is the only evidence this introduction happened.
              </ReasonForm>
            </div>
          </div>
        )}
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
