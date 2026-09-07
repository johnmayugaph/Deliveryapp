import { ErrorSource } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  normaliseRoute,
  redactMessage,
  redactStack,
} from '@/lib/monitoring/redact';

/**
 * Writing down what broke.
 *
 * The whole feature exists to close one gap: before this, a page that started
 * failing was discovered when a customer said so, and most customers do not
 * say so — they leave. Nothing here makes anything more reliable. It makes
 * failure *visible*, which is the prerequisite for everything else.
 *
 * Three rules, and they are the only reason this is a module rather than a
 * `prisma.errorReport.create` at each call site.
 *
 *  1. **It never throws.** Every entry point wraps its own body. A monitoring
 *     call that can fail turns one broken page into two, and the second one
 *     happens inside the handler for the first.
 *  2. **It never recurses.** If writing a report fails, the failure goes to
 *     the console and stops there. Reporting the reporter is an infinite loop
 *     with a database connection attached.
 *  3. **It is grouped, not appended.** One row per distinct fault, with a
 *     counter. A loop cannot fill the disk, and the console shows a shape
 *     somebody can act on rather than four hundred identical lines.
 *
 * Deliberately NOT a third-party service. Sentry is the obvious alternative
 * and a good product; what it also is, for this application, is a US processor
 * receiving Philippine phone numbers, home addresses and order contents inside
 * error payloads — before this business has a privacy policy or a named data
 * protection officer, both of which are still open items. It would also do
 * nothing at all until somebody creates an account and sets a DSN, which is
 * the same "configured later, so unprotected today" shape as the SMS gateway.
 * This works on the first deploy, keeps the data in the same database as the
 * rest of it, and sits behind a narrow enough seam that forwarding to Sentry
 * later is another file rather than a rewrite.
 */

export interface ErrorContext {
  source: ErrorSource;
  /** A path, or the name of the thing that was running. */
  route?: string | null | undefined;
  /** Next.js's own digest, the only link from a customer's 500 to this row. */
  digest?: string | null | undefined;
  userId?: string | null | undefined;
  now?: Date;
}

/** What a caller can learn, when a caller cares. Never used for control flow. */
export interface ReportOutcome {
  recorded: boolean;
  /** True the first time this fault has ever been seen. */
  isNew: boolean;
  fingerprint: string;
}

const NOT_RECORDED: ReportOutcome = {
  recorded: false,
  isNew: false,
  fingerprint: '',
};

/** The constructor name, or something honest when there is not one. */
function kindOf(error: unknown): string {
  if (error instanceof Error) {
    return error.name || error.constructor?.name || 'Error';
  }
  // `throw 'oops'` and `throw {code: 1}` are both legal and both happen,
  // usually from a library. Naming the type is more use than calling it an
  // Error when it is not one.
  if (error === null) return 'NullThrown';
  if (error === undefined) return 'UndefinedThrown';
  if (typeof error === 'object') return 'ObjectThrown';
  return `${typeof error}Thrown`;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

function stackOf(error: unknown): string | undefined {
  return error instanceof Error && typeof error.stack === 'string'
    ? error.stack
    : undefined;
}

/**
 * The first frame of the stack that belongs to our own code.
 *
 * Framework frames are skipped: an error thrown inside React's renderer has
 * the same top frame whatever caused it, so grouping on it would collapse
 * every unrelated fault into one row. `node_modules` and `.next` are the two
 * that matter in practice.
 */
export function topOwnFrame(stack: string | undefined): string {
  if (!stack) return '';
  for (const line of stack.split('\n').slice(1)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.includes('node_modules')) continue;
    if (trimmed.includes('/.next/')) continue;
    if (trimmed.startsWith('at node:')) continue;
    return trimmed.slice(0, 300);
  }
  return '';
}

