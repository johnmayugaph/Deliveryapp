import { Prisma } from '@prisma/client';

/**
 * Retrying a serialization conflict.
 *
 * Every place in this app that reads a total and then writes based on it runs
 * at `Serializable` — the credits ledger, the points ledger, order placement,
 * gift card redemption. That isolation level is what makes those totals
 * trustworthy, and the price of it is that Postgres will sometimes refuse a
 * transaction outright (SQLSTATE 40001, which Prisma reports as `P2034`)
 * rather than let two of them interleave into a wrong answer.
 *
 * **A refused transaction is not an error to report. It is an instruction to
 * try again.** That distinction is easy to get wrong and expensive when it is:
 * the promo work found four concurrent order placements producing three
 * `P2034` failures and one order, with three customers reading "that did not
 * go through" while the campaign was nowhere near its cap. The contention was
 * correct — it is what made the cap exact — and the missing piece was this.
 *
 * Extracted here because there are now two callers with the same need and the
 * same reasoning, and a retry policy that exists twice will eventually be two
 * different policies.
 *
 * ### What this deliberately does NOT do
 *
 * It does not wrap `prisma.$transaction` for you. A caller decides what one
 * attempt is, because that boundary is a judgement: order placement re-runs
 * its whole quote on each attempt, so a retry prices the order against fresh
 * state rather than replaying a stale one. A helper that only wrapped the
 * transaction body would have quietly made that impossible.
 */

/**
 * How many times an attempt may be made in total, including the first.
 *
 * Four. Enough to absorb the contention a popular promo code or a shared gift
 * card actually produces, and few enough that a genuinely deadlocked
 * situation surfaces in about a second rather than being retried into a
 * timeout.
 */
export const MAX_ATTEMPTS = 4;

/** Whether an error is Postgres saying "try that again", not "that was wrong". */
export function isSerializationConflict(error: unknown): boolean {
  // P2034 is Prisma's code for "write conflict or deadlock, please retry",
  // which is how Postgres's 40001 and 40P01 both arrive.
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
}

/**
 * A short, growing, jittered pause between attempts.
 *
 * The jitter matters more than the delay. Four clients that back off by the
 * same amount collide again together, so a fixed sleep turns one conflict into
 * a synchronised stampede; randomising within the window spreads them out.
 */
export async function pauseBeforeRetry(attempt: number): Promise<void> {
  const base = 15 * 2 ** (attempt - 1);
  const delay = base + Math.floor(Math.random() * base);
  await new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Runs `attempt` until it succeeds or stops being a serialization conflict.
 *
 * Only `P2034` is retried. Every other failure is passed straight through,
 * because everything else this app throws is a DECISION — a gift card already
 * redeemed, a code that ran out, credits that fall short — and retrying a
 * decision makes the same refusal slower. Worse, for anything that consumes a
 * single-use token, a retry that succeeded on the second pass would be the
 * app doing the thing it had just refused.
 *
 * A conflict that survives every attempt is rethrown unchanged and NOT wrapped
 * in a friendly domain error: past four attempts this is not ordinary
 * contention, and somebody should see it in error monitoring.
 */
export async function withSerializationRetry<T>(
  attempt: () => Promise<T>,
): Promise<T> {
  let lastConflict: unknown;

  for (let attemptNumber = 1; attemptNumber <= MAX_ATTEMPTS; attemptNumber += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (!isSerializationConflict(error)) throw error;
      lastConflict = error;
      if (attemptNumber < MAX_ATTEMPTS) await pauseBeforeRetry(attemptNumber);
    }
  }

  throw lastConflict;
}
