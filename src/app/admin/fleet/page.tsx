import Link from 'next/link';
import { requireAdmin } from '@/lib/admin/access';
import { listConsolePartners, pendingApplications } from '@/lib/admin/fleet';
import { describeWait } from '@/lib/fleet/verification-policy';
import { Empty, Panel, Pill, Stat, TableScroll, Td, Th } from '@/components/admin/primitives';
import { formatPhilippineMobile } from '@/lib/auth/phone';
import { humaniseEnum } from '@/components/admin/primitives';

export const dynamic = 'force-dynamic';

/**
 * The fleet.
 *
 * This page ended the last job in the application that could only be done over
 * SSH. Approving riders was `npm run fleet:approve`, which needed a shell and
 * the production database for something somebody does daily, from a phone,
 * while looking at a photograph of a licence — and which recorded no audit
 * row, set no decider, and never told the rider.
 *
 * The waiting list is first and it is the point of the screen: an application
 * is somebody who cannot earn until a person here looks at it, so the count is
 * at the top and the oldest is at the front.
 */
export default async function AdminFleetPage() {
  await requireAdmin();

  const [waiting, partners] = await Promise.all([
    pendingApplications(),
    listConsolePartners(),
  ]);
  const now = new Date();

  const approved = partners.filter((partner) => partner.enabledServices.length > 0);
  const online = partners.filter((partner) => partner.isOnline && !partner.isSuspended);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-bold">Fleet</h1>
        <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-ink-muted">
          Approval is per service: cleared to carry food is not cleared to carry
          a passenger. Every decision is recorded with who made it and why, and
          the partner is told which service it was about.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Waiting on us"
          value={String(waiting.length)}
          note={
            waiting.length > 0
              ? `oldest ${describeWait(waiting[0]!.waitingSince, now)}`
              : 'nothing to decide'
          }
        />
        <Stat label="Partners" value={String(partners.length)} />
        <Stat
          label="Approved for something"
          value={String(approved.length)}
          note={approved.length === 0 ? 'nobody can take work yet' : undefined}
        />
        <Stat label="Online now" value={String(online.length)} />
      </div>

      <Panel
        title="Waiting for a decision"
        description="One row per application, oldest first — a queue sorted any other way is how somebody who applied on Monday is still waiting on Friday."
      >
        {waiting.length === 0 ? (
          <Empty>
            Nobody is waiting. New applications arrive when a partner applies for
            a service from their own profile screen.
          </Empty>
        ) : (
          <TableScroll>
            <thead>
              <tr>
                <Th>Partner</Th>
                <Th>Service</Th>
                <Th>Vehicle</Th>
                <Th>City</Th>
                <Th numeric>Waiting</Th>
                <Th>Documents</Th>
              </tr>
            </thead>
            <tbody>
              {waiting.map((row) => (
                <tr key={`${row.partnerId}:${row.serviceType}`} className="border-t border-black/5">
                  <Td>
                    <Link
                      href={`/admin/fleet/${row.partnerId}`}
                      className="font-semibold text-brand-700"
                    >
                      {row.name}
                    </Link>
                    <span className="block text-[11px] text-ink-faint">
                      {formatPhilippineMobile(row.phone)}
                    </span>
                  </Td>
                  <Td>{row.serviceName}</Td>
                  <Td muted>
                    {humaniseEnum(row.vehicleType)}
                    {row.vehiclePlate ? ` · ${row.vehiclePlate}` : ''}
                  </Td>
                  <Td muted>{row.cityName ?? '—'}</Td>
                  <Td numeric>{describeWait(row.waitingSince, now)}</Td>
                  <Td muted>
                    {row.documents.length === 0 ? (
                      <span className="text-amber-700">none attached</span>
                    ) : (
                      row.documents.join(', ')
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        )}
      </Panel>

      <Panel
        title="Every partner"
        description="Anyone waiting on us first, then by name."
      >
        {partners.length === 0 ? (
          <Empty>
            Nobody has applied to the fleet yet. A rider applies from the app —
            it is not something the console can do for them.
          </Empty>
        ) : (
          <TableScroll>
            <thead>
              <tr>
                <Th>Partner</Th>
                <Th>City</Th>
                <Th>Approved for</Th>
                <Th numeric>Deliveries</Th>
                <Th numeric>Rating</Th>
                <Th>State</Th>
              </tr>
            </thead>
            <tbody>
              {partners.map((partner) => (
                <tr key={partner.partnerId} className="border-t border-black/5">
                  <Td>
                    <Link
                      href={`/admin/fleet/${partner.partnerId}`}
                      className="font-semibold text-brand-700"
                    >
                      {partner.name}
                    </Link>
                    <span className="block text-[11px] text-ink-faint">
                      {formatPhilippineMobile(partner.phone)} ·{' '}
                      {humaniseEnum(partner.vehicleType)}
                    </span>
                  </Td>
                  <Td muted>{partner.cityName ?? '—'}</Td>
                  <Td muted>
                    {partner.enabledServices.length === 0
                      ? '—'
                      : partner.enabledServices.join(', ')}
                  </Td>
                  <Td numeric>{partner.completedOrderCount}</Td>
                  <Td numeric>
                    {partner.ratingCount === 0
                      ? '—'
                      : `${partner.ratingAvg.toFixed(1)} (${partner.ratingCount})`}
                  </Td>
                  <Td>
                    {partner.isSuspended ? (
                      <Pill tone="bad">Suspended</Pill>
                    ) : partner.pending > 0 ? (
                      <Pill tone="warn">
                        {partner.pending} waiting
                      </Pill>
                    ) : partner.enabledServices.length === 0 ? (
                      <Pill tone="neutral">No approvals</Pill>
                    ) : partner.isOnline ? (
                      <Pill tone="good">Online</Pill>
                    ) : (
                      <Pill tone="neutral">Offline</Pill>
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
