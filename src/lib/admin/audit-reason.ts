/**
 * The one number both sides of the reason box need.
 *
 * It lives alone in a file with no imports because a CLIENT component has to
 * know it — to keep a button off until the reason is written — and everything
 * else in `admin/access.ts` reaches Prisma and the session cookie, which
 * cannot be bundled for a browser.
 *
 * Before this file, `ReasonForm` carried the number as a hardcoded `8`, which
 * is the drift this prevents: the form and the server rejecting at different
 * lengths reads to an operator as a form that refuses what it just accepted.
 */

/** The shortest reason that could mean something: "tkt 4821". */
export const MIN_AUDIT_REASON_LENGTH = 8;
