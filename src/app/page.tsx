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
      {/*
        * THE HEADER BLOCK: brand blue, holding the address and the search
        * field, with the service panel overlapping its bottom edge. Not
        * sticky any more — a coloured block a fifth of the screen tall that
        * follows you down a shop list is a lot of chrome for two lines of
        * text, and the search it contains has its own screen.
        */}
      <div className="bg-brand-600 pb-2">
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
                className="shrink-0 rounded-full bg-white/15 px-3 py-1.5 text-xs font-bold text-white ring-1 ring-white/25 hover:bg-white/25"
              >
                Sign in
              </Link>
            )
          }
        />
        <GlobalSearch activeServiceNames={activeServiceNames} />
        {/* The banner lives in the coloured block, not under it: it is the
            one piece of merchandising that gets the top of the screen, and on
            the page below it would compete with the shops. */}
        <PromotionsRail promotions={data.promotions} />
      </div>

      <ServiceTileGrid
        groups={data.serviceGroups}
        cityName={data.currentCityName}
        askedFor={data.askedFor}
        signedIn={user !== null}
      />

      <ActiveOrderStrip orders={data.activeOrders} />

      <RecentStores
        stores={data.recentStores}
        hasOrderHistory={data.activeOrders.length > 0}
      />
    </main>
  );
}
