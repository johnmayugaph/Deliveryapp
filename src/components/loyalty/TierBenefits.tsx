import { TierBenefitType } from '@prisma/client';
import { formatCentavos } from '@/lib/money';
import {
  TIER_BENEFIT_NAME,
  describeTierBenefit,
  isBillBenefit,
  isTierBenefitUsable,
  type TierBenefitFacts,
} from '@/lib/loyalty/tier-benefits';

/**
 * What a tier gets you, on the customer's own points screen.
 *
 * Two things this deliberately does not do.
 *
 * It does not show the `displayLabel` alone. That column is whatever an
 * operator typed; the sentence under each heading is generated from the
 * columns the arithmetic actually reads, so a benefit cannot promise on this
 * screen something the checkout would refuse. If the two disagree, both are on
 * screen and the disagreement is visible.
 *
 * And it does not hide the perks behind the discounts. A tier whose only
 * benefit is "answered first" is still worth telling somebody about, and
 * sorting money to the top would teach a reader that the rest is filler.
 */
export function TierBenefits({
  benefits,
  heading,
  emptyText,
  alreadyHave,
}: {
  benefits: readonly TierBenefitFacts[];
  heading: string;
  emptyText?: string;
  /**
   * Types the customer already gets at their current tier, so the next tier's
   * list can mark what is genuinely new. Undefined on the current tier's own
   * list, where everything is already theirs.
   */
  alreadyHave?: readonly TierBenefitType[];
}) {
  const usable = benefits.filter(isTierBenefitUsable);
  if (usable.length === 0) {
    return emptyText ? (
      <p className="px-1 text-[11px] leading-relaxed text-ink-muted">{emptyText}</p>
    ) : null;
  }

  return (
    <div className="space-y-1.5">
      <h3 className="px-1 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
        {heading}
      </h3>
      <ul className="divide-y divide-black/5 overflow-hidden rounded-xl bg-surface ring-1 ring-black/5">
        {usable.map((benefit) => {
          const isNew =
            alreadyHave !== undefined && !alreadyHave.includes(benefit.type);
          return (
            <li key={benefit.id} className="px-3.5 py-2.5">
              <p className="flex items-baseline gap-2 text-[13px] font-medium">
                <span>{TIER_BENEFIT_NAME[benefit.type]}</span>
                {isNew ? (
                  <span className="rounded bg-brand-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-700">
                    New
                  </span>
                ) : null}
                {!isBillBenefit(benefit.type) ? (
                  <span className="text-[10px] font-normal text-ink-faint">
                    not a discount
                  </span>
                ) : null}
              </p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">
                {describeTierBenefit(benefit, formatCentavos)}
              </p>
              {benefit.displayLabel.trim().length > 0 ? (
                <p className="mt-0.5 text-[11px] leading-snug text-ink-faint">
                  {benefit.displayLabel}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
