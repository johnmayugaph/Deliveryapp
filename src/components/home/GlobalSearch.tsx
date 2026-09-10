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
    /* Sits inside the header block, so it reads as part of the masthead
       rather than the first row of the page under it. */
    <div className="px-4 pb-6">
      <form action="/search" method="get" role="search">
        <label htmlFor="global-search" className="sr-only">
          Search across services
        </label>
        <div className="flex items-center gap-2.5 rounded-xl bg-surface px-3.5 py-3 shadow-tile ring-1 ring-ink/[0.06] transition-shadow focus-within:shadow-lifted">
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
