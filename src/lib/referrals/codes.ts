import { randomBytes } from 'node:crypto';
import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import {
  CODE_LENGTH,
  codeFromBytes,
  codeLooksValid,
  normaliseCode,
} from '@/lib/referrals/policy';

/**
 * Minting and resolving invite codes.
 *
 * Codes are minted LAZILY — the first time somebody opens the invite screen —
 * rather than at signup. Most accounts will never share one, and a column full
 * of unused codes only makes collisions likelier for no benefit.
 */

/** Tried a few times before giving up, so a collision is not a dead end. */
const MINT_ATTEMPTS = 8;

export class CouldNotMintCodeError extends Error {
  constructor() {
    super(
      'Could not mint an unused invite code after several tries. This means the ' +
        'code space is crowded, which at six characters means something is wrong ' +
        'rather than unlucky.',
    );
    this.name = 'CouldNotMintCodeError';
  }
}

/**
 * This account's code, minting one if it has none.
 *
 * The uniqueness is the database's (`User.referralCode @unique`), not this
 * function's: two people opening the invite screen in the same second would
 * otherwise both check, both find nothing, and both write. So a collision is
 * caught from the write and retried rather than prevented by a read.
 */
export async function ensureReferralCode(userId: string): Promise<string> {
  const existing = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { referralCode: true },
  });
  if (existing.referralCode) return existing.referralCode;

  for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt += 1) {
    // Generous byte count: rejection sampling discards a slice of the range,
    // so asking for exactly CODE_LENGTH bytes would sometimes come back short.
    const candidate = codeFromBytes(randomBytes(CODE_LENGTH * 3));
    if (candidate.length !== CODE_LENGTH) continue;
    try {
      const updated = await prisma.user.update({
        where: { id: userId },
        data: { referralCode: candidate },
        select: { referralCode: true },
      });
      return updated.referralCode ?? candidate;
    } catch {
      // Unique violation: somebody else has this code. Try another.
      //
      // Also reached if this user gained a code concurrently, so re-read
      // before assuming the worst — otherwise two tabs racing would burn all
      // eight attempts and then throw at somebody who now has a code.
      const now = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { referralCode: true },
      });
      if (now.referralCode) return now.referralCode;
    }
  }
  throw new CouldNotMintCodeError();
}

/**
 * The account a code belongs to, or null.
 *
 * Normalises first, so a pasted link or a code with spaces in it resolves. A
 * code that is not the right shape after normalising is not looked up at all —
 * that is a typo, and a database round trip cannot fix a typo.
 */
export async function findReferrerByCode(
  raw: string,
  client?: PrismaTransactionClient,
): Promise<{ id: string; isBlocked: boolean; displayName: string | null } | null> {
  const code = normaliseCode(raw);
  if (!codeLooksValid(code)) return null;

  const db = client ?? prisma;
  return db.user.findUnique({
    where: { referralCode: code },
    select: { id: true, isBlocked: true, displayName: true },
  });
}
