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
    <div className="bg-surface px-4 pb-4">
      <form action="/search" method="get" role="search">
        <label htmlFor="global-search" className="sr-only">
          Search across services
        </label>
        <div className="flex items-center gap-2 rounded-xl bg-surface-sunken px-3 py-2.5 ring-1 ring-black/5 focus-within:ring-2 focus-within:ring-brand-500">
          <span aria-hidden className="text-sm text-ink-faint">
            🔎
          </span>
          <input
            id="global-search"
            name="q"
            type="search"
            autoComplete="off"
            placeholder={placeholder}
            className="w-full bg-transparent text-sm text-ink placeholder:text-ink-faint focus:outline-none"
          />
        </div>
      </form>
    </div>
  );
}
