import { notFound } from 'next/navigation';
import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { requireScreen } from '@/lib/auth/access';
import { StatusPill } from '@/components/ui/StatusPill';
import { statusPresentation } from '@/lib/orders/status-presentation';
import { summariseDetails } from '@/lib/orders/details';
import { serviceGlyph } from '@/lib/services/presentation';
import { formatCentavos } from '@/lib/money';
import {
  allowedTransitions,
  isActorPermitted,
  isInProgress,
  isTerminal,
} from '@/lib/orders/state-machine';
import { OrderLiveRefresh } from '@/components/orders/OrderLiveRefresh';
import { CancelOrderButton } from '@/components/orders/CancelOrderButton';
import { OrderActor, OrderStatus } from '@prisma/client';
import { cancellationStatusForActor } from '@/lib/orders/state-machine';
import { reviewableOrder } from '@/lib/ratings/reviews';
import { REVIEW_REFUSAL_MESSAGE } from '@/lib/ratings/policy';
import { RatingForm } from '@/components/orders/RatingForm';
import { RiderMap } from '@/components/orders/RiderMap';
import { isTrackableStatus } from '@/lib/orders/tracking';
import { PayByTransfer } from '@/components/orders/PayByTransfer';
import { latestRefusalNote, transferDetailsFor } from '@/lib/payments/order-view';
import { heldForCustomerCentavos } from '@/lib/payments/events';
import { isPrepaid } from '@/lib/payments/policy';
import { tileSource } from '@/lib/geo/tiles';

export const dynamic = 'force-dynamic';

/**
 * Order tracking, for any vertical.
 *
 * The timeline is the `OrderStatusEvent` audit trail the state machine writes,
 * and "what happens next" comes from `allowedTransitions()` — so this screen is
 * correct for a parcel or a ride without knowing either exists.
 */
