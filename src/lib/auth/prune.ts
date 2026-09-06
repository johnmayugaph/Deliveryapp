import { prisma } from '@/lib/prisma';

/**
 * Housekeeping for authentication tables.
 *
 * Deliberately in its own module, importing nothing but Prisma: the cron job
 * that calls these runs outside a request, and `session.ts` imports
 * `next/headers`, which only exists inside one. Keeping the prunes here means
 * the job never has to pull Next's request APIs into a plain node process.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Removes spent and expired login codes.
 *
 * A table of hashed codes and address fingerprints has no value once the codes
 * are dead, and is not something to accumulate indefinitely.
 */
export async function pruneVerifications(olderThan?: Date): Promise<number> {
  const cutoff = olderThan ?? new Date(Date.now() - DAY_MS);
  const { count } = await prisma.phoneVerification.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  return count;
}

/**
 * Removes expired sessions, and revoked ones once they are old enough that the
 * "signed in on" history no longer matters.
 */
export async function pruneSessions(): Promise<number> {
  const { count } = await prisma.session.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: new Date() } },
        { revokedAt: { lt: new Date(Date.now() - 30 * DAY_MS) } },
      ],
    },
  });
  return count;
}
