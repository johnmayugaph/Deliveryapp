import { formatCentavos } from '@/lib/money';
import {
  MIN_ORDERS_FOR_A_SHARE,
  anyTierJumpsTheQueue,
  shareIsMeaningful,
} from '@/lib/merchant/tier-view';
import type { StoreTierStanding } from '@/lib/merchant/tier-customers';

/**
 * What TARA's loyalty tiers mean to this shop.
 *
 * Ordered by what a shop owner asks first. The share of their own orders comes
 * before the ladder, because "does this apply to me" precedes "what is it";
 * and the money TARA absorbed comes before the perk that costs them queue
 * position, because leading with the thing that is taken would misrepresent a
 * balance that is overwhelmingly in the shop's favour.
 */

function Figure({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="rounded-xl bg-surface px-4 py-3 shadow-sm ring-1 ring-black/5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">
        {label}
      </p>
      <p className="mt-1 text-xl font-bold tabular-nums">{value}</p>
      {note ? <p className="mt-0.5 text-[11px] text-ink-faint">{note}</p> : null}
    </div>
  );
}

export function TierStandingPanel({ standing }: { standing: StoreTierStanding }) {
  const {
    tierOrders,
    totalOrders,
    tierSubtotalCentavos,
    loyaltyDiscountAbsorbedCentavos,
    tierCustomers,
    windowDays,
    tiers,
    programmeIsOn,
  } = standing;

  const share =
    totalOrders === 0 ? 0 : Math.round((tierOrders / totalOrders) * 100);

  if (!programmeIsOn) {
    /* Said plainly rather than shown as zeroes. A screen full of dashes reads
       as "no regulars yet", which is a different and discouraging claim. */
    return (
      <section className="space-y-3">
        <div className="rounded-xl bg-surface px-4 py-3 text-xs leading-relaxed text-ink-muted shadow-sm ring-1 ring-black/5">
          <p className="font-semibold text-ink">
            TARA is not running a points programme at the moment.
          </p>
          <p className="mt-1">
            When it is, this page shows how much of your business comes from
            customers who have earned a status, and what their benefits cost you
            — which is nothing.
          </p>
          {loyaltyDiscountAbsorbedCentavos > 0 ? (
            <p className="mt-1">
              While it was running, TARA covered{' '}
              {formatCentavos(loyaltyDiscountAbsorbedCentavos)} on your orders.
              Your payouts were not touched.
            </p>
          ) : null}
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Figure
          label="Your regulars"
          value={String(tierCustomers)}
          note={
            tierCustomers === 0
              ? 'nobody has reached a status here yet'
              : `${tierCustomers === 1 ? 'customer' : 'customers'} with a TARA status`
          }
        />
        <Figure
          label="Their share"
          /* A percentage only once there are enough orders for one to mean
             anything — see MIN_ORDERS_FOR_A_SHARE. Below that the fraction is
             the honest figure, because one more order moves a percentage by
             tens of points and a shop would reasonably read that as a trend. */
          value={
            totalOrders === 0
              ? '—'
              : shareIsMeaningful(totalOrders)
                ? `${share}%`
                : `${tierOrders} of ${totalOrders}`
          }
          note={
            totalOrders === 0
              ? 'no completed orders yet'
              : shareIsMeaningful(totalOrders)
                ? `${tierOrders} of ${totalOrders} orders`
                : `too few orders yet for a percentage to mean much`
          }
        />
        <Figure
          label="They spent"
          value={formatCentavos(tierSubtotalCentavos)}
          note="on food, before commission"
        />
        <Figure
          label="TARA covered"
          value={formatCentavos(loyaltyDiscountAbsorbedCentavos)}
          note="off their bills, not off your payout"
        />
      </div>

      {/* Not `text-ink-faint`. This was the palest text on the screen and it
          carries the one fact most likely to make a shop think the numbers are
          wrong — that an order from three months ago is counted against
          whoever that customer is now. */}
      <p className="px-1 text-[11px] leading-relaxed text-ink-muted">
        Last {windowDays} days, completed orders only — orders you turned down
        are not counted. A customer&rsquo;s status is worked out from what they
        have ordered across TARA recently, so this counts each order against
        whoever that customer is <strong>today</strong>, not what they were when
        they ordered.
      </p>

      {/* The claim the whole screen exists to make, stated once and plainly.
          A shop cannot check it from an order card, which shows a subtotal and
          no discount at all — so the reasonable assumption, absent this, is
          that the platform's generosity is coming out of their margin. */}
      <div className="rounded-xl bg-emerald-50 px-4 py-3 text-xs leading-relaxed text-emerald-900 ring-1 ring-emerald-200">
        <p className="font-semibold">A status costs you nothing.</p>
        <p className="mt-1">
          You are paid the full food subtotal less your usual commission on
          every completed order, whatever discounts the customer had. TARA pays
          for its own benefits out of its own share. There is no version of this
          where a customer&rsquo;s status makes your payout smaller.
        </p>
      </div>

      {tiers.length === 0 ? (
        <p className="px-1 text-[11px] leading-relaxed text-ink-faint">
          No status currently carries a benefit, so nothing about an order
          changes either way.
        </p>
      ) : (
        <div className="space-y-3">
          {tiers.map((tier) => (
            <div
              key={tier.tierId}
              className="rounded-xl bg-surface shadow-sm ring-1 ring-black/5"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-black/5 px-4 py-2.5">
                <h3 className="text-[13px] font-bold">{tier.name}</h3>
                <p className="text-[11px] text-ink-faint">
                  {tier.thresholdPoints.toLocaleString('en-PH')} points
                </p>
              </div>
              <ul className="space-y-1.5 px-4 py-3">
                {tier.platformPays.map((row) => (
                  <li key={row.type} className="flex gap-2 text-xs leading-relaxed">
                    <span aria-hidden className="shrink-0 text-emerald-700">
                      ₱
                    </span>
                    <span className="text-ink-muted">{row.line}</span>
                  </li>
                ))}
                {tier.affectsTheKitchen.map((row) => (
                  <li key={row.type} className="flex gap-2 text-xs leading-relaxed">
                    <span aria-hidden className="shrink-0 text-amber-700">
                      ⏱
                    </span>
                    <span className="text-ink-muted">
                      {row.line}
                      {tier.dispatchHeadStartMinutes > 0 ? (
                        <>
                          {' '}
                          <span className="font-semibold text-ink">
                            Up to {tier.dispatchHeadStartMinutes} minute
                            {tier.dispatchHeadStartMinutes === 1 ? '' : 's'} of
                            head start.
                          </span>
                        </>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {/* Shown only when a status actually reorders the queue. On a ladder of
          bill benefits alone this paragraph would be inventing a worry. */}
      {anyTierJumpsTheQueue(tiers) ? (
        <div className="rounded-xl bg-surface px-4 py-3 text-[11px] leading-relaxed text-ink-muted shadow-sm ring-1 ring-black/5">
          <p className="font-semibold text-ink">
            What the head start actually does.
          </p>
          <p className="mt-1">
            Riders are offered whichever order has waited longest. An order with
            a head start is treated as though it had been placed those minutes
            earlier, so it is offered sooner — ahead of an order that really has
            waited less. That queue covers every shop in the city, so it can be
            another shop&rsquo;s order it goes ahead of, or your own next one.
          </p>
          <p className="mt-1">
            It is a head start, not a separate queue: the head start is capped,
            so an order without one is never stuck behind a status order
            indefinitely. Nothing about it changes when your food has to be
            ready.
          </p>
        </div>
      ) : null}
    </section>
  );
}
