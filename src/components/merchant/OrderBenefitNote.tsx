import { formatCentavos } from '@/lib/money';
import {
  ABSORBED_NOTE,
  unlistedDiscountNote,
  describeBenefitLine,
  type OrderBenefitView,
} from '@/lib/merchant/order-benefits';

/**
 * What a finished order says about the discounts on it.
 *
 * Renders nothing at all for the ordinary order, which is most of them — a row
 * per order saying "nothing was discounted" would triple the length of a
 * history screen to convey no information.
 *
 * The reassurance is deliberately NOT repeated on every row. It is one line
 * under the list, because a shop needs to be told once that this is TARA's
 * cost and then wants the rows to stay readable.
 */
export function OrderBenefitNote({
  view,
  wasSettled,
}: {
  view: OrderBenefitView;
  /**
   * Whether TARA actually paid for this — settlement accrued on it.
   *
   * A cancelled order that had a discount on it used to render this note in
   * full, reading "Customer paid ₱50 less — TARA covered it" about an order
   * the customer paid nothing for and which was refunded to source. Nothing
   * was covered, so the honest thing to show is nothing.
   */
  wasSettled: boolean;
}) {
  if (view.absorbedCentavos === 0 || !wasSettled) return null;

  return (
    <div className="mt-1.5 rounded-lg bg-emerald-50 px-2.5 py-1.5 text-[11px] leading-relaxed text-emerald-900">
      <p className="font-semibold">
        Customer paid {formatCentavos(view.absorbedCentavos)} less &mdash; TARA
        covered it
      </p>
      {view.lines.length > 0 ? (
        <ul className="mt-0.5 space-y-0.5">
          {view.lines.map((line, index) => (
            <li key={`${line.displayLabel}-${index}`}>
              {describeBenefitLine(line)}
              {line.amountCentavos > 0 ? (
                <span className="tabular-nums">
                  {' '}
                  &minus;{formatCentavos(line.amountCentavos)}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {/* Without this, the lines would not add up to the figure above and a
          shop would be right to wonder what the difference was. A promo code
          and spent credits live on the order's own columns, not as benefit
          rows. */}
      {view.hasUnlistedDiscount ? (
        <p className="mt-0.5">
          {unlistedDiscountNote(view.lines.length > 0)}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The one-line reassurance under the whole list.
 *
 * It said "Across these 12 orders", which sounded like the orders on screen
 * and was in fact the discounted ones among the most recent fifty. It now
 * names the PERIOD, because that is what the figure is over and it is the only
 * form in which it can be compared with anything — the Regulars tab reports
 * the same window, and the settlement ledger is what both are describing.
 */
export function AbsorbedTotalNote({
  absorbedCentavos,
  orderCount,
  windowNote,
}: {
  absorbedCentavos: number;
  orderCount: number;
  windowNote: string;
}) {
  if (absorbedCentavos === 0) return null;
  return (
    <p className="px-4 pt-2 text-[11px] leading-relaxed text-ink-muted">
      Over {windowNote}, customers paid{' '}
      <strong className="font-semibold text-ink">
        {formatCentavos(absorbedCentavos)}
      </strong>{' '}
      less than the full price on{' '}
      {orderCount === 1 ? '1 completed order' : `${orderCount} completed orders`}.{' '}
      {ABSORBED_NOTE}
    </p>
  );
}
