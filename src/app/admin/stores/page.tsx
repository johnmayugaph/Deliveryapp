import Link from 'next/link';
import { requireAdmin } from '@/lib/admin/access';
import { filterConsoleStores, listConsoleStores } from '@/lib/admin/stores';
import { getAllServices } from '@/lib/services/registry';
import { prisma } from '@/lib/prisma';
import { StoreCreateForm } from '@/components/admin/StoreCreateForm';
import { tileSource } from '@/lib/geo/tiles';
import { geocodingIsAvailable } from '@/lib/geo/geocode';
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
 *
 * THE FILTERS ARE IN THE URL, not in component state. A console row is a thing
 * one person finds and then sends to another — "the Pampanga shops that are
 * hidden" has to survive being pasted into a chat, and a filter held in React
 * state does not.
 */
export default async function AdminStoresPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin();

  const params = await searchParams;
  const one = (key: string): string => {
    const value = params[key];
    return (Array.isArray(value) ? value[0] : value) ?? '';
  };
  const filter = {
    search: one('q'),
    status: one('status'),
    visibility: one('visibility'),
    cityId: one('city'),
  };
  const filtersAreOn =
    filter.search !== '' ||
    filter.status !== '' ||
    filter.visibility !== '' ||
    filter.cityId !== '';

  const [allStores, services, cities] = await Promise.all([
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

  const stores = filterConsoleStores(allStores, filter);
  const notReady = allStores.filter((store) => !store.readyForCustomers);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold">Stores</h1>
          <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-ink-muted">
            Create a partner shop and name whoever runs it. Everything after
            that — the menu, the prep time, the rest of the staff — they do
            themselves, from the store&apos;s own back office.
          </p>
        </div>
        <a
          href="#add-store"
          className="shrink-0 rounded-xl bg-brand-600 px-3.5 py-2 text-[13px] font-bold text-white hover:bg-brand-700"
        >
          Add a store
        </a>
      </div>

      {/* The counts are of EVERY store, not of the filtered list. A total that
          moves when you type in the search box is not a total. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Stores" value={String(allStores.length)} />
        <Stat
          label="Open now"
          value={String(allStores.filter((store) => store.isOpen).length)}
          note="taking orders this minute"
        />
        <Stat
          label="Not ready"
          value={String(notReady.length)}
          note={notReady.length > 0 ? 'hidden, no menu, or no owner' : 'all live'}
        />
        <Stat
          label="Orders"
          value={String(allStores.reduce((sum, store) => sum + store.orders, 0))}
          note="ever placed, every shop"
        />
      </div>

      <Panel title="Find a shop" description="Search matches the shop, its slug, its address and its owner.">
        <form method="get" className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5">
          <label className="block lg:col-span-2">
            <span className="text-[11px] font-bold text-ink-muted">Search</span>
            <input
              name="q"
              type="search"
              defaultValue={filter.search}
              placeholder="Name, slug, address, owner"
              className="mt-0.5 w-full rounded-lg bg-surface-sunken px-3 py-2 text-[13px] ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </label>

          <label className="block">
            <span className="text-[11px] font-bold text-ink-muted">Status</span>
            <select
              name="status"
              defaultValue={filter.status}
              className="mt-0.5 w-full rounded-lg bg-surface-sunken px-3 py-2 text-[13px] ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="">All</option>
              <option value="open">Open</option>
              <option value="closed">Closed</option>
            </select>
          </label>

          <label className="block">
            <span className="text-[11px] font-bold text-ink-muted">Visibility</span>
            <select
              name="visibility"
              defaultValue={filter.visibility}
              className="mt-0.5 w-full rounded-lg bg-surface-sunken px-3 py-2 text-[13px] ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="">All</option>
              <option value="live">Live</option>
              <option value="hidden">Hidden</option>
            </select>
          </label>

          <label className="block">
            <span className="text-[11px] font-bold text-ink-muted">City</span>
            <select
              name="city"
              defaultValue={filter.cityId}
              className="mt-0.5 w-full rounded-lg bg-surface-sunken px-3 py-2 text-[13px] ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="">All</option>
              {cities.map((city) => (
                <option key={city.id} value={city.id}>
                  {city.name}
                </option>
              ))}
            </select>
          </label>

          <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-5">
            <button
              type="submit"
              className="rounded-lg bg-brand-600 px-4 py-2 text-[13px] font-bold text-white hover:bg-brand-700"
            >
              Filter
            </button>
            {filtersAreOn ? (
              <Link
                href="/admin/stores"
                className="rounded-lg bg-surface-sunken px-4 py-2 text-[13px] font-bold text-ink-muted ring-1 ring-black/5 hover:text-ink"
              >
                Reset
              </Link>
            ) : null}
          </div>
        </form>
      </Panel>

      <Panel
        title="Every store"
        description={
          filtersAreOn
            ? `${stores.length} of ${allStores.length} shops match.`
            : 'Not-ready shops first, because those are the ones waiting on somebody.'
        }
      >
        {allStores.length === 0 ? (
          <Empty>No stores yet. Add the first one below.</Empty>
        ) : stores.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-sm font-bold">Nothing matches those filters.</p>
            <p className="mt-1 text-xs text-ink-muted">
              {allStores.length} {allStores.length === 1 ? 'shop' : 'shops'} without
              them.
            </p>
            <Link
              href="/admin/stores"
              className="mt-3 inline-block rounded-lg bg-brand-600 px-3.5 py-2 text-[13px] font-bold text-white"
            >
              Clear filters
            </Link>
          </div>
        ) : (
          <TableScroll>
            <thead>
              <tr>
                <Th>Store</Th>
                <Th>Owner</Th>
                <Th>Location</Th>
                <Th>Services</Th>
                <Th numeric>Menu</Th>
                <Th numeric>Orders</Th>
                <Th>State</Th>
              </tr>
            </thead>
            <tbody>
              {stores.map((store) => (
                <tr key={store.id} className="border-t border-black/5">
                  <Td>
                    <span className="flex items-center gap-2.5">
                      {/* The logo, where a shop has one. This column is also
                          the only place an operator can SEE that a shop still
                          has none — which was invisible before the console
                          could set one. */}
                      {store.logoUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={store.logoUrl}
                          alt=""
                          width={64}
                          height={64}
                          className="h-9 w-9 shrink-0 rounded-lg object-cover ring-1 ring-black/5"
                        />
                      ) : (
                        <span
                          aria-hidden
                          title="No logo set"
                          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-[13px] font-bold text-ink-faint ring-1 ring-black/5"
                        >
                          {store.name.slice(0, 1).toUpperCase()}
                        </span>
                      )}
                      <span className="min-w-0">
                        <Link
                          href={`/admin/stores/${store.id}`}
                          className="font-semibold text-brand-700"
                        >
                          {store.name}
                        </Link>
                        <span className="block text-[11px] text-ink-faint">
                          /stores/{store.slug}
                          {store.contactPhone ? ` · ${store.contactPhone}` : ''}
                        </span>
                      </span>
                    </span>
                  </Td>
                  <Td muted={!store.owner}>
                    {store.owner ? (
                      <>
                        {store.owner.name}
                        <span className="block text-[11px] text-ink-faint">
                          {store.owner.phone}
                        </span>
                      </>
                    ) : (
                      'Nobody yet'
                    )}
                  </Td>
                  <Td>
                    {store.cityName}
                    <span className="block max-w-[14rem] truncate text-[11px] text-ink-faint">
                      {store.addressLine}
                    </span>
                  </Td>
                  <Td>{store.serviceKeys.join(', ')}</Td>
                  <Td numeric muted={store.menuItems === 0}>
                    {store.menuItems}
                  </Td>
                  <Td numeric muted={store.orders === 0}>
                    {store.orders}
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

      <div id="add-store" className="scroll-mt-6">
        <Panel
          title="Add a partner shop"
          description="The owner is named by mobile number. If they have no TARA account yet the invitation waits for their first sign-in — nothing is texted to them, so tell them yourself."
        >
          <div className="px-4 py-4">
            <StoreCreateForm
              tiles={tileSource()}
              searchAvailable={geocodingIsAvailable()}
              cities={cities}
              services={services.map((service) => ({
                key: service.key,
                displayName: service.displayName,
                isActive: service.isActive,
              }))}
            />
          </div>
        </Panel>
      </div>
    </div>
  );
}
