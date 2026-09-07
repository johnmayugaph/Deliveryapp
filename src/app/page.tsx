import { getCurrentCityId, getCurrentUser } from '@/lib/auth/session';
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
 * Order, top to bottom:
 *   1. Current delivery location, tap to change.
 *   2. Global search across active services.
 *   3. Service tiles grouped by intent, from the registry.
 *   4. Active-order strip, if anything is in progress.
 *   5. Promotions.
 *   6. Recent stores / reorder shortcuts.
 */
export default async function HomePage() {
  const [user, cityId] = await Promise.all([getCurrentUser(), getCurrentCityId()]);
  const data = await loadHomeData({ userId: user?.id ?? null, cityId });

  const activeServiceNames = data.serviceGroups
    .flatMap((group) => group.services)
    .filter((service) => service.isActive)
    .map((service) => service.displayName);

  return (
    <main>
      <div className="sticky top-0 z-30 shadow-sm">
        <LocationHeader
          addressLabel={data.currentAddressLabel}
          cityName={data.currentCityName}
          bell={user ? <NotificationBell userId={user.id} /> : null}
        />
        <GlobalSearch activeServiceNames={activeServiceNames} />
      </div>

      <ServiceTileGrid groups={data.serviceGroups} />

      <ActiveOrderStrip orders={data.activeOrders} />

      <PromotionsRail promotions={data.promotions} />

      <RecentStores
        stores={data.recentStores}
        hasOrderHistory={data.activeOrders.length > 0}
      />
    </main>
  );
}
