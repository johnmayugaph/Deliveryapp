/**
 * Counting things out loud.
 *
 * One function, and it exists because three screens had written
 * `${n} other device` and `Approved sa ${n} service` by hand — a row that
 * reads "3 other device" looks like a bug in the count rather than a bug in
 * the sentence, which is worse than it sounds on a control that revokes
 * sessions.
 *
 * Pure: imports nothing.
 */

/**
 * "1 service" / "2 services", with an irregular plural where English needs one.
 *
 * Takes the singular and derives the plural, rather than taking both, because
 * the overwhelmingly common case is an `s` and a call site that has to supply
 * both forms is a call site that will supply the same word twice.
 */
export function countOf(n: number, singular: string, plural?: string): string {
  return `${n} ${n === 1 ? singular : plural ?? `${singular}s`}`;
}
