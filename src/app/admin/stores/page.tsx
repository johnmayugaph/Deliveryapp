import Link from 'next/link';
import { requireAdmin } from '@/lib/admin/access';
import { listConsoleStores } from '@/lib/admin/stores';
import { getAllServices } from '@/lib/services/registry';
import { prisma } from '@/lib/prisma';
import { StoreCreateForm } from '@/components/admin/StoreCreateForm';
import { tileSource } from '@/lib/geo/tiles';
import { Empty, Panel, Pill, Stat, TableScroll, Td, Th } from '@/components/admin/primitives';

export const dynamic = 'force-dynamic';

/**
 * Partner stores.
 *
 * The page that ends "onboarding a shop needs somebody with database access".
 * It does exactly two things the shop cannot do for itself — create the store,
 * and name its first owner — and then gets out of the way: the menu, the prep
 * time and the rest of the staff belong to the people who work there.
 *
 * A new store is created HIDDEN. A shop with no menu that customers can find
 * is worse than one they cannot: they open it, see nothing, and conclude the
 * app is broken. The "not ready" count at the top is the list of shops sitting
 * in that state, and it is the first thing on the page for that reason.
 */
export default async function AdminStoresPage() {
  await requireAdmin();

  const [stores, services, cities] = await Promise.all([
    listConsoleStores(),
    getAllServices(),
    prisma.city.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      // The centroid is what the map picker opens on, so a form for a Cebu
      // shop does not start over Manila.
      select: { id: true, name: true, centroidLat: true, centroidLng: true },
    }),
  ]);

  const notReady = stores.filter((store) => !store.readyForCustomers);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-bold">Stores</h1>
        <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-ink-muted">
          Create a partner shop and name whoever runs it. Everything after that —
          the menu, the prep time, the rest of the staff — they do themselves,
          from the store&apos;s own back office.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Stores" value={String(stores.length)} />
        <Stat
          label="Not ready"
          value={String(notReady.length)}
          note={notReady.length > 0 ? 'hidden, no menu, or no owner' : 'all live'}
        />
        <Stat
          label="Taking orders"
          value={String(stores.filter((store) => store.readyForCustomers).length)}
        />
        <Stat
          label="Invitations waiting"
          value={String(stores.reduce((sum, store) => sum + store.pendingInvites, 0))}
          note="numbers with no account yet"
        />
      </div>

      <Panel
        title="Add a partner shop"
        description="The owner is named by mobile number. If they have no TARA account yet the invitation waits for their first sign-in — nothing is texted to them, so tell them yourself."
      >
        <div className="px-4 py-4">
          <StoreCreateForm
            tiles={tileSource()}
            cities={cities}
            services={services.map((service) => ({
              key: service.key,
              displayName: service.displayName,
              isActive: service.isActive,
            }))}
          />
        </div>
      </Panel>

      <Panel
        title="Every store"
        description="Not-ready shops first, because those are the ones waiting on somebody."
      >
        {stores.length === 0 ? (
          <Empty>No stores yet. Add the first one above.</Empty>
        ) : (
          <TableScroll>
            <thead>
              <tr>
                <Th>Store</Th>
                <Th>City</Th>
                <Th>Services</Th>
                <Th numeric>Menu</Th>
                <Th numeric>People</Th>
                <Th>State</Th>
              </tr>
            </thead>
            <tbody>
              {stores.map((store) => (
                <tr key={store.id} className="border-t border-black/5">
                  <Td>
                    <Link
                      href={`/admin/stores/${store.id}`}
                      className="font-semibold text-brand-700"
                    >
                      {store.name}
                    </Link>
                    <span className="block text-[11px] text-ink-faint">
                      /stores/{store.slug}
                    </span>
                  </Td>
                  <Td>{store.cityName}</Td>
                  <Td>{store.serviceKeys.join(', ')}</Td>
                  <Td numeric>{store.menuItems}</Td>
                  <Td numeric>
                    {store.members}
                    {store.pendingInvites > 0 ? (
                      <span className="text-[11px] text-ink-faint">
                        {' '}
                        +{store.pendingInvites}
                      </span>
                    ) : null}
                  </Td>
                  <Td>
                    {store.readyForCustomers ? (
                      <Pill tone="good">{store.isOpen ? 'Open' : 'Closed now'}</Pill>
                    ) : (
                      <Pill tone="warn">
                        {store.owners === 0
                          ? 'No owner'
                          : store.menuItems === 0
                            ? 'No menu'
                            : 'Hidden'}
                      </Pill>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        )}
      </Panel>
    </div>
  );
}
