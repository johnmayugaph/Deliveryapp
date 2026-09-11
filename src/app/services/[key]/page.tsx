import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ServiceKey } from '@prisma/client';
import { getCurrentCityId } from '@/lib/auth/session';
import { optionalUser } from '@/lib/auth/access';
import {
  getActiveServiceKeys,
  getService,
  ServiceNotActiveError,
  UnknownServiceError,
} from '@/lib/services/registry';
import {
  DEFAULT_FILTERS,
  filtersToQuery,
  loadServicePageData,
  parseFilters,
  type ServicePageFilters,
} from '@/lib/services/service-page-data';
import { ORDER_DETAILS_SPECS } from '@/lib/orders/details';
import { serviceGlyph } from '@/lib/services/presentation';
import { findDeliveryFeeRule } from '@/lib/pricing/delivery-fee';
import { prisma } from '@/lib/prisma';
import { GlobalSearch } from '@/components/home/GlobalSearch';
import { PromotionsRail } from '@/components/home/PromotionsRail';
import { CategoryRail } from '@/components/services/CategoryRail';
import { StoreFilters } from '@/components/services/StoreFilters';
import { StoreList } from '@/components/services/StoreList';

export const dynamic = 'force-dynamic';

/**
 * A service's landing screen, rendered entirely from the registry.
 *
 * There is no per-vertical page here — one route serves all five. What differs
 * is read from data: `requiresMerchant` decides whether we show a store list,
 * and `ORDER_DETAILS_SPECS` decides whether ordering is implemented at all. The
 * day PARCEL activates, this page renders it without a new file.
 *
 * THE SHAPE IS THE ONE THE DELIVERY APPS USE, top to bottom: a coloured
 * masthead with the address and a search field, this vertical's promotions,
 * a round category rail, sticky sort and filter chips, then the shops. Each
 * band answers one question — where am I, what is on offer, what kind of
 * thing do I want, narrow it, pick one — and the old version answered none of
 * them: it was a heading and an undifferentiated list of thirty names.
 *
 * The rail and the chips are REAL FILTERS reading the URL, not decoration.
 * That is also why they are links rather than a client component: the state
 * lives in the URL, so it survives a share and a reload, and the same server
 * query builds both the chips and the list they describe.
 */
function parseServiceKey(value: string): ServiceKey | null {
  const upper = value.toUpperCase();
  return (Object.values(ServiceKey) as string[]).includes(upper)
    ? (upper as ServiceKey)
    : null;
}

