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
import { SignOutButton } from '@/components/auth/SignOutButton';
import { ActiveSessions } from '@/components/auth/ActiveSessions';

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

  const [addresses, fleetPartner, sessions, stores] = await Promise.all([
    listAddressBook({ userId: user.id, limit: 5 }),
    prisma.fleetPartner.findUnique({
      where: { userId: user.id },
      include: { serviceVerifications: { include: { service: true } } },
    }),
    listActiveSessions(user.id),
    getAccessibleStores(),
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
          Isang address book para sa lahat ng service.
        </p>
        {addresses.length === 0 ? (
          <p className="mt-2 text-sm text-ink-muted">Wala pang saved address.</p>
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

      {fleetPartner ? (
        <section aria-labelledby="fleet-heading" className="mt-5 px-4">
          <h2
            id="fleet-heading"
            className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted"
          >
            Fleet approvals
          </h2>
          <p className="mt-1 text-[11px] text-ink-faint">
            Approved sa isang service ay hindi approved sa lahat.
          </p>
          <ul className="mt-2 space-y-1.5">
            {fleetPartner.serviceVerifications.map((verification) => (
              <li
                key={verification.id}
                className="flex items-center justify-between rounded-xl bg-surface px-3 py-2.5 shadow-sm ring-1 ring-black/5"
              >
                <span className="text-sm font-medium">
                  {verification.service.displayName}
                </span>
                <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                  {verification.status.replace(/_/g, ' ').toLowerCase()}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <ActiveSessions sessions={sessions} />

      <section className="mt-5 space-y-2 px-4 pb-8">
        <Link
          href="/help"
          className="flex items-center justify-between rounded-xl bg-surface px-3 py-3 shadow-sm ring-1 ring-black/5"
        >
          <span className="text-sm font-semibold">Help at support</span>
          <span aria-hidden className="text-xs text-ink-faint">
            ›
          </span>
        </Link>
        <SignOutButton />
      </section>
    </main>
  );
}
