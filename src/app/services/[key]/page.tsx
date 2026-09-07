import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ServiceKey } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getCurrentCityId } from '@/lib/auth/session';
import { getService, ServiceNotActiveError, UnknownServiceError } from '@/lib/services/registry';
import { ORDER_DETAILS_SPECS } from '@/lib/orders/details';
import { serviceGlyph } from '@/lib/services/presentation';
import { formatCentavosCompact } from '@/lib/money';
import { RatingBadge } from '@/components/ui/RatingBadge';

export const dynamic = 'force-dynamic';

/**
 * A service's landing screen, rendered entirely from the registry.
 *
 * There is no per-vertical page here — one route serves all five. What differs
 * is read from data: `requiresMerchant` decides whether we show a store list,
 * and `ORDER_DETAILS_SPECS` decides whether ordering is implemented at all. The
 * day PARCEL activates, this page renders it without a new file.
 */
function parseServiceKey(value: string): ServiceKey | null {
  const upper = value.toUpperCase();
  return (Object.values(ServiceKey) as string[]).includes(upper)
    ? (upper as ServiceKey)
    : null;
}

export default async function ServicePage({
  params,
}: {
  params: Promise<{ key: string }>;
}) {
  const { key } = await params;
  const serviceKey = parseServiceKey(key);
  if (!serviceKey) {
    notFound();
  }

  let service;
  try {
    service = await getService(serviceKey);
  } catch (error) {
    if (error instanceof UnknownServiceError || error instanceof ServiceNotActiveError) {
      notFound();
    }
    throw error;
  }

  const cityId = await getCurrentCityId();
  const detailsSpec = ORDER_DETAILS_SPECS[service.key];

  // A coming-soon vertical gets an honest holding screen, not a broken flow.
  if (!service.isActive) {
    return (
      <main className="px-4 py-8">
        <h1 className="flex items-center gap-2 text-xl font-bold">
          <span aria-hidden>{serviceGlyph(service.icon)}</span>
          {service.displayName}
        </h1>
        <p className="mt-2 text-sm text-ink-muted">{service.description}</p>
        <p className="mt-4 rounded-xl bg-surface p-4 text-sm shadow-sm ring-1 ring-black/5">
          {service.displayName} is not available yet. We will tell you when it
          opens.
        </p>
        <Link href="/" className="mt-4 inline-block text-sm font-semibold text-brand-700">
          ← Home
        </Link>
      </main>
    );
  }

  const stores = service.requiresMerchant
    ? await prisma.store.findMany({
        where: {
          isVisible: true,
          cityId,
          serviceKeys: { has: service.key },
        },
        orderBy: [{ isOpen: 'desc' }, { ratingAvg: 'desc' }],
        take: 30,
        include: { menuItems: { where: { isAvailable: true }, take: 3, orderBy: { sortOrder: 'asc' } } },
      })
    : [];

  return (
    <main>
      <header className="bg-surface px-4 pb-4 pt-5">
        <h1 className="flex items-center gap-2 text-xl font-bold">
          <span aria-hidden>{serviceGlyph(service.icon)}</span>
          {service.displayName}
        </h1>
        <p className="mt-0.5 text-xs text-ink-muted">{service.description}</p>
      </header>

      {detailsSpec.status !== 'IMPLEMENTED' ? (
        <p className="mx-4 mt-4 rounded-xl bg-surface p-4 text-sm text-ink-muted shadow-sm ring-1 ring-black/5">
          This service is active, but its checkout flow is not built yet.
        </p>
      ) : null}

      {service.requiresMerchant ? (
        stores.length === 0 ? (
          <p className="px-4 py-8 text-sm text-ink-muted">
            No stores in your area yet.
          </p>
        ) : (
          <ul className="divide-y divide-black/5">
            {stores.map((store) => (
              <li key={store.id}>
                <Link
                  href={`/stores/${store.slug}`}
                  className="block bg-surface px-4 py-3.5 transition-colors hover:bg-brand-50/40"
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-semibold">{store.name}</span>
                    <span className="shrink-0 text-xs text-ink-muted">
                      <RatingBadge
                        ratingAvg={store.ratingAvg}
                        ratingCount={store.ratingCount}
                      />
                    </span>
                  </span>
                  <span className="mt-0.5 block text-xs text-ink-muted">
                    {store.preparationMinutes} min prep
                    {store.isOpen ? '' : ' · Sarado'}
                  </span>
                  {store.menuItems.length > 0 ? (
                    <span className="mt-1 block truncate text-[11px] text-ink-faint">
                      {store.menuItems
                        .map(
                          (item) =>
                            `${item.name} ${formatCentavosCompact(item.priceCentavos)}`,
                        )
                        .join(' · ')}
                    </span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        )
      ) : (
        <p className="px-4 py-8 text-sm text-ink-muted">
          This service has no store list — you book it directly.
        </p>
      )}
    </main>
  );
}
