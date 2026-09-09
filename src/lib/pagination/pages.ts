/**
 * Walking backwards through a customer's own history.
 *
 * Two screens stopped at fifty rows with nothing said about it and no way to
 * see the rest: `/orders`, which is every order the customer has ever placed,
 * and `/credits`, which is the ledger their balance is derived from. A regular
 * customer passes fifty of either inside a year, at which point their own
 * history silently becomes unreachable — and on the credits screen, the rows
 * that explain the number at the top of the page are the ones that disappear.
 *
 * The shape is deliberately the smallest one that is correct:
 *
 *   - **Forward only.** One link, "Older". Going back is the browser's Back
 *     button, which already works because each page is its own URL. A
 *     numbered pager would need a count query on every view and would
 *     renumber itself the moment a new row arrived.
 *
 *   - **Keyset, not offset.** The cursor is the id of the last row shown.
 *     `?skip=50` duplicates rows on page two whenever something new lands at
 *     the top, which on an orders list is exactly what happens.
 *
 *   - **No total.** A count on every page view, to print a number nobody
 *     asked for. The defect was that the history could not be reached, not
 *     that its size was unstated.
 *
 * An id is safe as a cursor here because neither table is ever deleted from:
 * `Order` has no delete path in the application, and `WalletTransaction` is
 * append-only and enforced by a trigger. So a cursor cannot rot into a row
 * that no longer exists. A cursor that never existed — typed, or truncated in
 * a chat message — is handled instead by `pageOf` reporting a `strandedPage`,
 * because an empty list is otherwise indistinguishable from "you have no
 * history", which is the same falsehood the six session-gone screens told.
 *
 * Pure: imports nothing.
 */

/**
 * Rows per page.
 *
 * Fifty, which is what both screens already fetched. Changing the size would
 * change what an existing customer sees on their first screenful, and that is
 * a product decision rather than part of fixing an unreachable list.
 */
export const PAGE_SIZE = 50;

/**
 * How many rows to actually fetch: one more than the page.
 *
 * The extra row is the whole mechanism for knowing whether an "Older" link
 * belongs on the page, and it costs one row rather than a second `count`
 * query. It is never rendered.
 */
export function fetchCount(pageSize: number = PAGE_SIZE): number {
  return pageSize + 1;
}

export interface Page<T> {
  /** At most `pageSize` rows. The sentinel row is dropped. */
  rows: T[];
  /**
   * The id to pass as `before` for the next page, or null when this is the
   * last one. Derived from the last row SHOWN, not the sentinel.
   */
  olderCursor: string | null;
  /**
   * True when a cursor was supplied and nothing came back — a page that has
   * been navigated past the end of the history, or a cursor that was never
   * real. The screen must say so rather than render its empty state, which
   * claims the customer has no history at all.
   */
  strandedPage: boolean;
}

/**
 * Splits a `fetchCount()`-sized read into the page and the answer to "is there
 * more".
 */
export function pageOf<T extends { id: string }>(
  fetched: readonly T[],
  cursor: string | null,
  pageSize: number = PAGE_SIZE,
): Page<T> {
  const rows = fetched.slice(0, pageSize);
  const hasMore = fetched.length > pageSize;
  return {
    rows,
    olderCursor: hasMore ? (rows[rows.length - 1]?.id ?? null) : null,
    strandedPage: cursor !== null && rows.length === 0,
  };
}

/** The query parameter, in one place so the reader and the writer agree. */
export const CURSOR_PARAM = 'before';

/**
 * Reads a cursor out of Next's `searchParams`.
 *
 * A repeated parameter (`?before=a&before=b`) arrives as an array; taking the
 * first is arbitrary but defensible, and the alternative — treating it as no
 * cursor — would silently send somebody back to the top of a list they were
 * halfway down. Anything that is not a plausible id is refused, so a crafted
 * value reaches no query.
 */
export function readCursor(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  // cuid/uuid shaped, and nothing else. Length-bounded so a megabyte of
  // query string is not handed to the database.
  return /^[A-Za-z0-9_-]{1,64}$/.test(trimmed) ? trimmed : null;
}

/** The link to the next page back. */
export function olderHref(basePath: string, cursor: string): string {
  return `${basePath}?${CURSOR_PARAM}=${encodeURIComponent(cursor)}`;
}

/** The link back to the top of the list. */
export function newestHref(basePath: string): string {
  return basePath;
}
