import Link from 'next/link';
import { formatCentavos } from '@/lib/money';
import { requireAdmin } from '@/lib/admin/access';
import { deliveryHealth, platformSummary, serviceHealth } from '@/lib/admin/queries';
import { supportSummary } from '@/lib/support/queries';
import { countPendingApplications } from '@/lib/admin/fleet';
import { errorSummary } from '@/lib/monitoring/queries';
import { adminReviewFeed, ratingSummary } from '@/lib/ratings/reviews';
import { displayNameFor } from '@/lib/auth/session';
import { describeWait } from '@/lib/support/policy';
import { formatDayIn } from '@/lib/time/manila';
import { listOrders, attachStores } from '@/lib/admin/queries';
import { changePercent, customerMix, dashboardSeries, topStores } from '@/lib/admin/series';
import { AreaChart, Sparkline } from '@/components/admin/Charts';
import {
  Empty,
  KpiCard,
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

/** The reporting window for everything on this screen that has a history. */
const WINDOW_DAYS = 30;

/**
 * The overview.
 *
 * Answers one question: is anything wrong right now. So the things on it are
 * the things that go wrong — orders stuck waiting, deliveries that failed, a
 * credit float that moved — rather than the numbers that look good in a deck.
 *
 * THE LAYOUT IS THE ONE EVERY OPERATIONS CONSOLE USES, and each band answers a
 * different question. The headline row is what the business did, with a line
 * showing whether it is going up. The row under it is what needs a person, and
 * every one of those is rendered even at zero — a figure that only appears
 * when it is bad is a figure nobody learns to read. Then the panels: where the
 * money came from, who is buying, and what is broken.
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
    errors,
    series,
    stores,
    mix,
  ] = await Promise.all([
    platformSummary(),
    serviceHealth(),
    deliveryHealth(),
    listOrders({ liveOnly: true, limit: 12 }).then(attachStores),
    supportSummary(),
    ratingSummary(),
    adminReviewFeed(8),
    countPendingApplications(),
    errorSummary(),
    dashboardSeries(WINDOW_DAYS),
    topStores(WINDOW_DAYS),
    customerMix(WINDOW_DAYS),
  ]);

  const failedTotal = health.byChannel.reduce((sum, row) => sum + row.failed, 0);
  const pendingTotal = health.byChannel.reduce((sum, row) => sum + row.pending, 0);
  const inFlight = services.reduce((sum, row) => sum + row.liveOrders, 0);

  /** Landed out of placed, over the window. Null before anything was placed. */
  const landedRate =
    series.totals.orders === 0
      ? null
      : Math.round((series.totals.completed / series.totals.orders) * 100);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-bold">Overview</h1>
        <p className="mt-0.5 text-xs text-ink-muted">
          Everything happening right now, across every service. Figures with a
          line cover the last {WINDOW_DAYS} days, in Manila time.
        </p>
      </div>

      {/* WHAT THE BUSINESS DID. Five, because a row of five is still readable
          at a glance and the sixth is always the one that gets skipped. */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <KpiCard
          label="Gross"
          value={formatCentavos(series.totals.grossCentavos)}
          change={
            series.yesterday
              ? changePercent(series.today.grossCentavos, series.yesterday.grossCentavos)
              : null
          }
          note={`${formatCentavos(series.today.grossCentavos)} today · delivered orders only`}
          chart={<Sparkline values={series.days.map((day) => day.grossCentavos)} />}
        />
        <KpiCard
          label="Orders"
          value={String(series.totals.orders)}
          change={
            series.yesterday ? changePercent(series.today.orders, series.yesterday.orders) : null
          }
          note={`${series.today.orders} placed today`}
          chart={<Sparkline values={series.days.map((day) => day.orders)} />}
        />
        <KpiCard
          label="Delivered"
          value={landedRate === null ? '—' : `${landedRate}%`}
          note={
            landedRate === null
              ? 'nothing ordered in the window'
              : `${series.totals.completed} of ${series.totals.orders} landed`
          }
          /* No sparkline here on purpose. The figure is a RATE and the only
             daily line available is a count — a card whose number says one
             thing while the line beside it draws another is worse than a card
             with no line, because the reader trusts the picture. A daily rate
             is also undefined on every day nothing was ordered. */
        />
        <KpiCard
          label="In flight"
          value={String(inFlight)}
          note={inFlight === 0 ? 'nobody is waiting' : 'somebody is waiting'}
        />
        <KpiCard
          label="Credits outstanding"
          value={formatCentavos(summary.creditFloatCentavos)}
          note={`${formatCentavos(summary.creditsGrantedTodayCentavos)} granted today`}
        />
      </div>

      {/* WHAT NEEDS A PERSON. Every one rendered at zero as well, on purpose. */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
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
        <Stat
          label="Open faults"
          value={String(errors.open)}
          note={errors.newToday > 0 ? `${errors.newToday} new today` : 'none new today'}
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
      </div>

      <div className="grid gap-3 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <Panel
            title="Gross, by day"
            description={`Delivered orders over the last ${WINDOW_DAYS} days. An order counts on the day it was placed.`}
          >
            <AreaChart
              points={series.days.map((day) => ({
                label: formatDayIn(day.day),
                value: day.grossCentavos,
              }))}
              formatValue={formatCentavos}
            />
            <div className="grid grid-cols-2 gap-3 border-t border-black/5 p-4 sm:grid-cols-4">
              <Stat label="Gross" value={formatCentavos(series.totals.grossCentavos)} />
              <Stat
                label="Average order"
                value={
                  series.totals.completed === 0
                    ? '—'
                    : formatCentavos(
                        Math.round(series.totals.grossCentavos / series.totals.completed),
                      )
                }
              />
              <Stat label="Delivered" value={String(series.totals.completed)} />
              <Stat label="Placed" value={String(series.totals.orders)} />
            </div>
          </Panel>
        </div>

        <Panel
          title="Busiest stores"
          description={`By delivered orders, last ${WINDOW_DAYS} days.`}
          action={
            <Link href="/admin/stores" className="text-[12px] font-semibold text-brand-700">
              All stores →
            </Link>
          }
        >
          {stores.length === 0 ? (
            <Empty>Nothing has been delivered yet.</Empty>
          ) : (
            <ul className="divide-y divide-black/5">
              {stores.map((store, index) => (
                <li key={store.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="w-4 shrink-0 text-[12px] font-bold tabular-nums text-ink-faint">
                    {index + 1}
                  </span>
                  {store.logoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={store.logoUrl}
                      alt=""
                      width={64}
                      height={64}
                      className="h-8 w-8 shrink-0 rounded-lg object-cover ring-1 ring-black/5"
                    />
                  ) : (
                    <span
                      aria-hidden
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-[13px] font-bold text-brand-700"
                    >
                      {store.name.slice(0, 1).toUpperCase()}
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold">
                      {store.name}
                    </span>
                    <span className="block text-[11px] text-ink-faint">
                      {store.orders} delivered
                    </span>
                  </span>
                  <span className="shrink-0 text-[13px] font-bold tabular-nums">
                    {formatCentavos(store.grossCentavos)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <div className="grid gap-3 xl:grid-cols-3">
        <Panel
          title="Customers"
          description="Somebody counts as returning once they have had two orders delivered, ever."
        >
          <div className="grid grid-cols-2 gap-3 p-4">
            <Stat
              label="New"
              value={String(mix.newCustomers)}
              note={`first delivery in ${WINDOW_DAYS} days`}
            />
            <Stat label="Returning" value={String(mix.returning)} note="two or more delivered" />
            <Stat
              label="Orders each"
              value={mix.ordersPerCustomer === null ? '—' : mix.ordersPerCustomer.toFixed(1)}
              note="among people who have ordered"
            />
            <Stat
              label="Registered"
              value={String(mix.registered)}
              note={`${summary.onboarded} onboarded`}
            />
          </div>
        </Panel>

        <Panel
          title="Platform health"
          description="Green is not a claim that nothing is wrong — it is a claim that these four checks passed."
        >
          <ul className="divide-y divide-black/5">
            <HealthRow
              label="Notifications"
              ok={failedTotal === 0}
              value={failedTotal === 0 ? 'Delivering' : `${failedTotal} failed`}
            />
            <HealthRow
              label="Queued notifications"
              ok={pendingTotal === 0}
              value={pendingTotal === 0 ? 'Empty' : `${pendingTotal} waiting`}
            />
            <HealthRow
              label="Open faults"
              ok={errors.open === 0}
              value={errors.open === 0 ? 'None' : String(errors.open)}
            />
            <HealthRow
              label="Support queue"
              ok={support.waiting === 0}
              value={support.waiting === 0 ? 'Empty' : `${support.waiting} waiting`}
            />
          </ul>
        </Panel>

        <Panel
          title="Push devices"
          description="Browsers we can still reach."
        >
          <div className="grid grid-cols-2 gap-3 p-4">
            <Stat label="Reachable" value={String(summary.pushDevices)} />
            <Stat label="Gone" value={String(health.expiredPushDevices)} />
            <Stat label="Accounts" value={String(summary.people)} />
            <Stat label="Blocked" value={String(summary.blocked)} />
          </div>
        </Panel>
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
    </div>
  );
}

/** One check, with a state nobody has to interpret a colour to read. */
function HealthRow({ label, ok, value }: { label: string; ok: boolean; value: string }) {
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-2.5">
      <span className="text-[13px] font-semibold">{label}</span>
      <span
        className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ${
          ok ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-100 text-amber-900'
        }`}
      >
        {value}
      </span>
    </li>
  );
}
