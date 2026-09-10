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
        className="eyebrow px-4"
      >
        Promos
      </h2>
      {/* Horizontal scroll stays inside the rail; the page never scrolls sideways. */}
      <ul className="mt-2.5 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1">
        {promotions.map((promotion) => (
          <li key={promotion.id} className="w-64 shrink-0 snap-start">
            <Link
              href={promotion.ctaHref ?? '#'}
              /*
               * Mango with an ink label, not deep amber with a white one.
               * The old card was the darkest object on the home screen and it
               * sat directly under the cart bar, which is also dark — two
               * slabs stacked, and the promotion lost. Yellow is the one thing
               * on this page that can be bright without being loud, and ink on
               * #ffc01c is 9.6:1, better than the white-on-amber it replaces.
               */
              className="press flex h-full flex-col rounded-card bg-gradient-to-br from-brand-300 via-brand-400 to-brand-500 p-4 text-ink shadow-tile ring-1 ring-ink/[0.06]"
            >
              <span className="text-[14.5px] font-bold leading-snug">{promotion.title}</span>
              {promotion.subtitle ? (
                <span className="mt-1 text-xs leading-snug text-ink/70">
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
