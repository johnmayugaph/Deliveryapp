import Link from 'next/link';
import { requireScreen } from '@/lib/auth/access';
import { formatAddressLine, listAddressBook } from '@/lib/addresses/usage';

export const dynamic = 'force-dynamic';

/**
 * The shared address book.
 *
 * One book, every vertical. An address saved while ordering food is immediately
 * available as a Parcel pickup — which is why `isPickupCapable` is a property of
 * the address rather than something a parcel flow would ask for again.
 */
export default async function AddressesPage() {
  const user = await requireScreen('addresses');
  const addresses = await listAddressBook({ userId: user.id });

  return (
    <main>
      <header className="bg-surface px-4 pb-4 pt-5">
        <Link href="/" className="text-xs font-semibold text-brand-700">
          ← Home
        </Link>
        <h1 className="mt-2 text-xl font-bold">Mga address</h1>
        <p className="mt-0.5 text-xs text-ink-muted">
          One address book for every service.
        </p>
      </header>

      {addresses.length === 0 ? (
        <p className="px-4 py-8 text-sm text-ink-muted">
          No saved addresses yet.
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-black/5">
          {addresses.map((address) => (
            <li key={address.id} className="bg-surface px-4 py-3.5">
              <span className="flex items-center gap-2">
                <span className="text-sm font-semibold">{address.label}</span>
                {address.isDefault ? (
                  <span className="rounded-full bg-brand-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-brand-800">
                    Default
                  </span>
                ) : null}
                {address.isPickupCapable ? (
                  <span className="rounded-full bg-mart-soft px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-mart-bold">
                    Pickup ok
                  </span>
                ) : null}
              </span>
              <span className="mt-0.5 block text-xs text-ink-muted">
                {formatAddressLine(address)}
              </span>
              {address.landmark ? (
                <span className="mt-0.5 block text-[11px] text-ink-faint">
                  {address.landmark}
                </span>
              ) : null}
              <span className="mt-1 block text-[11px] text-ink-faint">
                Ginamit {address.usageCount}x
                {address.lastUsedAt
                  ? ` · huli ${address.lastUsedAt.toLocaleDateString('en-PH', {
                      day: 'numeric',
                      month: 'short',
                    })}`
                  : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
