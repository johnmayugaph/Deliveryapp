import Link from 'next/link';
import { newestHref, olderHref } from '@/lib/pagination/pages';

/**
 * "Older" and "Back to newest", for a history a customer walks backwards.
 *
 * Plain links, so this works with JavaScript switched off and before the page
 * hydrates — the same reason the login form posts natively. A button that
 * fetched the next page would be nicer on a good connection and would be the
 * only way to reach an old order on a bad one.
 *
 * Renders nothing at all when there is one page and the customer is on it:
 * a disabled control that is always disabled tells them something about this
 * screen rather than about their history.
 */
export function OlderPager({
  basePath,
  olderCursor,
  onFirstPage,
  label,
}: {
  basePath: string;
  olderCursor: string | null;
  /** False once the customer has followed at least one "Older" link. */
  onFirstPage: boolean;
  /** What the rows are, for the link's accessible name. */
  label: string;
}) {
  if (olderCursor === null && onFirstPage) return null;

  return (
    <nav
      aria-label={`More ${label}`}
      className="flex items-center justify-between gap-3 px-4 py-4"
    >
      {onFirstPage ? (
        <span />
      ) : (
        <Link
          href={newestHref(basePath)}
          className="rounded-lg px-3 py-2 text-xs font-semibold text-brand-700 hover:bg-brand-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
        >
          ← Newest
        </Link>
      )}
      {olderCursor === null ? (
        /* The end, said plainly. Without it, a last page that happens to be
           full looks identical to one with more behind it. */
        <span className="px-3 py-2 text-xs text-ink-faint">
          That&rsquo;s everything
        </span>
      ) : (
        <Link
          href={olderHref(basePath, olderCursor)}
          className="rounded-lg bg-surface px-3 py-2 text-xs font-semibold text-brand-700 shadow-sm ring-1 ring-black/5 hover:bg-brand-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
        >
          Older {label} →
        </Link>
      )}
    </nav>
  );
}

/**
 * What a page shows when its cursor points past the end of the history.
 *
 * Separate from the empty state on purpose. "No orders yet" is a claim about
 * the customer; this is a claim about the link they followed.
 */
export function StrandedPage({
  basePath,
  label,
}: {
  basePath: string;
  label: string;
}) {
  return (
    <div className="mx-4 mt-4 rounded-xl bg-surface px-4 py-6 text-center shadow-sm ring-1 ring-black/5">
      <p className="text-sm font-semibold">Nothing on this page.</p>
      <p className="mt-1 text-xs leading-relaxed text-ink-muted">
        This link points past the end of your {label}.
      </p>
      <Link
        href={newestHref(basePath)}
        className="mt-3 inline-block rounded-lg bg-brand-600 px-3 py-2 text-xs font-semibold text-white hover:bg-brand-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
      >
        Start from the newest
      </Link>
    </div>
  );
}
