import Link from 'next/link';
import type { Promotion } from '@prisma/client';

/** Promotions, already filtered to live services and this city by the loader. */
export function PromotionsRail({ promotions }: { promotions: Promotion[] }) {
  if (promotions.length === 0) {
    return null;
  }

  return (
    <section aria-labelledby="promotions-heading" className="py-3">
      <h2
        id="promotions-heading"
        className="px-4 text-[13px] font-semibold uppercase tracking-wide text-ink-muted"
      >
        Promos
      </h2>
      {/* Horizontal scroll stays inside the rail; the page never scrolls sideways. */}
      <ul className="mt-2.5 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1">
        {promotions.map((promotion) => (
          <li key={promotion.id} className="w-64 shrink-0 snap-start">
            <Link
              href={promotion.ctaHref ?? '#'}
              className="flex h-full flex-col rounded-xl bg-gradient-to-br from-brand-600 to-brand-800 p-4 text-white shadow-sm"
            >
              <span className="text-sm font-semibold leading-snug">{promotion.title}</span>
              {promotion.subtitle ? (
                <span className="mt-1 text-xs leading-snug text-white/85">
                  {promotion.subtitle}
                </span>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
