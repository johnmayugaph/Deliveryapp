import {
  LoyaltyEntryType,
  Prisma,
  type LoyaltyEntry,
} from '@prisma/client';
import { prisma, type PrismaTransactionClient } from '@/lib/prisma';

/**
 * THE ONLY function in this codebase that changes a points balance.
 *
 * Deliberately a near-copy of `recordWalletTransaction`, and the duplication is
 * the point: the two ledgers hold different units and must not share a write
 * path, but they must share a discipline. Write a row, recompute the balance
 * from the sum of the rows, write that derived value back, at SERIALIZABLE so
 * two concurrent writes cannot both read a stale sum.
 *
 * That last part is not theoretical here. Redemption is the only place in this
 * app where a CUSTOMER causes credits to come into existence — referrals need
 * somebody else to sign up and order, a promo needs an administrator, and this
 * needs one tap. Two taps racing at a balance of 500 must not both succeed.
 */

export class InvalidLoyaltyEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidLoyaltyEntryError';
  }
}

export class InsufficientPointsError extends Error {
  constructor(
    readonly availablePoints: number,
    readonly requestedPoints: number,
  ) {
    super(
      `Not enough points: ${availablePoints} available, ${requestedPoints} requested.`,
    );
    this.name = 'InsufficientPointsError';
  }
}

/** Types whose magnitude is stored negative. Mirrors the SQL sign guard. */
const DEBIT_TYPES: readonly LoyaltyEntryType[] = [
  LoyaltyEntryType.REDEEMED,
  LoyaltyEntryType.EXPIRED,
];

/**
 * Derives the signed value from the type, so no caller can pass the wrong sign.
 *
 * ADJUSTED is the one signed type — a correction can go either way — and it
 * therefore takes its input verbatim. Everything else takes a magnitude and
 * has its direction decided here, which is what makes "spending points added
 * to a balance" unrepresentable rather than merely unlikely.
 */
export function signedPointsFor(type: LoyaltyEntryType, magnitude: number): number {
  if (!Number.isInteger(magnitude)) {
    throw new InvalidLoyaltyEntryError(
      `Points must be whole: got ${magnitude}. A fraction of a point is not a thing.`,
    );
  }
  if (type === LoyaltyEntryType.ADJUSTED) {
    if (magnitude === 0) {
      throw new InvalidLoyaltyEntryError('An adjustment of zero points changes nothing');
    }
    return magnitude;
  }
  if (magnitude <= 0) {
    throw new InvalidLoyaltyEntryError(
      `${type} takes a positive magnitude; the sign is derived from the type`,
    );
  }
  return DEBIT_TYPES.includes(type) ? -magnitude : magnitude;
}

export interface RecordEntryInput {
  accountId: string;
  type: LoyaltyEntryType;
  /** Magnitude, always positive — except ADJUSTED, which may be negative. */
  points: number;
  description: string;
  /** Required for EARNED: points come from orders. */
  relatedOrderId?: string;
  /** Required for REDEEMED: the credits row this became. */
  walletTransactionId?: string;
  /** Required for ADJUSTED. */
  adminUserId?: string;
  /** Makes earning idempotent, so a retried completion earns once. */
  idempotencyKey?: string;
  expiresAt?: Date | null;
}

export interface LoyaltyResult {
  entry: LoyaltyEntry;
  pointsBalance: number;
  /**
   * True when the idempotency key matched an existing row and nothing was
   * written.
   *
   * Reported rather than inferred. The caller's first version guessed at it by
   * comparing the row's `createdAt` against the clock, which is wrong under
   * clock skew, inside a long transaction, or on a replay that happens to land
   * in the same second — and wrong in the direction that double-counts.
   */
  replayed: boolean;
}