export default async function ServicePage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
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

  const filters = parseFilters(await searchParams);
  const base = `/services/${key.toLowerCase()}`;
  const hrefFor = (next: ServicePageFilters) => `${base}${filtersToQuery(next)}`;

  const [user, activeServiceKeys, city, feeRule] = await Promise.all([
    optionalUser('home'),
    getActiveServiceKeys(),
    prisma.city.findUnique({ where: { id: cityId }, select: { name: true } }),
    // The same rule checkout applies, so the "free over ₱X" on every row is a
    // term this city actually has rather than a number typed into a list.
    findDeliveryFeeRule(service.key, cityId),
  ]);

  const addressLabel = user
    ? await prisma.address
        .findFirst({
          where: { userId: user.id, archivedAt: null },
          orderBy: [
            { isDefault: 'desc' },
            { lastUsedAt: { sort: 'desc', nulls: 'last' } },
            { usageCount: 'desc' },
          ],
        })
        .then((address) =>
          address ? [address.label, address.line1].filter(Boolean).join(' · ') : null,
        )
    : null;

  const data = service.requiresMerchant
    ? await loadServicePageData({
        serviceKey: service.key,
        cityId,
        activeServiceKeys,
        filters,
      })
    : null;

  const cityName = city?.name ?? 'your area';
  const filtersAreOn =
    filters.openNow || filters.fast || filters.deals || filters.category !== null;

  return (
    <main className="wide">
      {/*
        * THE MASTHEAD. The same brand block as the home screen, so moving
        * between them does not feel like two applications — with a back
        * control and this vertical's name, which is the one thing this screen
        * has that home does not.
        */}
      {/* The masthead keeps its colour at every width but stops being the
          full bleed it is on a phone: rounded and inset from `lg`, so it reads
          as this page's hero rather than as the browser chrome. */}
      <div className="bg-brand-600 pb-2 lg:mt-6 lg:rounded-3xl">
        <header className="flex items-center gap-3 px-4 pb-3 pt-5">
          <Link
            href="/"
            aria-label="Back"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/15 text-base font-bold text-white"
          >
            <span aria-hidden>←</span>
          </Link>
          <Link href="/addresses" className="min-w-0 flex-1 text-left">
            <span className="block text-[10px] font-bold uppercase tracking-[0.14em] text-white/70">
              Deliver now
            </span>
            <span className="flex items-center gap-1">
              {/* No city appended to the fallback, unlike the home screen's.
                  At 360px "Set your address · Manila" truncated to "Set your
                  address · …" — an ellipsis where the useful word was. The
                  city is named under the chips instead, on the line that
                  counts the shops. */}
              <span className="truncate text-[15px] font-bold leading-tight text-white">
                {addressLabel ?? 'Set your address'}
              </span>
              <span aria-hidden className="text-[10px] text-white/70">
                ▾
              </span>
            </span>
            <span className="sr-only">Change delivery location</span>
          </Link>
          <h1 className="shrink-0 rounded-full bg-white/15 px-3 py-1.5 text-xs font-bold text-white">
            <span aria-hidden className="mr-1">
              {serviceGlyph(service.icon)}
            </span>
            {service.displayName}
          </h1>
        </header>

        <GlobalSearch activeServiceNames={[service.displayName]} />

        {data !== null ? <PromotionsRail promotions={data.promotions} /> : null}
      </div>

      {detailsSpec.status !== 'IMPLEMENTED' ? (
        <p className="mx-4 mt-4 rounded-xl bg-surface p-4 text-sm text-ink-muted shadow-tile ring-1 ring-ink/[0.06]">
          This service is active, but its checkout flow is not built yet.
        </p>
      ) : null}

      {!service.requiresMerchant ? (
        <p className="px-4 py-8 text-sm text-ink-muted">
          This service has no store list — you book it directly.
        </p>
      ) : data === null || data.totalInCity === 0 ? (
        <p className="px-4 py-8 text-sm text-ink-muted">
          No stores in your area yet.
        </p>
      ) : (
        <>
          <CategoryRail
            categories={data.categories}
            active={filters.category}
            hrefFor={(category) => hrefFor({ ...filters, category })}
          />

          <StoreFilters filters={filters} hrefFor={hrefFor} />

          {data.rows.length === 0 ? (
            /*
             * Nothing matched, and the screen says which of the two reasons it
             * is. `totalInCity` is why that sentence can be written at all: a
             * list that says "no stores" when nineteen exist behind a chip the
             * customer forgot they tapped is a bug report waiting to be filed.
             */
            <div className="px-4 py-10 text-center">
              <p className="text-sm font-bold">Nothing matches those filters.</p>
              <p className="mt-1 text-sm text-ink-muted">
                {data.totalInCity} {data.totalInCity === 1 ? 'store' : 'stores'} here
                without them.
              </p>
              <Link
                href={hrefFor(DEFAULT_FILTERS)}
                className="press mt-4 inline-block rounded-full bg-brand-600 px-4 py-2 text-[13px] font-bold text-white"
              >
                Clear filters
              </Link>
            </div>
          ) : (
            <>
              <p className="px-4 pb-1 pt-3.5 text-[12.5px] text-ink-muted">
                {data.rows.length}{' '}
                {data.rows.length === 1 ? 'store' : 'stores'}
                {filtersAreOn ? ' match' : ` in ${cityName}`}
              </p>
              <StoreList
                rows={data.rows}
                freeDeliveryAboveCentavos={feeRule?.freeAboveSubtotalCentavos ?? null}
              />
            </>
          )}
        </>
      )}
    </main>
  );
}
