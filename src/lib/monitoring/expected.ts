/**
 * Errors that are the system working, not the system breaking.
 *
 * The error page earns its place by being short. A row on it is a claim that
 * something needs fixing, and the fastest way to make it worthless is to fill
 * it with events that were the designed outcome of a check. Two kinds of those
 * exist, and both were observed on the real console before this file:
 *
 *  1. **An authorisation refusal.** `requireAdmin()` throws, the layout turns
 *     that into a 404, and the response is exactly right — but the throw still
 *     reaches `onRequestError`. So a signed-out person opening a bookmarked
 *     `/admin` URL logged a fault, and anybody could have filled the page by
 *     requesting `/admin` in a loop. A refusal is not a fault; it is the
 *     refusal working.
 *  2. **An abandoned request.** Somebody closes the tab, or their signal
 *     drops mid-load, and the render fails because the stream it was writing
 *     to is gone. Nothing on our side is wrong and nothing on our side can be
 *     fixed. This showed up as `/help/contact :: Error: Connection closed.`
 *
 * **The cost, which is real.** A role bug that wrongly refuses a legitimate
 * administrator now produces no error report. That is accepted, because the
 * alternative is a page nobody reads, and because such a bug is loud in the
 * other direction: the person it locks out says so immediately. What is NOT
 * accepted is widening this: an error belongs here only when the response the
 * customer received was the correct one.
 *
 * Matching is by error NAME, not by `instanceof`. This module is reachable
 * from `instrumentation.ts`, which is compiled for the edge runtime too, and
 * importing the error classes would drag `next/headers` and Prisma along
 * behind them — the same trap the hand-written hash in `report.ts` documents.
 * The names are held to their classes by a test that constructs each one, so
 * a rename cannot quietly empty this list.
 */

/** Why an error was deliberately not written down. */
export type NotAFaultReason = 'EXPECTED_REFUSAL' | 'ABANDONED_REQUEST';

/**
 * Errors thrown by an access check when the answer is no.
 *
 * Every one of these has a matching `require…` function whose whole job is to
 * throw it, and a caller — a layout, an action — that turns it into a 404 or a
 * refusal message.
 */
export const EXPECTED_REFUSAL_NAMES: readonly string[] = [
  // Console.
  'AdminAccessRequiredError',
  // Signed out, or signed in but never finished onboarding. Middleware catches
  // the page case; a stale tab posting to a server action does not go through
  // middleware and lands here instead.
  'NotAuthenticatedError',
  'OnboardingIncompleteError',
  // Merchant back office: not their store, or not a high enough role in it.
  'NoStoreAccessError',
  'InsufficientStoreRoleError',
  // Rider screens, opened by somebody who has not been approved.
  'NotAFleetPartnerError',
];

const REFUSALS = new Set(EXPECTED_REFUSAL_NAMES);

/**
 * What a dropped connection looks like by the time it reaches the hook.
 *
 * Matched on the message, which is fragile, and that is the lesser evil: the
 * name is plain `Error`, so there is nothing else to key on. If React changes
 * the wording the noise comes back and somebody notices — whereas a loose
 * match here would silently swallow real faults, which is the failure mode
 * this file must not have.
 *
 * A `fetch` abort is deliberately NOT here. Our own outbound calls — the
 * geocoder, the SMS gateway — abort on a timeout, and that is a fault worth a
 * row.
 */
const ABANDONED_MESSAGES: readonly string[] = [
  // React, when the client goes away while the RSC stream is being written.
  'Connection closed.',
  'The user aborted a request.',
];

/** Next's own name for a response whose consumer has gone. */
const ABANDONED_NAMES: readonly string[] = ['ResponseAborted'];

/**
 * Whether this error is one of the two, or null if it is a genuine fault.
 *
 * Called with the RAW message, before redaction: these strings are fixed
 * framework text with nothing in them to redact, and classifying first means
 * a refusal costs nothing but a set lookup.
 */
export function notAFaultReason(input: {
  kind: string;
  message: string;
}): NotAFaultReason | null {
  if (REFUSALS.has(input.kind)) return 'EXPECTED_REFUSAL';
  if (ABANDONED_NAMES.includes(input.kind)) return 'ABANDONED_REQUEST';
  if (ABANDONED_MESSAGES.includes(input.message.trim())) return 'ABANDONED_REQUEST';
  return null;
}
