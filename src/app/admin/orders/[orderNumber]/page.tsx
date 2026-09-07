import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NotificationDeliveryStatus } from '@prisma/client';
import { formatCentavos } from '@/lib/money';
import { requireAdmin } from '@/lib/admin/access';
import { orderDetail } from '@/lib/admin/queries';
import { listAdminActions } from '@/lib/admin/access';
import { getLifecycle } from '@/lib/orders/transitions';
import { getService } from '@/lib/services/registry';
import { storeIdFromDetails } from '@/lib/merchant/access';
import { prisma } from '@/lib/prisma';
import {
  Empty,
  Panel,
  PersonLink,
  Pill,
  StatusPill,
  TableScroll,
  Td,
  Th,
  humaniseEnum,
  manilaTime,
} from '@/components/admin/primitives';

export const dynamic = 'force-dynamic';

/**
 * One order, everything about it.
 *
 * This is the screen support opens when somebody says "my order never
 * arrived". So it puts the four things that answer that question on one page:
 * what state it is in and how it got there, what money moved, what we told the
 * customer and whether the message actually went out, and who was offered the
 * job.
 *
 * Read-only. There is no "force status" button, because a state machine with a
 * manual override is not a state machine — an order pushed straight to
 * DELIVERED skips the credit-back grant and the notification, and the next
 * person to look wonders why the ledger disagrees with the timeline. Fixing a
 * stuck order means fixing the transition that stuck.
 */
