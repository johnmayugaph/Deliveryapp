/**
 * Global search box.
 *
 * Searches across every ACTIVE service. The placeholder is built from the
 * registry rather than hardcoded, so it stops saying "restaurants" on its own
 * the day a second vertical goes live.
 */
export function GlobalSearch({ activeServiceNames }: { activeServiceNames: string[] }) {
  const placeholder =
    activeServiceNames.length > 0
      ? `Search ${activeServiceNames.join(', ')}`
      : 'Search';

  return (
    /*
     * Lifted onto the sun band above it by a negative margin, so the two read
     * as one masthead rather than a yellow strip with a search box under it.
     * The overlap is 1.75rem against the band's 2.75rem of bottom padding,
     * which leaves the pill clear of the rounded corners at every width the
     * shell allows.
     */
    <div className="relative -mt-7 px-4 pb-1">
      <form action="/search" method="get" role="search">
        <label htmlFor="global-search" className="sr-only">
          Search across services
        </label>
        <div className="flex items-center gap-2.5 rounded-full bg-surface px-4 py-3 shadow-tile ring-1 ring-ink/[0.06] transition-shadow focus-within:shadow-lifted">
          <span aria-hidden className="text-sm">
            🔎
          </span>
          <input
            id="global-search"
            name="q"
            type="search"
            autoComplete="off"
            placeholder={placeholder}
            className="w-full bg-transparent text-[13.5px] text-ink placeholder:text-ink-faint focus:outline-none"
          />
        </div>
      </form>
    </div>
  );
}
