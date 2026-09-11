'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import type { Promotion } from '@prisma/client';

/**
 * Promotions, already filtered to live services and this city by the loader.
 *
 * A carousel with dots, which is what the reference does and what people
 * expect a promotions strip to be. The dots are not decoration: without them a
 * horizontal list on a phone gives no indication that a second card exists,
 * and the second card is the one nobody ever sees.
 *
 * A CLIENT COMPONENT, and only for the dots. The cards themselves would render
 * fine on the server; tracking which one is centred needs the scroll position,
 * which does not exist there. The trade is one small bundle for the only piece
 * of state on this screen.
 */
export function PromotionsRail({ promotions }: { promotions: Promotion[] }) {
  const rail = useRef<HTMLUListElement>(null);
  const [active, setActive] = useState(0);

  if (promotions.length === 0) {
    return null;
  }

  /**
   * Which card is showing, from the scroll offset.
   *
   * Rounded rather than floored: at rest the rail is snapped to a card, and
   * rounding puts the boundary halfway through a swipe instead of at the point
   * where the next card has only just begun to appear.
   */
  function onScroll() {
    const node = rail.current;
    if (!node) return;
    const width = node.clientWidth;
    if (width === 0) return;
    setActive(Math.round(node.scrollLeft / width));
  }

  return (
    <section aria-labelledby="promotions-heading" className="pb-3">
      <h2 id="promotions-heading" className="sr-only">
        Promos
      </h2>
      <ul
        ref={rail}
        onScroll={onScroll}
        className="flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1"
        style={{ scrollbarWidth: 'none' }}
      >
        {promotions.map((promotion) => (
          /* Full-width cards, so one promotion fills the rail and the next is
             a swipe rather than a peek. The dots carry the "there is more"
             signal that a peeking card would otherwise have to. */
          <li key={promotion.id} className="w-full shrink-0 snap-center">
            <Link
              href={promotion.ctaHref ?? '#'}
              className="press relative flex h-[7.5rem] flex-col justify-end overflow-hidden rounded-2xl shadow-tile ring-1 ring-ink/[0.06]"
            >
              {promotion.imageUrl ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={promotion.imageUrl}
                    alt=""
                    width={720}
                    height={300}
                    loading="lazy"
                    decoding="async"
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                  {/* The weakest gradient that keeps white type above 4.5:1
                      over a photograph nobody here has seen. */}
                  <span
                    aria-hidden
                    className="absolute inset-0 bg-gradient-to-t from-ink/[0.72] via-ink/25 to-transparent"
                  />
                  <span className="relative p-4 text-surface">
                    <span className="block text-[15px] font-extrabold leading-snug">
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
                /* Yellow, with an ink label. The card sits ON the magenta
                   header block, so a promotion in any pink would vanish into
                   it; yellow is the one colour here that can carry weight
                   against that ground. White on it is 1.7:1, so the label is
                   always ink. */
                <span className="relative flex h-full flex-col justify-end bg-sun p-4 text-ink">
                  <span className="block text-[15px] font-extrabold leading-snug">
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

      {promotions.length > 1 ? (
        <div className="mt-2.5 flex items-center justify-center gap-1.5" aria-hidden>
          {promotions.map((promotion, index) => (
            <span
              key={promotion.id}
              className={`h-1.5 rounded-full transition-all duration-200 ${
                index === active ? 'w-5 bg-white' : 'w-1.5 bg-white/40'
              }`}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