export default async function AdminOrderPage({
  params,
}: {
  params: Promise<{ orderNumber: string }>;
}) {
  await requireAdmin();
  const { orderNumber } = await params;

  const order = await orderDetail(decodeURIComponent(orderNumber));
  if (!order) notFound();

  const storeId = storeIdFromDetails(order.details);
  const [store, auditTrail, service] = await Promise.all([
    storeId
      ? prisma.store.findUnique({
          where: { id: storeId },
          select: { id: true, name: true, slug: true },
        })
      : Promise.resolve(null),
    listAdminActions({ subjectType: 'Order', subjectId: order.id, limit: 20 }),
    // Whether a vertical has a merchant or a rider leg is a registry fact, not
    // a lifecycle one — the lifecycle says which states exist, the registry
    // says what the service needs.
    getService(order.serviceType),
  ]);

  const lifecycle = getLifecycle(order.serviceType);
  const nextStates = lifecycle.transitions[order.status] ?? [];

  const fees: [string, number][] = [
    ['Subtotal', order.subtotalCentavos],
    ['Delivery fee', order.deliveryFeeCentavos],
    ['Service fee', order.serviceFeeCentavos],
    ['Small-order fee', order.smallOrderFeeCentavos],
    ['Surge', order.surgeCentavos],
    ['Tip', order.tipCentavos],
  ];
  const discounts: [string, number][] = [
    ['Promo', order.promoDiscountCentavos],
    ['Subscription', order.subscriptionDiscountCentavos],
    ['Credits applied', order.walletCreditAppliedCentavos],
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-mono text-lg font-bold">{order.orderNumber}</h1>
            <StatusPill status={order.status} />
            <Pill>{order.serviceType}</Pill>
          </div>
          <p className="mt-1 text-xs text-ink-muted">
            Placed {manilaTime(order.createdAt)}
            {order.deliveredAt ? ` · delivered ${manilaTime(order.deliveredAt)}` : ''}
            {order.cancelledAt ? ` · cancelled ${manilaTime(order.cancelledAt)}` : ''}
          </p>
        </div>
        <Link href="/admin/orders" className="text-[12px] font-semibold text-brand-700">
          ← All orders
        </Link>
      </div>

      {order.cancellationReason ? (
        <p className="rounded-xl bg-red-50 px-4 py-3 text-xs leading-relaxed text-red-900 ring-1 ring-red-200">
          <span className="font-semibold">
            Cancelled{order.cancelledBy ? ` by ${humaniseEnum(order.cancelledBy)}` : ''}:
          </span>{' '}
          {order.cancellationReason}
        </p>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="Who" description="Customer, store and partner.">
          <dl className="divide-y divide-black/5 text-xs">
            <Row label="Customer">
              <PersonLink user={order.customer} />
              <span className="ml-2 font-mono text-[11px] text-ink-faint">
                {order.customer.phone}
              </span>
              {order.customer.isBlocked ? (
                <span className="ml-2">
                  <Pill tone="bad">Blocked</Pill>
                </span>
              ) : null}
            </Row>
            <Row label="Store">
              {store ? (
                <span>{store.name}</span>
              ) : (
                <span className="text-ink-muted">
                  {service.requiresMerchant
                    ? 'None recorded — which should not happen for this service'
                    : 'This service has no merchant leg'}
                </span>
              )}
            </Row>
            <Row label="Partner">
              {order.assignedRider ? (
                <PersonLink
                  user={{
                    id: order.assignedRider.user.id,
                    fullName: order.assignedRider.user.fullName,
                    phone: order.assignedRider.user.phone,
                  }}
                />
              ) : (
                <span className="text-ink-muted">Not assigned</span>
              )}
            </Row>
            <Row label="Payment">
              <Pill>{humaniseEnum(order.paymentMethod)}</Pill>{' '}
              <Pill tone={order.paymentStatus === 'PAID' ? 'good' : 'warn'}>
                {humaniseEnum(order.paymentStatus)}
              </Pill>
            </Row>
            <Row label="Can go next">
              {nextStates.length === 0 ? (
                <span className="text-ink-muted">Nothing — this is a final state.</span>
              ) : (
                <span className="text-ink-muted">
                  {nextStates.map((state) => humaniseEnum(state)).join(', ')}
                </span>
              )}
            </Row>
          </dl>
        </Panel>

        <Panel title="Money" description="Integer centavos throughout. Nothing here is a float.">
          <dl className="divide-y divide-black/5 text-xs">
            {fees
              .filter(([, amount]) => amount !== 0)
              .map(([label, amount]) => (
                <Row key={label} label={label}>
                  <span className="tabular-nums">{formatCentavos(amount)}</span>
                </Row>
              ))}
            {discounts
              .filter(([, amount]) => amount !== 0)
              .map(([label, amount]) => (
                <Row key={label} label={label}>
                  <span className="tabular-nums text-emerald-700">
                    −{formatCentavos(amount)}
                  </span>
                </Row>
              ))}
            <Row label="Total">
              <span className="font-bold tabular-nums">{formatCentavos(order.totalCentavos)}</span>
            </Row>
          </dl>
        </Panel>
      </div>

      <Panel
        title="Timeline"
        description="Written by the state machine on every transition. Append-only."
      >
        {order.statusEvents.length === 0 ? (
          <Empty>No transitions recorded.</Empty>
        ) : (
          <ol className="divide-y divide-black/5">
            {order.statusEvents.map((event) => (
              <li key={event.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2 text-xs">
                <span className="w-32 shrink-0 text-ink-faint">{manilaTime(event.createdAt)}</span>
                <StatusPill status={event.toStatus} />
                <span className="text-ink-muted">
                  by {humaniseEnum(event.actor)}
                  {event.actorUser
                    ? ` · ${event.actorUser.fullName ?? event.actorUser.phone}`
                    : ''}
                </span>
                {event.reason ? <span className="text-ink-muted">— {event.reason}</span> : null}
              </li>
            ))}
          </ol>
        )}
      </Panel>

      <Panel
        title="Credits ledger"
        description="Every row that touched this order. Append-only, and the balance is derived from it."
      >
        {order.walletTransactions.length === 0 ? (
          <Empty>No credits moved on this order.</Empty>
        ) : (
          <TableScroll>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Type</Th>
                <Th numeric>Amount</Th>
                <Th>Description</Th>
              </tr>
            </thead>
            <tbody>
              {order.walletTransactions.map((entry) => (
                <tr key={entry.id}>
                  <Td muted>{manilaTime(entry.createdAt)}</Td>
                  <Td>
                    <Pill tone={entry.amountCentavos > 0 ? 'good' : 'neutral'}>
                      {humaniseEnum(entry.type)}
                    </Pill>
                  </Td>
                  <Td numeric>
                    <span className={entry.amountCentavos > 0 ? 'text-emerald-700' : ''}>
                      {entry.amountCentavos > 0 ? '+' : '−'}
                      {formatCentavos(Math.abs(entry.amountCentavos))}
                    </span>
                  </Td>
                  <Td muted>{entry.description}</Td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        )}
      </Panel>

      <Panel
        title="What we told people"
        description="And whether it actually went out. A PENDING row means the channel is not configured; SKIPPED means we chose not to."
      >
        {order.notifications.length === 0 ? (
          <Empty>Nothing was sent about this order.</Empty>
        ) : (
          <TableScroll>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Kind</Th>
                <Th>Title</Th>
                <Th>Channels</Th>
              </tr>
            </thead>
            <tbody>
              {order.notifications.map((notification) => (
                <tr key={notification.id}>
                  <Td muted>{manilaTime(notification.createdAt)}</Td>
                  <Td>{humaniseEnum(notification.kind)}</Td>
                  <Td>{notification.title}</Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {notification.deliveries.map((delivery) => (
                        <span key={delivery.channel} title={delivery.lastError ?? undefined}>
                          <Pill
                            tone={
                              delivery.status === NotificationDeliveryStatus.SENT
                                ? 'good'
                                : delivery.status === NotificationDeliveryStatus.FAILED
                                  ? 'bad'
                                  : delivery.status === NotificationDeliveryStatus.PENDING
                                    ? 'warn'
                                    : 'neutral'
                            }
                          >
                            {delivery.channel} · {delivery.status.toLowerCase()}
                          </Pill>
                        </span>
                      ))}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        )}
      </Panel>

      <Panel
        title="Dispatch offers"
        description="Who was offered the job, in order, and what they did about it."
      >
        {order.dispatchOffers.length === 0 ? (
          <Empty>
            No offers.{' '}
            {service.requiresRider
              ? 'For a service that needs a partner, that means dispatch has not run yet.'
              : 'This service does not need a partner.'}
          </Empty>
        ) : (
          <TableScroll>
            <thead>
              <tr>
                <Th>Offered</Th>
                <Th>Partner</Th>
                <Th>Status</Th>
                <Th>Expires</Th>
                <Th>Answered</Th>
              </tr>
            </thead>
            <tbody>
              {order.dispatchOffers.map((offer) => (
                <tr key={offer.id}>
                  <Td muted>{manilaTime(offer.createdAt)}</Td>
                  <Td>{offer.fleetPartner.user.fullName ?? offer.fleetPartner.user.phone}</Td>
                  <Td>
                    <Pill
                      tone={
                        offer.status === 'ACCEPTED'
                          ? 'good'
                          : offer.status === 'EXPIRED' || offer.status === 'DECLINED'
                            ? 'bad'
                            : 'warn'
                      }
                    >
                      {humaniseEnum(offer.status)}
                    </Pill>
                  </Td>
                  <Td muted>{manilaTime(offer.expiresAt)}</Td>
                  <Td muted>{offer.respondedAt ? manilaTime(offer.respondedAt) : '—'}</Td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        )}
      </Panel>

      <Panel title="Addresses" description="Snapshots taken at checkout, not links to the address book.">
        {order.addresses.length === 0 ? (
          <Empty>No addresses recorded.</Empty>
        ) : (
          <ul className="divide-y divide-black/5">
            {order.addresses.map((address) => (
              <li key={address.id} className="px-4 py-2 text-xs">
                <p className="font-semibold">{humaniseEnum(address.role)}</p>
                <p className="mt-0.5 text-ink-muted">
                  {[address.line1, address.line2, address.barangay, address.cityName]
                    .filter(Boolean)
                    .join(', ')}
                </p>
                {address.landmark ? (
                  <p className="mt-0.5 text-ink-faint">Landmark: {address.landmark}</p>
                ) : null}
                {address.deliveryNotes ? (
                  <p className="mt-0.5 text-ink-faint">Notes: {address.deliveryNotes}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {auditTrail.length > 0 ? (
        <Panel title="Admin actions on this order">
          <ul className="divide-y divide-black/5">
            {auditTrail.map((event) => (
              <li key={event.id} className="px-4 py-2 text-xs">
                <span className="text-ink-faint">{manilaTime(event.createdAt)}</span>{' '}
                <span className="font-semibold">{humaniseEnum(event.action)}</span> by{' '}
                {event.actor.fullName ?? event.actor.phone} — {event.reason}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 px-4 py-2">
      <dt className="w-28 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
        {label}
      </dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}