export async function recordLoyaltyEntry(
  input: RecordEntryInput,
  client?: PrismaTransactionClient,
): Promise<LoyaltyResult> {
  const run = async (tx: PrismaTransactionClient): Promise<LoyaltyResult> => {
    if (!input.description.trim()) {
      throw new InvalidLoyaltyEntryError(
        'Every ledger row needs a description — it is what the customer reads in their history',
      );
    }
    if (input.type === LoyaltyEntryType.EARNED && !input.relatedOrderId) {
      throw new InvalidLoyaltyEntryError(
        'EARNED requires a relatedOrderId: points with no order behind them are points from nowhere',
      );
    }
    if (input.type === LoyaltyEntryType.REDEEMED && !input.walletTransactionId) {
      throw new InvalidLoyaltyEntryError(
        'REDEEMED requires the credits transaction it produced — points become money only through the credits ledger',
      );
    }
    if (input.type === LoyaltyEntryType.ADJUSTED && !input.adminUserId) {
      throw new InvalidLoyaltyEntryError(
        'An ADJUSTED row requires an adminUserId — untraceable corrections are how ledgers rot',
      );
    }
    if (input.type !== LoyaltyEntryType.EARNED && input.expiresAt) {
      throw new InvalidLoyaltyEntryError(
        'Only earned points expire; an expiry on anything else would be double-counted by the sweep',
      );
    }

    // Idempotent replay: return the existing row rather than double-writing.
    if (input.idempotencyKey) {
      const existing = await tx.loyaltyEntry.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (existing) {
        const account = await tx.loyaltyAccount.findUniqueOrThrow({
          where: { id: existing.accountId },
          select: { pointsBalance: true },
        });
        return {
          entry: existing,
          pointsBalance: account.pointsBalance,
          replayed: true,
        };
      }
    }

    const account = await tx.loyaltyAccount.findUnique({
      where: { id: input.accountId },
    });
    if (!account) {
      throw new InvalidLoyaltyEntryError(
        `No loyalty account with id "${input.accountId}"`,
      );
    }

    const signedPoints = signedPointsFor(input.type, input.points);

    // The LEDGER decides what is available, not the cached column. Read inside
    // the transaction, which is what makes two racing redemptions safe.
    const priorBalance = await sumLedger(tx, account.id);
    const nextBalance = priorBalance + signedPoints;

    if (nextBalance < 0) {
      throw new InsufficientPointsError(priorBalance, Math.abs(signedPoints));
    }

    const entry = await tx.loyaltyEntry.create({
      data: {
        accountId: account.id,
        type: input.type,
        points: signedPoints,
        description: input.description.trim(),
        relatedOrderId: input.relatedOrderId ?? null,
        walletTransactionId: input.walletTransactionId ?? null,
        adminUserId: input.adminUserId ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        expiresAt: input.expiresAt ?? null,
      },
    });

    // Write the DERIVED balance. The only place it is ever written.
    await tx.loyaltyAccount.update({
      where: { id: account.id },
      data: { pointsBalance: nextBalance },
    });

    return { entry, pointsBalance: nextBalance, replayed: false };
  };

  if (client) return run(client);
  return prisma.$transaction(run, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  });
}

/** Sums the ledger. The authoritative balance. */
async function sumLedger(
  tx: PrismaTransactionClient,
  accountId: string,
): Promise<number> {
  const aggregate = await tx.loyaltyEntry.aggregate({
    where: { accountId },
    _sum: { points: true },
  });
  return aggregate._sum.points ?? 0;
}

/**
 * The account for a user, created on demand.
 *
 * Lazy, like the referral code: most accounts will never earn a point while
 * the programme is off, and a row per user that has never ordered is a row
 * nobody reads.
 */
export async function ensureLoyaltyAccount(
  userId: string,
  client?: PrismaTransactionClient,
): Promise<{ id: string; pointsBalance: number }> {
  const db = client ?? prisma;
  const existing = await db.loyaltyAccount.findUnique({
    where: { userId },
    select: { id: true, pointsBalance: true },
  });
  if (existing) return existing;

  // `upsert` rather than `create`: two orders completing at once for the same
  // customer would otherwise race and one would fail on the unique index.
  return db.loyaltyAccount.upsert({
    where: { userId },
    create: { userId },
    update: {},
    select: { id: true, pointsBalance: true },
  });
}

/** A user's balance, or zero when they have never earned. */
export async function getPointsBalance(userId: string): Promise<number> {
  const account = await prisma.loyaltyAccount.findUnique({
    where: { userId },
    select: { pointsBalance: true },
  });
  return account?.pointsBalance ?? 0;
}

/**
 * Recomputes a balance from the ledger, repairing the cached column if it had
 * drifted. Safe to run on a schedule; the same shape as
 * `reconcileWalletBalance` and there for the same reason.
 */
export async function reconcileLoyaltyBalance(
  accountId: string,
): Promise<{ storedBalance: number; ledgerBalance: number; repaired: boolean }> {
  return prisma.$transaction(
    async (tx) => {
      const account = await tx.loyaltyAccount.findUniqueOrThrow({
        where: { id: accountId },
        select: { pointsBalance: true },
      });
      const ledgerBalance = await sumLedger(tx, accountId);
      const repaired = ledgerBalance !== account.pointsBalance;
      if (repaired) {
        await tx.loyaltyAccount.update({
          where: { id: accountId },
          data: { pointsBalance: ledgerBalance },
        });
      }
      return { storedBalance: account.pointsBalance, ledgerBalance, repaired };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}
