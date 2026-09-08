import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getFleetPartner } from '@/lib/fleet/partner';
import { getAllServices } from '@/lib/services/registry';
import { getPartnerProgramme } from '@/lib/referrals/partner-programme';
import { partnerProgrammeIsLive } from '@/lib/referrals/partner-policy';
import { ApplyForm } from '@/components/fleet/ApplyForm';

export const dynamic = 'force-dynamic';

/**
 * Join the fleet.
 *
 * The service list comes from the registry, including the coming-soon ones: a
 * partner can apply for Parcel before it launches, which means the verification
 * queue is warm on the day it does.
 */
export default async function FleetApplyPage() {
  const partner = await getFleetPartner();
  if (partner) {
    redirect('/fleet');
  }

  const [services, programme] = await Promise.all([
    getAllServices(),
    getPartnerProgramme(),
  ]);
  const applicable = services.filter((service) => service.requiresRider);

  return (
    <main className="px-4 py-8">
      <Link href="/profile" className="text-[11px] font-semibold text-brand-700">
        ← Profile
      </Link>
      <h1 className="mt-2 text-xl font-bold">Become a fleet partner</h1>
      <p className="mt-1 text-sm text-ink-muted">
        One account is enough — you can be a customer and a rider on the
        parehong number.
      </p>

      <div className="mt-6 rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5">
        <ApplyForm
          services={applicable.map((service) => ({
            key: service.key,
            displayName: service.displayName,
            tagline: service.tagline,
            isActive: service.isActive,
          }))}
          invite={
            partnerProgrammeIsLive(programme)
              ? {
                  refereeCentavos: programme.refereeCentavos,
                  qualifyingDeliveries: programme.qualifyingDeliveries,
                }
              : null
          }
        />
      </div>
    </main>
  );
}
