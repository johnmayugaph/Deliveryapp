import Link from 'next/link';
import { formatCentavos } from '@/lib/money';
import { requireAdmin } from '@/lib/admin/access';
import { deliveryHealth, platformSummary, serviceHealth } from '@/lib/admin/queries';
import { supportSummary } from '@/lib/support/queries';
import { countPendingApplications } from '@/lib/admin/fleet';
import { adminReviewFeed, ratingSummary } from '@/lib/ratings/reviews';
import { displayNameFor } from '@/lib/auth/session';
import { describeWait } from '@/lib/support/policy';
import { listOrders, attachStores } from '@/lib/admin/queries';
import {
  Empty,
  Panel,
  PersonLink,
  Pill,
  Stat,
  StatusPill,
  TableScroll,
  Td,
  Th,
  manilaTime,
} from '@/components/admin/primitives';

export const dynamic = 'force-dynamic';

/**
 * The overview.
 *
 * Answers one question: is anything wrong right now. So the things on it are
 * the things that go wrong — orders stuck waiting, deliveries that failed, a
 * credit float that moved — rather than the numbers that look good in a deck.
 *
 * The service table includes the four unlaunched verticals on purpose. A
 * dashboard that shows only what is running makes "we said we would launch
 * Mart and have not" invisible, and that is the most important fact about this
 * product.
 */
