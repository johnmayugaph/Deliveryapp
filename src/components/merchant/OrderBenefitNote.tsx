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
export function OrderBenefitNote({ view }: { view: OrderBenefitView }) {
  if (view.absorbedCentavos === 0) return null;

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

/** The one-line reassurance under the whole list. */
export function AbsorbedTotalNote({
  absorbedCentavos,
  orderCount,
}: {
  absorbedCentavos: number;
  orderCount: number;
}) {
  if (absorbedCentavos === 0) return null;
  return (
    <p className="px-4 pt-2 text-[11px] leading-relaxed text-ink-muted">
      Across {orderCount === 1 ? 'this order' : `these ${orderCount} orders`},
      customers paid{' '}
      <strong className="font-semibold text-ink">
        {formatCentavos(absorbedCentavos)}
      </strong>{' '}
      less than the full price. {ABSORBED_NOTE}
    </p>
  );
}
