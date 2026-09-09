import Link from 'next/link';
import { getCurrentCityId } from '@/lib/auth/session';
import { optionalUser } from '@/lib/auth/access';
import { loadHomeData } from '@/lib/home/home-data';
import { LocationHeader } from '@/components/home/LocationHeader';
import { GlobalSearch } from '@/components/home/GlobalSearch';
import { ServiceTileGrid } from '@/components/home/ServiceTileGrid';
import { ActiveOrderStrip } from '@/components/home/ActiveOrderStrip';
import { PromotionsRail } from '@/components/home/PromotionsRail';
import { RecentStores } from '@/components/home/RecentStores';
import { NotificationBell } from '@/components/notifications/NotificationBell';

export const dynamic = 'force-dynamic';

/**
 * The customer home screen, built around SERVICE SELECTION rather than dropping
 * straight into a restaurant list.
 *
 * PUBLIC. Everything here renders for somebody with no account: the tiles, the
 * promotions and a well-rated-stores fallback in place of reorder shortcuts.
 * `loadHomeData` takes a null user throughout, and the one thing that cannot
 * work anonymously — a saved address — reads as an invitation to set one.
 *
 * Order, top to bottom:
 *   1. Current delivery location, tap to change.
 *   2. Global search across active services.
 *   3. Service tiles grouped by intent, from the registry.
 *   4. Active-order strip, if anything is in progress.
 *   5. Promotions.
 *   6. Recent stores / reorder shortcuts.
 */
export default async function HomePage() {
  /* `optionalUser` rather than a bare session read, and the screen name is
     the point: it refuses on anything the map marks private, so the six
     screens that rendered a guess for a signed-out visitor could not have
     been written this way. */
  const [user, cityId] = await Promise.all([
    optionalUser('home'),
    getCurrentCityId(),
  ]);
  const data = await loadHomeData({ userId: user?.id ?? null, cityId });

  const activeServiceNames = data.serviceGroups
    .flatMap((group) => group.services)
    .filter((service) => service.orderableHere)
    .map((service) => service.displayName);

  return (
    <main>
      <div className="sticky top-0 z-30 shadow-sm">
        <LocationHeader
          addressLabel={data.currentAddressLabel}
          cityName={data.currentCityName}
          bell={
            user ? (
              <NotificationBell userId={user.id} />
            ) : (
              /* The door, for somebody who arrived without one. The home
                 screen is public, so this is the only thing on it that says
                 an account exists at all. */
              <Link
                href="/login?next=%2F"
                className="shrink-0 rounded-full bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
              >
                Sign in
              </Link>
            )
          }
        />
        <GlobalSearch activeServiceNames={activeServiceNames} />
      </div>

      <ServiceTileGrid
        groups={data.serviceGroups}
        cityName={data.currentCityName}
        askedFor={data.askedFor}
        signedIn={user !== null}
      />

      <ActiveOrderStrip orders={data.activeOrders} />

      <PromotionsRail promotions={data.promotions} />

      <RecentStores
        stores={data.recentStores}
        hasOrderHistory={data.activeOrders.length > 0}
      />
    </main>
  );
}
