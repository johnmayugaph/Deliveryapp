import Link from 'next/link';
import { getCurrentCityId } from '@/lib/auth/session';
import { globalSearch } from '@/lib/search/global-search';
import { getService } from '@/lib/services/registry';
import { serviceGlyph } from '@/lib/services/presentation';

export const dynamic = 'force-dynamic';

/**
 * Cross-service search results. Searches every active service; a vertical that
 * has not launched has nothing to find, and we would rather return nothing than
 * a result we cannot fulfil.
 */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const query = q?.trim() ?? '';
  const cityId = await getCurrentCityId();

  const results = query.length >= 2 ? await globalSearch({ query, cityId }) : [];

  const resultsWithService = await Promise.all(
    results.map(async (result) => ({
      result,
      service: await getService(result.serviceType),
    })),
  );

  return (
    <main>
      <header className="bg-surface px-4 pb-4 pt-5">
        <form action="/search" method="get" role="search">
          <label htmlFor="search-input" className="sr-only">
            Search across services
          </label>
          <div className="flex items-center gap-2 rounded-xl bg-surface-sunken px-3 py-2.5 ring-1 ring-black/5 focus-within:ring-2 focus-within:ring-brand-500">
            <span aria-hidden className="text-sm text-ink-faint">
              🔎
            </span>
            <input
              id="search-input"
              name="q"
              type="search"
              defaultValue={query}
              autoComplete="off"
              className="w-full bg-transparent text-sm text-ink placeholder:text-ink-faint focus:outline-none"
              placeholder="Search"
            />
          </div>
        </form>
      </header>

      {query.length < 2 ? (
        <p className="px-4 py-8 text-sm text-ink-muted">
          Type at least two letters to search.
        </p>
      ) : resultsWithService.length === 0 ? (
        <p className="px-4 py-8 text-sm text-ink-muted">
          Nothing found for &ldquo;{query}&rdquo;.
        </p>
      ) : (
        <ul className="divide-y divide-black/5">
          {resultsWithService.map(({ result, service }, index) => (
            <li key={`${result.href}-${index}`}>
              <Link
                href={result.href}
                className="flex items-center gap-3 bg-surface px-4 py-3 transition-colors hover:bg-brand-50/40"
              >
                <span aria-hidden className="text-lg leading-none">
                  {serviceGlyph(service.icon)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">
                    {result.title}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-ink-muted">
                    {service.displayName} · {result.subtitle}
                  </span>
                </span>
                <span aria-hidden className="text-xs text-ink-faint">
                  ›
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
