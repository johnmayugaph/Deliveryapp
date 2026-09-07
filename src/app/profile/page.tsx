import Link from 'next/link';
import { redirect } from 'next/navigation';
import { UserRole } from '@prisma/client';
import {
  displayNameFor,
  getCurrentUser,
  listActiveSessions,
} from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { formatAddressLine, listAddressBook } from '@/lib/addresses/usage';
import { formatPhilippineMobile } from '@/lib/auth/phone';
import { getAccessibleStores } from '@/lib/merchant/access';
import { getLaunchedPlan } from '@/lib/subscriptions/plans';
import { liveSubscription } from '@/lib/subscriptions/enrollment';
import { countUnread } from '@/lib/notifications/inbox';
import { SignOutButton } from '@/components/auth/SignOutButton';
import { ActiveSessions } from '@/components/auth/ActiveSessions';
import { RecoveryEmail } from '@/components/auth/RecoveryEmail';
import { isEmailConfigured } from '@/lib/auth/email';

export const dynamic = 'force-dynamic';

/**
 * Profile.
 *
 * Renders roles from the `roles` ARRAY, so someone who is both a customer and a
 * fleet partner sees both — including the per-service approvals that decide
 * what work they are actually offered.
 */

const ROLE_LABELS: Readonly<Record<UserRole, string>> = {
  [UserRole.CUSTOMER]: 'Customer',
  [UserRole.FLEET_PARTNER]: 'Fleet partner',
  [UserRole.MERCHANT_OWNER]: 'Merchant',
  [UserRole.SUPPORT_AGENT]: 'Support',
  [UserRole.ADMIN]: 'Admin',
};

export default async function ProfilePage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect('/login?next=%2Fprofile');
  }

  const [addresses, fleetPartner, sessions, stores, plan, subscription, unreadCount] =
    await Promise.all([
      listAddressBook({ userId: user.id, limit: 5 }),
      prisma.fleetPartner.findUnique({
        where: { userId: user.id },
        include: { serviceVerifications: { include: { service: true } } },
      }),
      listActiveSessions(user.id),
      getAccessibleStores(),
      getLaunchedPlan(),
      liveSubscription(user.id),
      countUnread(user.id),
    ]);

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

      {/* Only shown when there is something to show: no plan launched and no
          subscription means no row, rather than advertising a tier that does
          not exist yet. */}
      {plan || subscription ? (
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
              <span className="block text-sm font-semibold">
                {subscription?.plan.name ?? plan?.name}
              </span>
              <span className="mt-0.5 block text-[11px] text-ink-muted">
                {subscription
                  ? `Aktibo hanggang ${subscription.renewsAt.toLocaleDateString('en-PH', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })}`
                  : 'See what is included'}
              </span>
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
        {fleetPartner ? (
          <>
            <Link
              href="/fleet"
              className="mt-2 flex items-center justify-between rounded-xl bg-surface px-3 py-3 shadow-sm ring-1 ring-black/5 transition-colors hover:bg-brand-50/40"
            >
              <span className="min-w-0">
                <span className="block text-sm font-semibold">Buksan ang fleet app</span>
                <span className="mt-0.5 block text-[11px] text-ink-muted">
                  {fleetPartner.enabledServices.length > 0
                    ? `Approved sa ${fleetPartner.enabledServices.length} service`
                    : 'Awaiting approval'}
                  {fleetPartner.isOnline ? ' · online' : ''}
                </span>
              </span>
              <span aria-hidden className="text-xs text-ink-faint">
                ›
              </span>
            </Link>
            <p className="mt-1.5 text-[11px] text-ink-faint">
              Approved for one service is not approved for all of them.
            </p>
          </>
        ) : (
          <Link
            href="/fleet/apply"
            className="mt-2 flex items-center justify-between rounded-xl bg-surface px-3 py-3 shadow-sm ring-1 ring-black/5 transition-colors hover:bg-brand-50/40"
          >
            <span className="min-w-0">
              <span className="block text-sm font-semibold">Become a fleet partner</span>
              <span className="mt-0.5 block text-[11px] text-ink-muted">
                Earn by delivering — same account.
              </span>
            </span>
            <span aria-hidden className="text-xs text-ink-faint">
              ›
            </span>
          </Link>
        )}
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
