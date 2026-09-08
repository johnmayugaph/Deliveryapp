import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser, displayNameFor } from '@/lib/auth/session';
import { getFleetPartner, getActiveJob } from '@/lib/fleet/partner';
import { FleetTabs } from '@/components/fleet/FleetTabs';
import { AvailabilityToggle } from '@/components/fleet/AvailabilityToggle';
import { LocationShare } from '@/components/fleet/LocationShare';
import { NotificationBell } from '@/components/notifications/NotificationBell';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

/**
 * The fleet partner shell.
 *
 * Its own layout: the customer's bottom navigation would offer Credits and a
 * cart to somebody on a motorcycle. Somebody who has not applied yet falls
 * through to the apply screen rather than seeing an empty partner app.
 */
export default async function FleetLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login?next=%2Ffleet');
  }
  if (user.onboardedAt === null) {
    redirect('/welcome');
  }

  const partner = await getFleetPartner();

  // The apply screen is inside /fleet but has no partner yet, so it renders
  // without the header the rest of the section needs.
  if (!partner) {
    return <div className="min-h-dvh bg-surface-sunken">{children}</div>;
  }

  const [activeJob, homeCity] = await Promise.all([
    getActiveJob(partner.id),
    partner.homeCityId
      ? prisma.city.findUnique({
          where: { id: partner.homeCityId },
          select: { centroidLat: true, centroidLng: true },
        })
      : Promise.resolve(null),
  ]);

  return (
    <div className="min-h-dvh bg-surface-sunken pb-8">
      <header className="bg-surface px-4 pb-3 pt-5 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Link href="/" className="text-[11px] font-semibold text-brand-700">
              ← Customer app
            </Link>
            <h1 className="mt-1 truncate text-lg font-bold">{displayNameFor(user)}</h1>
            <p className="text-[11px] text-ink-muted">
              {partner.vehicleType.toLowerCase().replace(/_/g, ' ')}
              {partner.enabledServices.length > 0
                ? ` · ${partner.enabledServices.length} service${partner.enabledServices.length === 1 ? '' : 's'}`
                : ' · no approved service'}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <NotificationBell userId={user.id} />
            <AvailabilityToggle
              isOnline={partner.isOnline}
              canGoOnline={partner.enabledServices.length > 0 && !partner.isSuspended}
              homeLatitude={partner.currentLatitude ?? homeCity?.centroidLat ?? null}
              homeLongitude={partner.currentLongitude ?? homeCity?.centroidLng ?? null}
            />
          </div>
        </div>

        <FleetTabs hasActiveJob={activeJob !== null} />
      </header>

      {/* Mounted in the layout so it survives moving between the fleet
          screens: a share that restarted on every navigation would drop the
          fix each time and report far less often than it says it does. */}
      <LocationShare isOnline={partner.isOnline} />

      {children}
    </div>
  );
}
