import type { PromoCode } from '@prisma/client';
import { formatCentavos } from '@/lib/money';
import { promoOfferLabel } from '@/lib/promo/policy';

/**
 * This shop's live deals, as chips.
 *
 * The same `PromoCode` rows and the same label function the shop list uses, so
 * a deal somebody tapped a shop for is still on the screen when they arrive —
 * and reads identically. A chip that says one thing on the list and another on
 * the shop's page is how a customer decides a price is negotiable.
 *
 * The code itself is printed. On the list there is no room and the chip is an
 * advertisement; here it is an instruction, and a customer who cannot see the
 * word to type has to go and find it.
 */
export function DealRail({ deals }: { deals: PromoCode[] }) {
  if (deals.length === 0) {
    return null;
  }

  return (
    <section aria-labelledby="deals-heading" className="pt-3">
      <h2 id="deals-heading" className="sr-only">
        Deals here
      </h2>
      <ul
        className="flex gap-2 overflow-x-auto px-4"
        style={{ scrollbarWidth: 'none' }}
      >
        {deals.map((deal) => (
          <li
            key={deal.id}
            className="shrink-0 rounded-2xl bg-sun-100 px-3.5 py-2 ring-1 ring-sun-400/40"
          >
            <p className="text-[13px] font-extrabold leading-tight text-sun-700">
              {promoOfferLabel(deal)}
            </p>
            <p className="mt-0.5 text-[11px] leading-tight text-ink-muted">
              Code {deal.code}
              {deal.minimumOrderCentavos > 0
                ? ` · min ${formatCentavos(deal.minimumOrderCentavos)}`
                : ''}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
