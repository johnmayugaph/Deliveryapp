/**
 * Taking the secrets out of an error before it is written down.
 *
 * This exists because of what actually ends up in a message. A gateway
 * rejection carries the request body, which carries the login code. A Prisma
 * error quotes the row it failed on, which carries a phone number and a home
 * address. A fetch failure prints the URL, which carries an API key in a query
 * string. Every one of those is a real message this application can produce,
 * and an error log that captures the code it failed to deliver is worse than
 * no error log: it turns a monitoring table into the softest target in the
 * database.
 *
 * The rules are deliberately blunt. A redactor that tries to be clever about
 * what is safe will be wrong on the message nobody predicted, and the cost of
 * over-redacting is a slightly less specific stack trace — which is nothing
 * next to the cost of the alternative.
 *
 * Pure, and exported, so every rule can be tested against the string that
 * motivated it.
 */

export const REDACTED = '[redacted]';

interface Rule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replace: (match: string, ...groups: string[]) => string;
}

/**
 * Ordered, and the order matters: the keyed rules run first so that
 * `secret=0917...` is redacted as a secret rather than reformatted as a phone
 * number and left half visible.
 */
const RULES: readonly Rule[] = [
  {
    // `apikey=abc`, `secret: "abc"`, `token=abc`, `password=abc`, in a URL, a
    // JSON fragment or a form body. The key name is kept — knowing WHICH
    // secret was involved is useful and reveals nothing.
    name: 'keyed secret',
    pattern:
      /\b(api[-_]?key|apikey|secret|token|password|passwd|pwd|authorization|auth|bearer|code|otp|dsn)\b(\s*[=:]\s*|\s+)("?)([^\s"'&,;)}\]]+)\3/gi,
    replace: (_match, key, separator, quote) =>
      `${key}${separator}${quote}${REDACTED}${quote}`,
  },
  {
    // A Philippine mobile number in any of the forms this app accepts. Kept
    // recognisable as a phone number, because "a phone number was in this
    // message" is often the clue, and the digits never are.
    name: 'philippine mobile',
    pattern: /(?:\+?63|0)9\d{2}[\s-]?\d{3}[\s-]?\d{4}\b/g,
    replace: () => '[phone]',
  },
  {
    name: 'email address',
    pattern: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g,
    replace: () => '[email]',
  },
  {
    // A session token, a code hash, a VAPID key: 32 hex characters or more.
    // Short hex strings are left alone — a CSS colour and a 12-character
    // Prisma id are not secrets and blanking them makes stacks unreadable.
    name: 'long hex',
    pattern: /\b[0-9a-f]{32,}\b/gi,
    replace: () => REDACTED,
  },
  {
    // A JWT or a Turnstile token: three or more dot-separated base64 chunks.
    name: 'token-shaped string',
    pattern: /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replace: () => REDACTED,
  },
  {
    // A connection string, with or without credentials.
    name: 'connection string',
    pattern: /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/\S+/gi,
    replace: (_match, scheme) => `${scheme}://${REDACTED}`,
  },
  {
    // A bare six-digit run, which is the shape of every login code this app
    // issues. Over-broad on purpose: it also catches an order total in
    // centavos, and losing that from a stack trace costs nothing.
    name: 'six digits alone',
    pattern: /(?<![\w.])\d{6}(?![\w.])/g,
    replace: () => '[6-digit]',
  },
];

/** How much of a message is worth keeping. Long enough to read, short
 *  enough that a stack pasted into a message cannot fill the column. */
const MAX_MESSAGE = 1_000;
/** Deep enough to find the cause, shallow enough not to store a novel. */
const MAX_STACK = 8_000;

/** Applies every rule, in order. Never throws; returns '' for nothing. */
export function redact(text: string | undefined | null): string {
  if (!text) return '';
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, rule.replace as never);
  }
  return out;
}

export function redactMessage(text: string | undefined | null): string {
  const redacted = redact(text).trim();
  if (redacted.length === 0) return 'An error with no message';
  return redacted.length > MAX_MESSAGE
    ? `${redacted.slice(0, MAX_MESSAGE)}… (truncated)`
    : redacted;
}

export function redactStack(stack: string | undefined | null): string | null {
  const redacted = redact(stack).trim();
  if (redacted.length === 0) return null;
  return redacted.length > MAX_STACK
    ? `${redacted.slice(0, MAX_STACK)}\n… (truncated)`
    : redacted;
}

/**
 * A path with no query string and no ids.
 *
 * Two jobs at once. The query string goes because it carries tokens and a
 * `next=` parameter, and because two requests differing only by it are the
 * same fault. The ids go so that `/orders/abc123` and `/orders/def456` group
 * together — otherwise one broken page reads as a thousand distinct errors,
 * which is precisely the failure this table is grouped to avoid.
 */
export function normaliseRoute(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const withoutQuery = raw.split('?')[0]?.split('#')[0] ?? '';
  if (withoutQuery.length === 0) return null;

  const segments = withoutQuery.split('/').map((segment) => {
    if (segment.length === 0) return segment;
    // A cuid, a uuid, a long opaque id, an order number, or anything mostly
    // digits: all identifiers rather than route shape.
    if (/^c[a-z0-9]{20,}$/i.test(segment)) return ':id';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) {
      return ':id';
    }
    if (/^\d+$/.test(segment)) return ':id';
    if (/^[A-Z]{2,}-?\d{4,}$/.test(segment)) return ':id';
    return segment;
  });

  const path = segments.join('/');
  return path.length > 200 ? path.slice(0, 200) : path;
}
