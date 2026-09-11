import Link from 'next/link';
import {
  FAST_PREP_MINUTES,
  type ServicePageFilters,
  type StoreSort,
} from '@/lib/services/service-page-data';

/**
 * The sort and filter chips above a shop list.
 *
 * ANCHOR LINKS, not a client component. Every chip is a URL, so the state
 * survives a share, a back button and a reload, works before JavaScript
 * arrives, and is read on the server by the same query that builds the list —
 * which is what keeps the chips and the results from ever disagreeing.
 *
 * WHAT IS NOT HERE, and why: the reference this follows has a "Under ₱35.00"
 * delivery-fee chip. Our delivery fee is one rule per city and vertical, so
 * every shop on this list charges the same fee — a fee filter would match all
 * of them or none of them, which is a control that looks like it works and
 * does nothing. It belongs here the day fees vary by distance.
 *
 * Sticky, because the point of a filter is changing your mind once you have
 * scrolled and seen what the list holds.
 */
const SORTS: { value: StoreSort; label: string }[] = [
  { value: 'recommended', label: 'Recommended' },
  { value: 'rating', label: 'Top rated' },
  { value: 'fastest', label: 'Fastest' },
];

export function StoreFilters({
  filters,
  hrefFor,
}: {
  filters: ServicePageFilters;
  /** Link for a filter set — the page owns how a query string is built. */
  hrefFor: (next: ServicePageFilters) => string;
}) {
  return (
    <div className="sticky top-0 z-20 border-b border-ink/[0.06] bg-surface/95 backdrop-blur">
      <ul
        className="flex gap-2 overflow-x-auto px-4 py-2.5"
        style={{ scrollbarWidth: 'none' }}
      >
        {SORTS.map((sort) => (
          <li key={sort.value} className="shrink-0">
            <Chip
              href={hrefFor({ ...filters, sort: sort.value })}
              active={filters.sort === sort.value}
              label={sort.label}
            />
          </li>
        ))}

        {/* A thin rule between "how it is ordered" and "what is in it". Two
            kinds of control in one scrolling row otherwise read as one long
            list of things that might all be exclusive. */}
        <li aria-hidden className="w-px shrink-0 self-stretch bg-ink/[0.08]" />

        <li className="shrink-0">
          <Chip
            href={hrefFor({ ...filters, openNow: !filters.openNow })}
            active={filters.openNow}
            label="Open now"
          />
        </li>
        <li className="shrink-0">
          <Chip
            href={hrefFor({ ...filters, fast: !filters.fast })}
            active={filters.fast}
            label={`Under ${FAST_PREP_MINUTES} mins`}
          />
        </li>
        <li className="shrink-0">
          <Chip
            href={hrefFor({ ...filters, deals: !filters.deals })}
            active={filters.deals}
            label="Has a deal"
          />
        </li>
      </ul>
    </div>
  );
}

function Chip({
  href,
  active,
  label,
}: {
  href: string;
  active: boolean;
  label: string;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'true' : undefined}
      className={`press block whitespace-nowrap rounded-full px-3.5 py-1.5 text-[13px] font-bold ${
        active
          ? 'bg-brand-600 text-white'
          : 'bg-surface-sunken text-ink-muted hover:text-ink'
      }`}
    >
      {label}
    </Link>
  );
}
