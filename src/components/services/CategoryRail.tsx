import Link from 'next/link';
import { menuImageHref } from '@/lib/media/image-bytes';
import type { CategoryTile } from '@/lib/services/service-page-data';

/**
 * The round category rail across the top of a service's shop list.
 *
 * The circles are MENU SECTIONS the shops in this city actually use, not a
 * cuisine taxonomy — there is no cuisine column on `Store`, and inventing one
 * would mean a second place for a merchant to describe themselves that nobody
 * would keep current. What a shop calls its own menu sections is already
 * maintained, already in their words, and already what their customers read.
 *
 * Each circle is a real filter. A rail of pictures that only decorates the top
 * of a list is the kind of thing people tap once.
 *
 * `<img>` rather than `next/image`, following the storefront: these are
 * merchant uploads served from our own route with a year-long immutable
 * cache, and the optimizer would re-encode them into a cache directory this
 * container does not have.
 */
export function CategoryRail({
  categories,
  active,
  hrefFor,
}: {
  categories: CategoryTile[];
  /** The category currently filtering the list, or null. */
  active: string | null;
  /** Link for a circle — null clears the filter. */
  hrefFor: (category: string | null) => string;
}) {
  if (categories.length < 2) {
    // One circle is not a filter, it is the whole list wearing a hat.
    return null;
  }

  return (
    <nav aria-label="Browse by category" className="bg-surface pt-4">
      <ul
        className="flex gap-3.5 overflow-x-auto px-4 pb-1"
        style={{ scrollbarWidth: 'none' }}
      >
        {active !== null ? (
          /* The way back out, in the rail itself. A filter you can only clear
             by finding a chip somewhere else is a filter people leave on and
             then blame the list for. */
          <li className="w-16 shrink-0">
            <Link href={hrefFor(null)} className="press block text-center">
              <span
                aria-hidden
                className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-surface-sunken text-xl ring-1 ring-ink/[0.06]"
              >
                ↺
              </span>
              <span className="mt-1.5 block text-[11.5px] font-bold leading-tight text-ink-muted">
                All
              </span>
            </Link>
          </li>
        ) : null}

        {categories.map((category) => {
          const isActive = active !== null && active.toLowerCase() === category.name.toLowerCase();
          return (
            <li key={category.name} className="w-16 shrink-0">
              <Link
                href={hrefFor(isActive ? null : category.name)}
                aria-current={isActive ? 'true' : undefined}
                className="press block text-center"
              >
                {category.imageId !== null ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={menuImageHref(category.imageId)}
                    alt=""
                    width={128}
                    height={128}
                    loading="lazy"
                    decoding="async"
                    className={`mx-auto h-16 w-16 rounded-full object-cover ${
                      isActive
                        ? 'ring-2 ring-brand-600 ring-offset-2'
                        : 'ring-1 ring-ink/[0.06]'
                    }`}
                  />
                ) : (
                  /* No photograph in this section yet. A tinted circle with
                     the section's initial, never a grey disc: on a new
                     deployment nothing has a photo, and a rail of grey discs
                     is what a launch would look like. */
                  <span
                    aria-hidden
                    className={`mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-brand-50 text-xl font-extrabold text-brand-700 ${
                      isActive
                        ? 'ring-2 ring-brand-600 ring-offset-2'
                        : 'ring-1 ring-ink/[0.06]'
                    }`}
                  >
                    {category.name.slice(0, 1).toUpperCase()}
                  </span>
                )}
                <span
                  className={`mt-1.5 block text-[11.5px] leading-tight ${
                    isActive ? 'font-extrabold text-brand-700' : 'font-bold text-ink'
                  }`}
                >
                  {category.name}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
