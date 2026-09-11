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
} from '@/lib/actions/admin-actions';
import { ReferralStatus } from '@prisma/client';
import { formatCentavos } from '@/lib/money';
import { StoreBrandingControls } from '@/components/admin/StoreBrandingControls';
import { StoreActiveToggle } from '@/components/admin/StoreActiveToggle';
import { StoreProfileForm } from '@/components/admin/StoreProfileForm';
import { StoreMenuPanel } from '@/components/admin/StoreMenuPanel';
import { storeMenu } from '@/lib/merchant/menu';
import { categoriesOf } from '@/lib/merchant/menu-policy';
import { menuImageHref } from '@/lib/media/image-bytes';
import { prisma } from '@/lib/prisma';
import { getAllServices } from '@/lib/services/registry';
import { tileSource } from '@/lib/geo/tiles';
import { geocodingIsAvailable } from '@/lib/geo/geocode';
import { ReasonForm } from '@/components/admin/ReasonForm';
import { Empty, Panel, PersonLink, Pill, Stat, manilaTime } from '@/components/admin/primitives';
import { displayNameFor } from '@/lib/auth/session';
import { formatPhilippineMobile } from '@/lib/auth/phone';

export const dynamic = 'force-dynamic';

/**
 * One partner shop — everything about it, on one page.
 *
 * THE SECOND DRAFT. The first one was narrow on purpose: the console did only
 * what a shop could not do for itself, and everything else lived in the shop's
 * own back office. In practice that meant a shop's details were spread over
 * four screens, two of which did not exist — the name, the address, the city,
 * the coordinates and the services could not be changed ANYWHERE, so a partner
 * who gave the wrong address at onboarding needed somebody with a psql prompt.
 *
 * So the top of this page is now ONE form with ONE button covering every
 * column of `Store` a person may set. Below it sit the things that are not
 * form fields: the two image uploads, who has the keys, and who introduced the
 * shop.
 *
 * The shop's own back office still edits its prep time and its menu. That
 * overlap is deliberate and the two do not disagree — both write the same
 * column, and checkout snapshots the value onto the order anyway.
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

  const [referral, cities, services, menu] = await Promise.all([
    storeAttributionFor(store.id),
    prisma.city.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      // The centroid is what the map falls back to when the city changes.
      select: { id: true, name: true, centroidLat: true, centroidLng: true },
    }),
    getAllServices(),
    storeMenu(store.id),
  ]);

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
          {/* `isOpen` stays a read-only pill: it is the SHOP'S to set from
              their own back office, and the console should not be able to
              open a closed kitchen. */}
          <Pill tone={store.isOpen ? 'good' : 'neutral'}>
            {store.isOpen ? 'Open' : 'Closed'}
          </Pill>
        </p>
        {/* Its own row rather than inline with the address, because it can
            grow a refusal underneath it — "that shop has no menu yet" — and
            in the header line that message shoved the address and the Open
            pill apart and read as a broken layout. */}
        <div className="mt-2">
          <StoreActiveToggle storeId={store.id} active={store.isVisible} />
        </div>
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
        title="Store details"
        description="Everything about this shop in one place. One save covers every section."
      >
        <div className="px-4 py-4">
          <StoreProfileForm
            store={{
              id: store.id,
              name: store.name,
              slug: store.slug,
              description: store.description,
              contactPhone: store.contactPhone,
              cityId: store.cityId,
              addressLine: store.addressLine,
              latitude: store.latitude,
              longitude: store.longitude,
              serviceKeys: store.serviceKeys,
              preparationMinutes: store.preparationMinutes,
              commissionBasisPoints: store.commissionBasisPoints,
              opensAtMinute: store.opensAtMinute,
              closesAtMinute: store.closesAtMinute,
              breakStartMinute: store.breakStartMinute,
              breakEndMinute: store.breakEndMinute,
            }}
            cities={cities}
            services={services.map((service) => ({
              key: service.key,
              displayName: service.displayName,
              isActive: service.isActive,
            }))}
            tiles={tileSource()}
            searchAvailable={geocodingIsAvailable()}
          />
        </div>
      </Panel>

      <StoreMenuPanel
        storeId={store.id}
        items={menu.map((item) => ({
          id: item.id,
          name: item.name,
          category: item.category,
          description: item.description,
          priceCentavos: item.priceCentavos,
          isAvailable: item.isAvailable,
          imageHref: item.image ? menuImageHref(item.image.id) : null,
        }))}
        categories={categoriesOf(menu)}
      />

      {/*
        * SIDE BY SIDE FROM `lg`.
        *
        * Both of these are short — two image slots, and a list that is usually
        * one owner — and stacked they added a screen of scrolling to a page
        * whose whole point is having everything in view. `items-start` so the
        * shorter one does not stretch to match the taller.
        */}
      <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
        {/*
          * THE IMAGES. Two columns that existed from the first migration and
          * that nothing in the console could write — a shop onboarded here got
          * no logo and no banner, and the only fix was a psql prompt. That is
          * also why the storefront grew a tinted-initial fallback for both.
          *
          * UPLOAD FIRST, address second, and that order is the whole point of
          * this panel's second draft. The first one took a web address only,
          * which assumed the picture was already hosted somewhere; an operator
          * holding a JPEG the shop sent them had nowhere to put it, and
          * reported exactly that. The address form is kept below because it is
          * still the only way to point at a picture that lives elsewhere, and
          * the only way to restore one of the seed's `data:` images.
          */}
        <Panel
          title="Logo and banner"
          description="What customers see on the shop list and at the top of the shop's page. Pick a file — it is resized in your browser before it is sent."
        >
          <div className="space-y-4 px-4 py-4">
            <StoreBrandingControls
              storeId={store.id}
              storeName={store.name}
              logoUrl={store.logoUrl}
              coverUrl={store.coverUrl}
            />

            <p className="text-[11px] leading-relaxed text-ink-muted">
              A square logo and a wide banner read best — the storefront crops
              both to fit. JPEG or PNG, at least 120 pixels on each side.
            </p>

            {/* Demoted, not deleted. Collapsed because the case it serves —
                a picture already hosted somewhere — is the rare one. */}
            <details className="rounded-xl bg-surface-sunken p-3 ring-1 ring-black/5">
              <summary className="cursor-pointer text-[12px] font-bold text-ink-muted">
                Use a web address instead
              </summary>
              <div className="mt-3">
                <ReasonForm
                  action={setStoreBrandingAction}
                  hidden={{ storeId: store.id }}
                  submitLabel="Save addresses"
                  extraFields={
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="block">
                        <span className="text-[11px] font-bold text-ink-muted">Logo address</span>
                        <input
                          name="logoUrl"
                          type="text"
                          defaultValue={store.logoUrl ?? ''}
                          placeholder="https://…"
                          className="mt-0.5 w-full rounded-lg bg-white px-3 py-2 font-mono text-[12px] ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
                        />
                      </label>
                      <label className="block">
                        <span className="text-[11px] font-bold text-ink-muted">Banner address</span>
                        <input
                          name="coverUrl"
                          type="text"
                          defaultValue={store.coverUrl ?? ''}
                          placeholder="https://…"
                          className="mt-0.5 w-full rounded-lg bg-white px-3 py-2 font-mono text-[12px] ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
                        />
                      </label>
                    </div>
                  }
                >
                  Both boxes are saved together, so an empty one REMOVES that
                  image. A box showing /store-images/… is a file uploaded above;
                  overwriting it deletes the uploaded copy.
                </ReasonForm>
              </div>
            </details>
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
      </div>

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