export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const { orderId } = await params;
  /* Before the query, and carrying this order's id so signing in lands back
     on it. It used to be a nullable read that fell into the `notFound()`
     below, which told a customer whose session had ended that their own order
     did not exist — while the food was on its way. */
  const user = await requireScreen('orderDetail', orderId);

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      service: true,
      addresses: true,
      statusEvents: { orderBy: { createdAt: 'asc' } },
      appliedBenefits: true,
      // The rider's NAME, for the map's caption. Never their position: that is
      // read by `riderPositionForCustomer`, which applies the freshness rule
      // and would otherwise be bypassed by a page that had the columns to
      // hand.
      assignedRider: {
        select: { user: { select: { fullName: true, displayName: true } } },
      },
      // The code's own name for the receipt line, on the same argument as
      // `surgeLabel`: a bare "Promo −₱50" read next month says nothing about
      // why. It cannot go missing while the discount is on the order, because
      // `PromoRedemption.promoCode` is RESTRICT — a used code cannot be
      // deleted, only switched off.
      promoRedemption: {
        include: { promoCode: { select: { label: true } } },
      },
    },
  });

  /* Scoped to the signed-in customer: an order id is not an access token.
     `notFound()` is the right answer to somebody else's order — telling a
     stranger that an id is real is itself a disclosure — and it is now
     reached only for that, because the no-user case redirects above. */
  if (!order || order.customerId !== user.id) {
    notFound();
  }

  // Payment, resolved after the ownership check above — the instructions name
  // the account money goes to, and nobody who is not this order's customer
  // gets that far.
  const transfer =
    order.status === OrderStatus.PENDING_PAYMENT && isPrepaid(order.paymentMethod)
      ? await transferDetailsFor(order.id)
      : null;
  const refusalNote = transfer ? await latestRefusalNote(order.id) : null;

  // Only meaningful once the order is over: while it is live, money we hold is
  // money we are owed.
  const refundDueCentavos = isTerminal(order.serviceType, order.status)
    ? await heldForCustomerCentavos(order.id)
    : 0;

  const dropoff = order.addresses.find((address) => address.role === 'DROPOFF');
  const nextStates = allowedTransitions(order.serviceType, order.status);

  // Whether the customer may cancel is the transition map's decision, not this
  // screen's: a food order can be cancelled while the store decides or cooks,
  // but not once a partner is carrying it.
  const customerCancellation = cancellationStatusForActor(OrderActor.CUSTOMER);
  const canCustomerCancel =
    nextStates.includes(customerCancellation) &&
    isActorPermitted(order.serviceType, customerCancellation, OrderActor.CUSTOMER);

  const isLive = isInProgress(order.serviceType, order.status);

  // Only for a completed order: `reviewableOrder` resolves what there is to
  // rate from the registry and the order's own dispatch record, and asking it
  // about a live order would be a query for nothing.
  const reviewable =
    order.status === OrderStatus.COMPLETED
      ? await reviewableOrder({ orderId: order.id, userId: user.id })
      : null;

  // The "what happens next" hint should show the forward path only. Listing
  // every cancellation state reads as a menu of ways the order might fail.
  const forwardStates = nextStates.filter(
    (state) => !isTerminal(order.serviceType, state) || state === OrderStatus.COMPLETED,
  );

  const feeLines = [
    { label: 'Subtotal', centavos: order.subtotalCentavos, sign: 1 },
    { label: 'Delivery fee', centavos: order.deliveryFeeCentavos, sign: 1 },
    { label: 'Service fee', centavos: order.serviceFeeCentavos, sign: 1 },
    { label: 'Small order fee', centavos: order.smallOrderFeeCentavos, sign: 1 },
    {
      // The band's own name, so a receipt read next month still says WHY.
      label: order.surgeLabel ?? 'Busy at the time',
      centavos: order.surgeCentavos,
      sign: 1,
    },
    { label: 'Tip', centavos: order.tipCentavos, sign: 1 },
    {
      label: order.promoRedemption?.promoCode.label ?? 'Promo',
      centavos: order.promoDiscountCentavos,
      sign: -1,
    },
    { label: 'Plus benefits', centavos: order.subscriptionDiscountCentavos, sign: -1 },
    // Its own line, never folded into the one above. A customer who has never
    // paid for Plus, reading "Plus benefits −₱49", has been told something
    // false about why their delivery was free.
    { label: 'Your tier', centavos: order.loyaltyDiscountCentavos, sign: -1 },
    { label: 'Credits', centavos: order.walletCreditAppliedCentavos, sign: -1 },
  ].filter((line) => line.centavos > 0);

  return (
    <main>
      <OrderLiveRefresh isActive={isLive} />

      <header className="bg-surface px-4 pb-4 pt-5">
        <Link href="/orders" className="text-xs font-semibold text-brand-700">
          ← Orders
        </Link>
        <h1 className="mt-2 flex items-center gap-2 text-lg font-bold">
          <span aria-hidden>{serviceGlyph(order.service.icon)}</span>
          {order.service.displayName}
        </h1>
        <p className="mt-0.5 text-xs text-ink-muted">{order.orderNumber}</p>
        <div className="mt-2">
          <StatusPill status={order.status} />
        </div>
        {dropoff ? (
          <p className="mt-3 text-xs text-ink-muted">
            Going to {dropoff.line1}
            {dropoff.barangay ? `, ${dropoff.barangay}` : ''}, {dropoff.cityName}
          </p>
        ) : null}
        {order.etaAt && isLive ? (
          <p className="mt-1 text-xs font-semibold text-brand-700">
            Estimated arrival{' '}
            {order.etaAt.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' })}
          </p>
        ) : null}
        {order.status === OrderStatus.CANCELLED_BY_SYSTEM && order.cancellationReason ? (
          <p className="mt-2 rounded-lg bg-rose-50 px-2.5 py-2 text-xs text-rose-800">
            {order.cancellationReason}
          </p>
        ) : null}
      </header>

      {/* Paying, before anything else on the screen.
          An order held for payment is the one case where the customer has
          something to DO, and it goes above the map and the timeline because
          nothing else on this page matters until it is done. Once confirmed
          the panel disappears and the tracking panel takes its place. */}
      {transfer ? (
        <div className="mx-4 mt-4">
          <PayByTransfer
            orderId={order.id}
            status={order.paymentStatus}
            details={transfer}
            refusalNote={refusalNote}
          />
        </div>
      ) : null}

      {/* Money we are holding that is not ours.
          A cancelled prepaid order says so here rather than leaving somebody
          to wonder where their ₱324 went. It is not a promise of a date: on
          this rail a person makes the transfer, and inventing a deadline for
          them would be inventing a complaint. */}
      {refundDueCentavos > 0 ? (
        <div className="mx-4 mt-4 rounded-xl bg-amber-50 px-4 py-3 ring-1 ring-amber-200">
          <p className="text-[13px] font-semibold text-amber-900">
            {formatCentavos(refundDueCentavos)} is coming back to you
          </p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-amber-900/80">
            This order did not go ahead, so we are returning what you sent. You
            do not need to do anything — we will message you when it is on its
            way.
          </p>
        </div>
      ) : null}

      {/* The map, and only while somebody is carrying this. Not on a
          delivered order — where the rider went afterwards is nobody's
          business — and not before assignment, when there is nobody to show.
          Gating it here is also what keeps map tiles proportional to live
          deliveries rather than to page views. */}
      {isTrackableStatus(order.status) && dropoff ? (
        <div className="mx-4 mt-4">
          <RiderMap
            orderId={order.id}
            tileSource={tileSource()}
            dropoff={{ latitude: dropoff.latitude, longitude: dropoff.longitude }}
            riderName={
              order.assignedRider
                ? order.assignedRider.user.displayName ??
                  order.assignedRider.user.fullName ??
                  null
                : null
            }
          />
        </div>
      ) : null}

      <section aria-labelledby="summary-heading" className="mx-4 mt-4">
        <h2 id="summary-heading" className="sr-only">
          Order summary
        </h2>
        <p className="rounded-xl bg-surface p-4 text-sm shadow-sm ring-1 ring-black/5">
          {summariseDetails(order.details, order.service.displayName)}
        </p>
      </section>

      <section aria-labelledby="timeline-heading" className="mx-4 mt-4">
        <h2
          id="timeline-heading"
          className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted"
        >
          Timeline
        </h2>
        <ol className="mt-2 space-y-2">
          {order.statusEvents.map((event) => (
            <li
              key={event.id}
              className="flex items-baseline gap-3 rounded-xl bg-surface px-3 py-2.5 shadow-sm ring-1 ring-black/5"
            >
              <span className="text-[11px] tabular-nums text-ink-faint">
                {event.createdAt.toLocaleTimeString('en-PH', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">
                  {statusPresentation(event.toStatus).label}
                </span>
                {event.reason ? (
                  <span className="mt-0.5 block text-xs text-ink-muted">
                    {event.reason}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
        {!isTerminal(order.serviceType, order.status) && forwardStates.length > 0 ? (
          <p className="mt-2 text-[11px] text-ink-faint">
            Next: {forwardStates.map((state) => statusPresentation(state).label).join(' / ')}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="fees-heading" className="mx-4 mt-4">
        <h2
          id="fees-heading"
          className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted"
        >
          Payment
        </h2>
        <dl className="mt-2 rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5">
          {feeLines.map((line) => (
            <div key={line.label} className="flex justify-between py-1 text-xs">
              <dt className="text-ink-muted">{line.label}</dt>
              <dd className="tabular-nums">
                {line.sign < 0 ? '−' : ''}
                {formatCentavos(line.centavos)}
              </dd>
            </div>
          ))}
          <div className="mt-2 flex justify-between border-t border-black/5 pt-2 text-sm font-semibold">
            <dt>Total</dt>
            <dd className="tabular-nums">{formatCentavos(order.totalCentavos)}</dd>
          </div>
        </dl>
      </section>

      {canCustomerCancel ? (
        <section className="mx-4 mt-4">
          <CancelOrderButton orderId={order.id} />
        </section>
      ) : null}

      {/* Above support, not below it. Somebody whose order went well should
          find the rating first, and somebody whose order went badly is not
          going to miss the help link. */}
      {reviewable && (reviewable.store || reviewable.partner) ? (
        <section className="mx-4 mt-4">
          {reviewable.eligibility.allowed ? (
            <RatingForm
              orderId={order.id}
              store={reviewable.store}
              partner={reviewable.partner}
              existing={reviewable.existing}
            />
          ) : reviewable.existing ? (
            <div className="rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5">
              <p className="text-sm font-semibold">You rated this order</p>
              <p className="mt-1 text-xs leading-relaxed text-ink-muted">
                {REVIEW_REFUSAL_MESSAGE[reviewable.eligibility.reason]}
              </p>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="mx-4 mt-4 mb-8">
        <Link
          href={`/help/contact?order=${order.id}`}
          className="flex items-center justify-between rounded-xl bg-surface px-3 py-3 shadow-sm ring-1 ring-black/5"
        >
          <span className="text-sm font-semibold">Something wrong with this order?</span>
          <span aria-hidden className="text-xs text-ink-faint">
            ›
          </span>
        </Link>
      </section>
    </main>
  );
}
