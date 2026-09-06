import { notFound } from 'next/navigation';
import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { getCurrentUser } from '@/lib/auth/session';
import { StatusPill } from '@/components/ui/StatusPill';
import { statusPresentation } from '@/lib/orders/status-presentation';
import { summariseDetails } from '@/lib/orders/details';
import { serviceGlyph } from '@/lib/services/presentation';
import { formatCentavos } from '@/lib/money';
import { allowedTransitions, isTerminal } from '@/lib/orders/state-machine';

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
  const user = await getCurrentUser();

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      service: true,
      addresses: true,
      statusEvents: { orderBy: { createdAt: 'asc' } },
      appliedBenefits: true,
    },
  });

  // Scoped to the signed-in customer: an order id is not an access token.
  if (!order || !user || order.customerId !== user.id) {
    notFound();
  }

  const dropoff = order.addresses.find((address) => address.role === 'DROPOFF');
  const nextStates = allowedTransitions(order.serviceType, order.status);

  const feeLines = [
    { label: 'Subtotal', centavos: order.subtotalCentavos, sign: 1 },
    { label: 'Delivery fee', centavos: order.deliveryFeeCentavos, sign: 1 },
    { label: 'Service fee', centavos: order.serviceFeeCentavos, sign: 1 },
    { label: 'Small order fee', centavos: order.smallOrderFeeCentavos, sign: 1 },
    { label: 'Surge', centavos: order.surgeCentavos, sign: 1 },
    { label: 'Tip', centavos: order.tipCentavos, sign: 1 },
    { label: 'Promo', centavos: order.promoDiscountCentavos, sign: -1 },
    { label: 'Plus benefits', centavos: order.subscriptionDiscountCentavos, sign: -1 },
    { label: 'Credits', centavos: order.walletCreditAppliedCentavos, sign: -1 },
  ].filter((line) => line.centavos > 0);

  return (
    <main>
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
            Papunta sa {dropoff.line1}
            {dropoff.barangay ? `, ${dropoff.barangay}` : ''}, {dropoff.cityName}
          </p>
        ) : null}
      </header>

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
        {!isTerminal(order.serviceType, order.status) && nextStates.length > 0 ? (
          <p className="mt-2 text-[11px] text-ink-faint">
            Susunod: {nextStates.map((state) => statusPresentation(state).label).join(' / ')}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="fees-heading" className="mx-4 mt-4">
        <h2
          id="fees-heading"
          className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted"
        >
          Bayad
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

      <section className="mx-4 mt-4">
        <Link
          href={`/help?orderId=${order.id}`}
          className="flex items-center justify-between rounded-xl bg-surface px-3 py-3 shadow-sm ring-1 ring-black/5"
        >
          <span className="text-sm font-semibold">May problema sa order na ito?</span>
          <span aria-hidden className="text-xs text-ink-faint">
            ›
          </span>
        </Link>
      </section>
    </main>
  );
}
