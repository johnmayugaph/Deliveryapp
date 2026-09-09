import Link from 'next/link';
import { UserRole } from '@prisma/client';
import { displayNameFor, listActiveSessions } from '@/lib/auth/session';
import { requireScreen } from '@/lib/auth/access';
import { prisma } from '@/lib/prisma';
import { formatAddressLine, listAddressBook } from '@/lib/addresses/usage';
import { formatPhilippineMobile } from '@/lib/auth/phone';
import { getAccessibleStores } from '@/lib/merchant/access';
import { getLaunchedPlan } from '@/lib/subscriptions/plans';
import { liveSubscription } from '@/lib/subscriptions/enrollment';
import { outstandingInvoiceFor } from '@/lib/subscriptions/billing';
import { invoiceState, planRow, planStanding } from '@/lib/subscriptions/billing-policy';
import { fleetRow, fleetStanding } from '@/lib/fleet/standing';
import { formatCentavos } from '@/lib/money';
import { countUnread } from '@/lib/notifications/inbox';
import { SignOutButton } from '@/components/auth/SignOutButton';
import { ActiveSessions } from '@/components/auth/ActiveSessions';
import { RecoveryEmail } from '@/components/auth/RecoveryEmail';
import { isEmailConfigured } from '@/lib/auth/email';
import { formatFullDayIn } from '@/lib/time/manila';

export const dynamic = 'force-dynamic';

/**
 * Profile.
 *
 * Renders roles from the `roles` ARRAY, so someone who is both a customer and a
 * fleet partner sees both.
 *
 * Every claim this screen makes about a state goes through a rule module —
 * `fleet/standing` for the fleet row, `subscriptions/billing-policy` for the
 * plan, `auth/devices` for the device list — because it makes claims about
 * three subsystems it does not own, and it had drifted from all three. It said
 * "Aktibo hanggang" about a subscription conferring nothing, "Approved sa 2
 * service" to a suspended rider, "Awaiting approval" to a refused one, and
 * "Last used Sep 4" about the session rendering the page. Each module names
 * its own defect.
 *
 * The doc comment here used to claim it rendered "the per-service approvals
 * that decide what work they are actually offered". It never did: the rows
 * were loaded, with a nested join, and dropped. They are read now — as a
 * standing, with the per-service detail left on `/fleet/profile` where a
 * refusal reason belongs beside the service it refused.
 */

const ROLE_LABELS: Readonly<Record<UserRole, string>> = {
  [UserRole.CUSTOMER]: 'Customer',
  [UserRole.FLEET_PARTNER]: 'Fleet partner',
  [UserRole.MERCHANT_OWNER]: 'Merchant',
  [UserRole.SUPPORT_AGENT]: 'Support',
  [UserRole.ADMIN]: 'Admin',
};