/**
 * FNV-1a, one 32-bit lane.
 *
 * Written out rather than imported from `node:crypto`, and that is not a
 * preference. `instrumentation.ts` — the file that catches server errors — is
 * compiled for the edge runtime as well as for Node, so everything it reaches
 * has to build in both. A `node:crypto` import fails the production build
 * outright with "Reading from node:crypto is not handled by plugins", and in
 * development it fails quietly: the instrumentation module never compiles, so
 * the hook is never registered and errors vanish with no sign that monitoring
 * is switched off. That is the worst possible failure for this feature.
 *
 * A non-cryptographic hash is also the right tool on the merits. This is a
 * GROUPING KEY, not a security primitive: nothing is authenticated by it and
 * nobody gains anything by colliding with one. The cost of a collision is that
 * two rare faults share a row, which is cosmetic — the cost of a Node-only
 * dependency is silent blindness.
 *
 * Both bytes of each code unit are folded in so that two different non-ASCII
 * messages cannot collide on their low bytes alone.
 */
function fnv1a32(text: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    hash = Math.imul(hash ^ (code & 0xff), 0x01000193) >>> 0;
    hash = Math.imul(hash ^ (code >>> 8), 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * What makes two occurrences the same fault.
 *
 * Kind, plus the message with its variable parts already redacted away, plus
 * the first frame of our own code. Redaction earns its place twice over here:
 * `Invalid phone +639171234567` and `Invalid phone +639189876543` are one
 * fault, and they only group together because both became `Invalid phone
 * [phone]` before being hashed.
 *
 * The route is deliberately NOT part of it. The same bug on four pages is one
 * bug, and splitting it four ways is how a console stops being readable.
 *
 * Four independently seeded lanes, 128 bits in total, rendered as 32 hex
 * characters — wide enough that an accidental collision across a realistic
 * number of distinct faults is not worth thinking about.
 */
export function fingerprintOf(input: {
  kind: string;
  redactedMessage: string;
  topFrame: string;
}): string {
  const subject = `${input.kind}\n${input.redactedMessage}\n${input.topFrame}`;
  // Distinct FNV offset bases, so the lanes are not correlated.
  const seeds = [0x811c9dc5, 0x01234567, 0x9e3779b9, 0x85ebca6b];
  return seeds
    .map((seed) => fnv1a32(subject, seed).toString(16).padStart(8, '0'))
    .join('');
}

/**
 * Records one error. Returns quietly on failure — see rule 1.
 *
 * The upsert is the whole implementation: a new fault inserts, a repeat
 * increments. `isNew` is read from the occurrence count that comes back rather
 * than from a prior lookup, so two simultaneous first occurrences cannot both
 * announce themselves as new.
 */
export async function reportError(
  error: unknown,
  context: ErrorContext,
): Promise<ReportOutcome> {
  try {
    const now = context.now ?? new Date();
    const kind = kindOf(error).slice(0, 120);
    const stack = stackOf(error);
    const redactedMessage = redactMessage(messageOf(error));
    const topFrame = topOwnFrame(stack);
    const fingerprint = fingerprintOf({ kind, redactedMessage, topFrame });
    const route = normaliseRoute(context.route);

    const saved = await prisma.errorReport.upsert({
      where: { fingerprint },
      create: {
        fingerprint,
        kind,
        message: redactedMessage,
        stack: redactStack(stack),
        source: context.source,
        route,
        digest: context.digest ?? null,
        userId: context.userId ?? null,
        firstSeenAt: now,
        lastSeenAt: now,
      },
      update: {
        occurrences: { increment: 1 },
        lastSeenAt: now,
        // A fault that comes back after being marked fixed is not fixed. The
        // console shows it as open again rather than quietly counting up a
        // resolved row nobody is looking at.
        resolvedAt: null,
        resolvedByUserId: null,
      },
      select: { occurrences: true },
    });

    return { recorded: true, isNew: saved.occurrences === 1, fingerprint };
  } catch (reportingFailure) {
    // Rule 2. The console is the end of the line: no retry, no second report,
    // no throw. Losing an error report is bad; losing the request that was
    // being served, or looping, is worse.
    console.error('reportError: could not record an error', reportingFailure);
    console.error('reportError: the original error was', error);
    return NOT_RECORDED;
  }
}

export { ErrorSource };