export default async function AdminOverviewPage() {
  await requireAdmin();

  const [
    summary,
    services,
    health,
    liveOrders,
    support,
    ratings,
    lowReviews,
    ridersWaiting,
  ] = await Promise.all([
    platformSummary(),
    serviceHealth(),
    deliveryHealth(),
    listOrders({ liveOnly: true, limit: 12 }).then(attachStores),
    supportSummary(),
    ratingSummary(),
    adminReviewFeed(8),
    countPendingApplications(),
  ]);

  const failedTotal = health.byChannel.reduce((sum, row) => sum + row.failed, 0);
  const pendingTotal = health.byChannel.reduce((sum, row) => sum + row.pending, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-bold">Overview</h1>
        <p className="mt-0.5 text-xs text-ink-muted">
          Everything happening right now, across every service.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
        <Stat
          label="Orders in flight"
          value={String(services.reduce((sum, row) => sum + row.liveOrders, 0))}
          note="somebody is waiting"
        />
        <Stat
          label="Credits outstanding"
          value={formatCentavos(summary.creditFloatCentavos)}
          note={`${formatCentavos(summary.creditsGrantedTodayCentavos)} granted today`}
        />
        {/* The waiting count is always in the note, including as a zero — a
            number that only appears when it is bad is one nobody learns to
            read, and an unapproved rider cannot earn. */}
        <Stat
          label="Fleet online"
          value={`${summary.fleetOnline} / ${summary.fleetApproved}`}
          note={
            ridersWaiting === 0
              ? 'online / approved · none waiting'
              : `${ridersWaiting} waiting on approval`
          }
        />
        <Stat
          label="Stores open"
          value={String(summary.storesOpen)}
          note={`${summary.liveSubscriptions} live subscriptions`}
        />
        <Stat
          label="Deliveries failed"
          value={String(failedTotal)}
          note={pendingTotal > 0 ? `${pendingTotal} still queued` : 'nothing queued'}
        />
        <Stat
          label="Ratings this week"
          value={String(ratings.reviewsThisWeek)}
          note={
            ratings.reviews === 0
              ? 'nobody has rated anything yet'
              : `${ratings.lowRatings} at two stars or less, all time`
          }
        />
        {/* Always shown, including as a zero. A number that only appears when
            it is bad is one nobody learns to read. */}
        <Stat
          label="Waiting on support"
          value={String(support.waiting)}
          note={
            support.neverAnswered > 0
              ? `${support.neverAnswered} never answered`
              : support.waiting > 0
                ? `longest ${describeWait(support.longestWaitMinutes)}`
                : 'nobody is waiting'
          }
        />
      </div>

      {/* The most actionable thing in the application: a low score with a
          sentence attached. This is the ONE place a comment appears next to who
          wrote it — the merchant and the rider see the comment without the
          name, because a rider who knows who gave them one star also knows
          that person's address. */}
      {lowReviews.length > 0 ? (
        <Panel
          title="Low ratings"
          description="Three stars or fewer, newest first. The customer's name is shown here and nowhere else; the shop and the rider see the comment without it."
        >
          <ul className="divide-y divide-black/5">
            {lowReviews.map((review) => (
              <li key={review.id} className="px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-[13px]">
                    {review.storeStars !== null && review.store ? (
                      <span className="mr-3">
                        <span aria-hidden className="text-amber-500">
                          {'★'.repeat(review.storeStars)}
                        </span>{' '}
                        <span className="font-semibold">{review.store.name}</span>
                      </span>
                    ) : null}
                    {review.partnerStars !== null && review.fleetPartner ? (
                      <span>
                        <span aria-hidden className="text-amber-500">
                          {'★'.repeat(review.partnerStars)}
                        </span>{' '}
                        <span className="font-semibold">
                          {displayNameFor(review.fleetPartner.user)}
                        </span>
                        <span className="text-[11px] text-ink-faint"> (rider)</span>
                      </span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-[11px] text-ink-faint">
                    {review.order.orderNumber} · {manilaTime(review.createdAt)}
                  </span>
                </div>
                {review.comment ? (
                  <p className="mt-1 text-xs leading-relaxed">{review.comment}</p>
                ) : (
                  <p className="mt-1 text-xs italic text-ink-faint">No comment left.</p>
                )}
                <p className="mt-1 text-[11px] text-ink-faint">
                  From <PersonLink user={review.author} />
                </p>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <Panel
        title="Services"
        description="Every vertical in the registry, launched or not. Today's numbers are Manila time."
        action={
          <Link href="/admin/services" className="text-[12px] font-semibold text-brand-700">
            Launch switches →
          </Link>
        }
      >
        <TableScroll>
          <thead>
            <tr>
              <Th>Service</Th>
              <Th>State</Th>
              <Th numeric>Cities</Th>
              <Th numeric>In flight</Th>
              <Th numeric>Today</Th>
              <Th numeric>Delivered</Th>
              <Th numeric>Cancelled</Th>
              <Th numeric>Gross today</Th>
            </tr>
          </thead>
          <tbody>
            {services.map((service) => (
              <tr key={service.key}>
                <Td>
                  <span className="font-semibold">{service.displayName}</span>
                </Td>
                <Td>
                  {service.isActive ? (
                    <Pill tone="good">Live</Pill>
                  ) : service.isComingSoon ? (
                    <Pill tone="warn">Coming soon</Pill>
                  ) : (
                    <Pill>Off</Pill>
                  )}
                </Td>
                <Td numeric muted={service.cityCount === 0}>
                  {service.cityCount}
                </Td>
                <Td numeric>{service.liveOrders}</Td>
                <Td numeric>{service.ordersToday}</Td>
                <Td numeric>{service.completedToday}</Td>
                <Td numeric muted={service.cancelledToday === 0}>
                  {service.cancelledToday}
                </Td>
                <Td numeric>{formatCentavos(service.grossTodayCentavos)}</Td>
              </tr>
            ))}
          </tbody>
        </TableScroll>
      </Panel>

      <Panel
        title="In flight"
        description="The oldest are the ones to look at."
        action={
          <Link href="/admin/orders" className="text-[12px] font-semibold text-brand-700">
            All orders →
          </Link>
        }
      >
        {liveOrders.length === 0 ? (
          <Empty>Nothing in flight.</Empty>
        ) : (
          <TableScroll>
            <thead>
              <tr>
                <Th>Order</Th>
                <Th>Service</Th>
                <Th>Status</Th>
                <Th>Customer</Th>
                <Th>Store</Th>
                <Th>Partner</Th>
                <Th numeric>Total</Th>
                <Th>Placed</Th>
              </tr>
            </thead>
            <tbody>
              {liveOrders.map((order) => (
                <tr key={order.id}>
                  <Td>
                    <Link
                      href={`/admin/orders/${order.orderNumber}`}
                      className="font-mono text-[11px] font-semibold text-brand-700 hover:underline"
                    >
                      {order.orderNumber}
                    </Link>
                  </Td>
                  <Td>{order.serviceType}</Td>
                  <Td>
                    <StatusPill status={order.status} />
                  </Td>
                  <Td>
                    <PersonLink user={order.customer} />
                  </Td>
                  <Td muted={!order.storeName}>{order.storeName ?? '—'}</Td>
                  <Td muted={!order.assignedRider}>
                    {order.assignedRider?.user.fullName ?? '—'}
                  </Td>
                  <Td numeric>{formatCentavos(order.totalCentavos)}</Td>
                  <Td muted>{manilaTime(order.createdAt)}</Td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        )}
      </Panel>

      <Panel
        title="People and devices"
        description="Push devices are browsers that can still be reached."
      >
        <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-4">
          <Stat label="Accounts" value={String(summary.people)} note={`${summary.onboarded} onboarded`} />
          <Stat label="Blocked" value={String(summary.blocked)} />
          <Stat label="Push devices" value={String(summary.pushDevices)} note={`${health.expiredPushDevices} gone`} />
          <Stat label="Fleet approved" value={String(summary.fleetApproved)} note="for at least one service" />
        </div>
      </Panel>
    </div>
  );
}