export default async function ProfilePage() {
  const user = await requireScreen('profile');

  // One clock for the whole render: a screen whose fleet row and plan row
  // resolve `now` separately is a screen that can disagree with itself on a
  // boundary.
  const renderedAt = new Date();

  const [
    addresses,
    fleetPartner,
    sessions,
    stores,
    plan,
    subscription,
    invoice,
    unreadCount,
  ] = await Promise.all([
    listAddressBook({ userId: user.id, limit: 5 }),
    prisma.fleetPartner.findUnique({
      where: { userId: user.id },
      /* The verification ROWS, not the denormalised `enabledServices` count:
         suspension leaves approvals intact and an expiry is only resynced
         when somebody decides something, so the copy outlives the fact. The
         `service` join is gone with the count — the per-service names are on
         `/fleet/profile`, and joining five rows to render a number was the
         shape of the bug. */
      select: {
        isSuspended: true,
        isOnline: true,
        serviceVerifications: { select: { status: true, expiresAt: true } },
      },
    }),
    listActiveSessions(user.id),
    getAccessibleStores(),
    getLaunchedPlan(),
    liveSubscription(user.id),
    outstandingInvoiceFor(user.id, renderedAt),
    countUnread(user.id),
  ]);

  const fleet = fleetRow(fleetStanding(fleetPartner, renderedAt));

  const standing = planStanding({
    launchedPlanName: plan?.name ?? null,
    subscription:
      subscription === null
        ? null
        : {
            status: subscription.status,
            renewsAt: subscription.renewsAt,
            endedAt: subscription.endedAt,
            // A grant survives its plan being pulled and confers nothing
            // while it is. `getActiveSubscription` filters on exactly this.
            planIsLaunched: subscription.plan.isActive,
            planName: subscription.plan.name,
          },
    now: renderedAt,
  });
  const planLine =
    standing === null
      ? null
      : planRow({
          standing,
          bill:
            invoice === null
              ? null
              : {
                  amountCentavos: invoice.amountCentavos,
                  dueAt: invoice.dueAt,
                  state: invoiceState(invoice, renderedAt),
                },
          formatMoney: formatCentavos,
          formatDay: formatFullDayIn,
        });

  return (
    <main>
      <header className="bg-surface px-4 pb-4 pt-5">
        <h1 className="text-xl font-bold">{displayNameFor(user)}</h1>
        <p className="mt-0.5 text-xs text-ink-muted tabular-nums">
          {formatPhilippineMobile(user.phone)}
        </p>
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {user.roles.map((role) => (
            <li
              key={role}
              className="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-semibold text-brand-800"
            >
              {ROLE_LABELS[role]}
            </li>
          ))}
        </ul>
      </header>

      {stores.length > 0 ? (
        <section aria-labelledby="store-heading" className="mt-4 px-4">
          <h2
            id="store-heading"
            className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted"
          >
            Store
          </h2>
          <Link
            href="/merchant"
            className="mt-2 flex items-center justify-between rounded-xl bg-surface px-3 py-3 shadow-sm ring-1 ring-black/5 transition-colors hover:bg-brand-50/40"
          >
            <span className="min-w-0">
              <span className="block text-sm font-semibold">Buksan ang store</span>
              <span className="mt-0.5 block text-[11px] text-ink-muted">
                {stores.length === 1
                  ? stores[0]!.store.name
                  : `${stores.length} stores`}
              </span>
            </span>
            <span aria-hidden className="text-xs text-ink-faint">
              ›
            </span>
          </Link>
        </section>
      ) : null}

      <section aria-labelledby="addresses-heading" className="mt-4 px-4">
        <div className="flex items-baseline justify-between">
          <h2
            id="addresses-heading"
            className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted"
          >
            Saved addresses
          </h2>
          <Link href="/addresses" className="text-xs font-semibold text-brand-700">
            Manage
          </Link>
        </div>
        <p className="mt-1 text-[11px] text-ink-faint">
          One address book for every service.
        </p>
        {addresses.length === 0 ? (
          <p className="mt-2 text-sm text-ink-muted">No saved addresses yet.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {addresses.map((address) => (
              <li
                key={address.id}
                className="rounded-xl bg-surface p-3 shadow-sm ring-1 ring-black/5"
              >
                <span className="flex items-center gap-2">
                  <span className="text-sm font-semibold">{address.label}</span>
                  {address.isPickupCapable ? (
                    <span className="rounded-full bg-mart-soft px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-mart-bold">
                      Pickup ok
                    </span>
                  ) : null}
                </span>
                <span className="mt-0.5 block text-xs text-ink-muted">
                  {formatAddressLine(address)}
                </span>
                <span className="mt-1 block text-[11px] text-ink-faint">
                  Ginamit {address.usageCount}x
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="inbox-heading" className="mt-5 px-4">
        <h2
          id="inbox-heading"
          className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted"
        >
          Notifications
        </h2>
        <Link
          href="/notifications"
          className="mt-2 flex items-center justify-between gap-3 rounded-xl bg-surface px-4 py-3 shadow-sm ring-1 ring-black/5"
        >
          <span className="min-w-0">
            <span className="block text-sm font-semibold">Inbox and SMS</span>
            <span className="mt-0.5 block text-[11px] text-ink-muted">
              {unreadCount > 0
                ? `${unreadCount} unread`
                : 'Every update in one place'}
            </span>
          </span>
          {unreadCount > 0 ? (
            <span className="shrink-0 rounded-full bg-rose-600 px-2 text-[11px] font-bold leading-5 text-white tabular-nums">
              {unreadCount}
            </span>
          ) : (
            <span aria-hidden className="text-xs text-ink-faint">
              ›
            </span>
          )}
        </Link>
      </section>

      {/* Null when no plan is launched and nobody is enrolled: no row, rather
          than advertising a tier that does not exist yet. That decision is
          `planStanding`'s now, along with which of the four live readings may
          say "aktibo" — one of them. */}
      {planLine ? (
        <section aria-labelledby="plus-heading" className="mt-5 px-4">
          <h2
            id="plus-heading"
            className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted"
          >
            Plan
          </h2>
          <Link
            href="/plus"
            className="mt-2 flex items-center justify-between gap-3 rounded-xl bg-surface px-4 py-3 shadow-sm ring-1 ring-black/5"
          >
            <span className="min-w-0">
              <span className="block text-sm font-semibold">{planLine.name}</span>
              <span
                className={`mt-0.5 block text-[11px] ${
                  planLine.needsAttention ? 'text-amber-800' : 'text-ink-muted'
                }`}
              >
                {planLine.note}
              </span>
              {/* What is owed and by when. The reason somebody opens /plus,
                  and the thing the old row replaced with a reassurance. */}
              {planLine.bill ? (
                <span className="mt-0.5 block text-[11px] font-semibold tabular-nums text-amber-800">
                  {planLine.bill}
                </span>
              ) : null}
            </span>
            <span aria-hidden className="text-xs text-ink-faint">
              ›
            </span>
          </Link>
        </section>
      ) : null}

      <section aria-labelledby="fleet-heading" className="mt-5 px-4">
        <h2
          id="fleet-heading"
          className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted"
        >
          Fleet
        </h2>
        <Link
          href={fleet.href}
          className="mt-2 flex items-center justify-between rounded-xl bg-surface px-3 py-3 shadow-sm ring-1 ring-black/5 transition-colors hover:bg-brand-50/40"
        >
          <span className="min-w-0">
            <span className="block text-sm font-semibold">{fleet.title}</span>
            <span
              className={`mt-0.5 block text-[11px] ${
                fleet.needsAttention ? 'text-amber-800' : 'text-ink-muted'
              }`}
            >
              {fleet.note}
            </span>
          </span>
          <span aria-hidden className="text-xs text-ink-faint">
            ›
          </span>
        </Link>
        {fleetPartner ? (
          <p className="mt-1.5 text-[11px] text-ink-faint">
            Approved for one service is not approved for all of them.
          </p>
        ) : null}
      </section>

      {/* Above the session list on purpose: "how do I get back in" comes
          before "who is signed in", for somebody scanning this screen after
          losing a phone. */}
      <RecoveryEmail
        email={user.email}
        verified={user.emailVerifiedAt !== null}
        available={isEmailConfigured()}
      />

      <ActiveSessions sessions={sessions} />

      <section className="mt-5 space-y-2 px-4 pb-8">
        <Link
          href="/help"
          className="flex items-center justify-between rounded-xl bg-surface px-3 py-3 shadow-sm ring-1 ring-black/5"
        >
          <span className="text-sm font-semibold">Help and support</span>
          <span aria-hidden className="text-xs text-ink-faint">
            ›
          </span>
        </Link>
        <SignOutButton />
      </section>
    </main>
  );
}
