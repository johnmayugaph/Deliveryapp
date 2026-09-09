import Link from 'next/link';
import { requireScreen } from '@/lib/auth/access';
import { prisma } from '@/lib/prisma';
import { formatAddressLine, listAddressBook } from '@/lib/addresses/usage';
import { formatDayIn } from '@/lib/time/manila';
import { tileSource } from '@/lib/geo/tiles';
import { AddressForm } from '@/components/address/AddressForm';

export const dynamic = 'force-dynamic';

/**
 * The shared address book.
 *
 * One book, every vertical. An address saved while ordering food is immediately
 * available as a Parcel pickup — which is why `isPickupCapable` is a property of
 * the address rather than something a parcel flow would ask for again.
 *
 * The form below it was missing until a rehearsal on a purged database went
 * looking for it: `/checkout` refuses an order with no address and links here
 * saying "Add an address", and this page answered "No saved addresses yet."
 * and offered nothing at all. The seed writes addresses for the demo accounts,
 * so the gap was invisible until the demo data was purged — which is the first
 * thing a real deployment does.
 */
export default async function AddressesPage() {
  const user = await requireScreen('addresses');
  const [addresses, cities] = await Promise.all([
    listAddressBook({ userId: user.id }),
    /* Active cities only. Saving an address in a city this deployment does not
       deliver in would produce a book entry every checkout then refuses. */
    prisma.city.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, centroidLat: true, centroidLng: true },
    }),
  ]);

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
        <p className="px-4 pt-6 text-sm text-ink-muted">
          No saved addresses yet. Add one below and you can order.
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
                  ? ` · huli ${formatDayIn(address.lastUsedAt)}`
                  : ''}
              </span>
            </li>
          ))}
        </ul>
      )}

      <section className="mt-4 bg-surface px-4 py-4">
        <h2 className="text-[13px] font-semibold">
          {addresses.length === 0 ? 'Add your address' : 'Add another'}
        </h2>
        <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">
          The pin is the part that matters: the delivery fee is measured from
          it, so put it on the building rather than the street.
        </p>
        <div className="mt-3">
          <AddressForm
            tiles={tileSource()}
            hasExisting={addresses.length > 0}
            cities={cities.map((city) => ({
              id: city.id,
              name: city.name,
              centroid:
                city.centroidLat === null || city.centroidLng === null
                  ? null
                  : { latitude: city.centroidLat, longitude: city.centroidLng },
            }))}
          />
        </div>
      </section>
    </main>
  );
}
