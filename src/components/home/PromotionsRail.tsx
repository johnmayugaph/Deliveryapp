import Link from 'next/link';
import type { Promotion } from '@prisma/client';

/** Promotions, already filtered to live services and this city by the loader. */
export function PromotionsRail({ promotions }: { promotions: Promotion[] }) {
  if (promotions.length === 0) {
    return null;
  }

  return (
    <section aria-labelledby="promotions-heading" className="py-2">
      <h2 id="promotions-heading" className="eyebrow px-4">
        Promos
      </h2>
      {/* Horizontal scroll stays inside the rail; the page never scrolls sideways. */}
      <ul
        className="mt-2.5 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1"
        style={{ scrollbarWidth: 'none' }}
      >
        {promotions.map((promotion) => (
          /*
           * BANNERS, NOT CARDS. Wide enough that the next one peeks in at the
           * right edge, which is the only honest way to tell somebody a
           * horizontal list scrolls. 17.5rem on a 414px screen leaves about
           * 3rem of the second banner showing.
           */
          <li key={promotion.id} className="w-[17.5rem] shrink-0 snap-start">
            <Link
              href={promotion.ctaHref ?? '#'}
              className="press relative flex h-full min-h-[6.5rem] flex-col justify-end overflow-hidden rounded-card shadow-tile ring-1 ring-ink/[0.06]"
            >
              {promotion.imageUrl ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={promotion.imageUrl}
                    alt=""
                    width={560}
                    height={280}
                    loading="lazy"
                    decoding="async"
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                  {/*
                    * A scrim, because the text has to stay readable over a
                    * photograph nobody here has seen. Ink at 72% from the
                    * bottom is the weakest gradient that keeps white type
                    * above 4.5:1 on a bright food photo.
                    */}
                  <span
                    aria-hidden
                    className="absolute inset-0 bg-gradient-to-t from-ink/[0.72] via-ink/25 to-transparent"
                  />
                  <span className="relative p-4 text-surface">
                    <span className="block text-[15px] font-bold leading-snug">
                      {promotion.title}
                    </span>
                    {promotion.subtitle ? (
                      <span className="mt-1 block text-xs leading-snug text-surface/85">
                        {promotion.subtitle}
                      </span>
                    ) : null}
                  </span>
                </>
              ) : (
                /*
                 * No photograph: mango with an ink label, not deep amber with
                 * a white one. The old card was the darkest object on the home
                 * screen and it sat directly under the cart bar, which is also
                 * dark — two slabs stacked, and the promotion lost. Ink on
                 * #ffc01c is 9.6:1, better than the white-on-amber it replaces.
                 */
                <span className="relative flex h-full flex-col justify-end bg-gradient-to-br from-brand-300 via-brand-400 to-brand-500 p-4 text-ink">
                  <span className="block text-[15px] font-bold leading-snug">
                    {promotion.title}
                  </span>
                  {promotion.subtitle ? (
                    <span className="mt-1 block text-xs leading-snug text-ink/70">
                      {promotion.subtitle}
                    </span>
                  ) : null}
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
