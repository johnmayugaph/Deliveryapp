import {
  Prisma,
  WalletTransactionType,
  type Wallet,
  type WalletTransaction,
} from '@prisma/client';
import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import { CURRENCY } from '@/lib/money';
import {
  InvalidLedgerEntryError,
  ORDER_LINKED_TYPES,
  signedAmountFor,
} from '@/lib/wallet/rules';

export { InvalidLedgerEntryError } from '@/lib/wallet/rules';

/**
 * The credits ledger.
 *
 * =============================== HARD CONSTRAINTS ===========================
 * These are product constraints, not implementation details. They are the
 * reason this is "credits" and not a wallet, and they are enforced here rather
 * than trusted to callers:
 *
 *   1. NO TOP-UP.     A customer cannot add their own cash to a balance. There
 *                     is no TOP_UP transaction type and no function that grants
 *                     credit on a customer's own authority — every credit type
 *                     is something WE grant.
 *   2. NO TRANSFERS.  Credits cannot move between users. Every function here
 *                     touches exactly one wallet; there is no two-wallet path.
 *   3. NO CASH-OUT.   No withdrawal, no refund-to-cash, no conversion out.
 *                     `spendOnOrder` is the only debit a customer can cause,
 *                     and its destination is an order inside this app.
 *   4. SPEND IN-APP.  A debit requires a `relatedOrderId`, so every peso that
 *                     leaves a balance points at the order it paid for.
 *
 * Because there is no code path, there is nothing to disable later by mistake.
 * `src/tests/wallet-ledger.test.ts` asserts this module exports no top-up,
 * transfer, or withdrawal API, so adding one is a failing test rather than a
 * quiet regression.
 *
 * ================================ THE LEDGER =================================
 * Every balance change goes through `recordWalletTransaction`. It writes a
 * `WalletTransaction` row and then RECALCULATES `Wallet.balanceCentavos` from
 * the sum of the ledger. The ledger is the truth; the balance column is a
 * derived cache. Nothing else in the codebase may write that column.
 *
 * UI wording: surface this as "Credits" or "Rewards". Never "wallet",
 * "e-wallet", "e-money", or "balance you can cash out".
 * ============================================================================
 */

/** Documented for the docs page and for anyone reviewing this module. */
export const WALLET_CONSTRAINTS = {
  topUpAllowed: false,
  transfersAllowed: false,
  withdrawalAllowed: false,
  spendableOnlyOnOrders: true,
  /** Customer-facing name. Not "wallet". */
  uiLabel: 'Credits',
} as const;

export class WalletNotFoundError extends Error {
  constructor(readonly userId: string) {
    super(`No credits account for user "${userId}"`);
    this.name = 'WalletNotFoundError';
  }
}

export class WalletFrozenError extends Error {
  constructor(readonly walletId: string, readonly reason: string | null) {
    super(`Credits account "${walletId}" is frozen${reason ? `: ${reason}` : ''}`);
    this.name = 'WalletFrozenError';
  }
}

export class InsufficientCreditsError extends Error {
  constructor(readonly availableCentavos: number, readonly requestedCentavos: number) {
    super(
      `Insufficient credits: ${requestedCentavos} centavos requested, ${availableCentavos} available`,
    );
    this.name = 'InsufficientCreditsError';
  }
}

/**
 * Input to the single mutation entry point. Note that callers supply a MAGNITUDE
 * and a type; they never supply a sign. The sign is derived from the type, so a
 * caller cannot accidentally turn a payment into a credit.
 */
export interface RecordTransactionInput {
  walletId: string;
  type: WalletTransactionType;
  /**
   * Magnitude in centavos, always positive — except for ADJUSTMENT, which is
   * the one signed type and may be negative.
   */
  amountCentavos: number;
  description: string;
  relatedOrderId?: string;
  /** Required for ADJUSTMENT: which admin made the correction. */
  adminUserId?: string;
  /** Makes a grant idempotent, so a retried campaign cannot double-credit. */
  idempotencyKey?: string;
  metadata?: Prisma.InputJsonValue;
}

export interface LedgerResult {
  transaction: WalletTransaction;
  balanceCentavos: number;
}

/**
 * THE ONLY function in this codebase that changes a credits balance.
 *
 * Writes a ledger row, recomputes the balance from the sum of the ledger, and
 * writes that derived value back. Runs at SERIALIZABLE isolation so two
 * concurrent grants cannot both read a stale sum and write the same total.
 */
export async function recordWalletTransaction(
  input: RecordTransactionInput,
  client?: PrismaTransactionClient,
): Promise<LedgerResult> {
  const run = async (tx: PrismaTransactionClient): Promise<LedgerResult> => {
    if (input.type === WalletTransactionType.ADJUSTMENT && !input.adminUserId) {
      throw new InvalidLedgerEntryError(
        'An ADJUSTMENT requires an adminUserId — untraceable corrections are how ledgers rot',
      );
    }
    if (ORDER_LINKED_TYPES.includes(input.type) && !input.relatedOrderId) {
      throw new InvalidLedgerEntryError(
        `${input.type} requires a relatedOrderId: credits are only spendable on orders in this app`,
      );
    }
    if (!input.description.trim()) {
      throw new InvalidLedgerEntryError(
        'Every ledger row needs a description — it is what the customer reads in their history',
      );
    }

    // Idempotent replay: return the existing row rather than double-writing.
    if (input.idempotencyKey) {
      const existing = await tx.walletTransaction.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (existing) {
        const wallet = await tx.wallet.findUniqueOrThrow({
          where: { id: existing.walletId },
          select: { balanceCentavos: true },
        });
        return { transaction: existing, balanceCentavos: wallet.balanceCentavos };
      }
    }

    const wallet = await tx.wallet.findUnique({ where: { id: input.walletId } });
    if (!wallet) {
      throw new InvalidLedgerEntryError(`No credits account with id "${input.walletId}"`);
    }

    const signedAmount = signedAmountFor(input.type, input.amountCentavos);

    if (wallet.isFrozen && signedAmount < 0) {
      throw new WalletFrozenError(wallet.id, wallet.frozenReason);
    }

    // The ledger, not the cached column, decides what is available.
    const priorBalance = await sumLedger(tx, wallet.id);
    const nextBalance = priorBalance + signedAmount;

    if (nextBalance < 0) {
      throw new InsufficientCreditsError(priorBalance, Math.abs(signedAmount));
    }

    const transaction = await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        type: input.type,
        amountCentavos: signedAmount,
        balanceAfterCentavos: nextBalance,
        relatedOrderId: input.relatedOrderId ?? null,
        description: input.description.trim(),
        adminUserId: input.adminUserId ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        metadata: input.metadata ?? undefined,
      },
    });

    // Write the DERIVED balance. This is the only place it is ever written.
    await tx.wallet.update({
      where: { id: wallet.id },
      data: { balanceCentavos: nextBalance },
    });

    return { transaction, balanceCentavos: nextBalance };
  };

  if (client) {
    return run(client);
  }
  return prisma.$transaction(run, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  });
}

/** Sums the ledger. The authoritative balance. */
async function sumLedger(tx: PrismaTransactionClient, walletId: string): Promise<number> {
  const aggregate = await tx.walletTransaction.aggregate({
    where: { walletId },
    _sum: { amountCentavos: true },
  });
  return aggregate._sum.amountCentavos ?? 0;
}

/**
 * Recomputes a balance from the ledger and returns it, repairing the cached
 * column if it had drifted. Safe to run on a schedule.
 */
export async function reconcileWalletBalance(walletId: string): Promise<{
  balanceCentavos: number;
  driftCentavos: number;
}> {
  return prisma.$transaction(
    async (tx) => {
      const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: walletId } });
      const ledgerBalance = await sumLedger(tx, walletId);
      const driftCentavos = ledgerBalance - wallet.balanceCentavos;

      if (driftCentavos !== 0) {
        await tx.wallet.update({
          where: { id: walletId },
          data: { balanceCentavos: ledgerBalance },
        });
      }

      return { balanceCentavos: ledgerBalance, driftCentavos };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

/** Creates the credits account if the person does not have one yet. */
export async function ensureWallet(
  userId: string,
  client?: PrismaTransactionClient,
): Promise<Wallet> {
  const db = client ?? prisma;
  const existing = await db.wallet.findUnique({ where: { userId } });
  if (existing) {
    return existing;
  }
  return db.wallet.create({ data: { userId, currency: CURRENCY } });
}

export async function getWalletForUser(userId: string): Promise<Wallet | null> {
  return prisma.wallet.findUnique({ where: { userId } });
}

/** Spendable credits. Read from the ledger, never from the cached column. */
export async function getSpendableCentavos(userId: string): Promise<number> {
  const wallet = await prisma.wallet.findUnique({
    where: { userId },
    select: { id: true, isFrozen: true },
  });
  if (!wallet || wallet.isFrozen) {
    return 0;
  }
  const aggregate = await prisma.walletTransaction.aggregate({
    where: { walletId: wallet.id },
    _sum: { amountCentavos: true },
  });
  return Math.max(0, aggregate._sum.amountCentavos ?? 0);
}

export async function listWalletTransactions(
  userId: string,
  options?: { limit?: number },
): Promise<WalletTransaction[]> {
  const wallet = await prisma.wallet.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (!wallet) {
    return [];
  }
  return prisma.walletTransaction.findMany({
    where: { walletId: wallet.id },
    orderBy: { createdAt: 'desc' },
    take: options?.limit ?? 50,
  });
}

// -----------------------------------------------------------------------------
// The named operations. Note which four are absent.
// -----------------------------------------------------------------------------

/**
 * Grants credits. WE grant; the customer cannot. This is the closest thing to a
 * top-up that exists, and it is deliberately not one: the caller is a promo
 * campaign, a referral payout, or a support goodwill gesture, never a customer
 * handing over cash.
 */
export async function grantCredit(
  input: {
    userId: string;
    type: Extract<
      WalletTransactionType,
      'PROMO_CREDIT' | 'REFERRAL_BONUS'
    >;
    amountCentavos: number;
    description: string;
    idempotencyKey?: string;
    metadata?: Prisma.InputJsonValue;
  },
  client?: PrismaTransactionClient,
): Promise<LedgerResult> {
  const wallet = await ensureWallet(input.userId, client);
  return recordWalletTransaction(
    {
      walletId: wallet.id,
      type: input.type,
      amountCentavos: input.amountCentavos,
      description: input.description,
      idempotencyKey: input.idempotencyKey,
      metadata: input.metadata,
    },
    client,
  );
}

/**
 * Spends credits on an order. The ONLY debit a customer can cause, and it
 * requires an order id — which is constraint 4 made unavoidable.
 */
export async function spendOnOrder(
  input: {
    userId: string;
    orderId: string;
    amountCentavos: number;
    description: string;
    idempotencyKey?: string;
  },
  client?: PrismaTransactionClient,
): Promise<LedgerResult> {
  const wallet = await prisma.wallet.findUnique({ where: { userId: input.userId } });
  if (!wallet) {
    throw new WalletNotFoundError(input.userId);
  }
  return recordWalletTransaction(
    {
      walletId: wallet.id,
      type: WalletTransactionType.ORDER_PAYMENT,
      amountCentavos: input.amountCentavos,
      description: input.description,
      relatedOrderId: input.orderId,
      idempotencyKey: input.idempotencyKey,
    },
    client,
  );
}

/**
 * Refunds credits for a cancelled or failed order. Returns credits to the
 * credits balance — NOT to cash, and not to a card. There is no rail out.
 */
export async function refundToCredits(
  input: {
    userId: string;
    orderId: string;
    amountCentavos: number;
    description: string;
    idempotencyKey?: string;
  },
  client?: PrismaTransactionClient,
): Promise<LedgerResult> {
  const wallet = await ensureWallet(input.userId, client);
  return recordWalletTransaction(
    {
      walletId: wallet.id,
      type: WalletTransactionType.REFUND,
      amountCentavos: input.amountCentavos,
      description: input.description,
      relatedOrderId: input.orderId,
      idempotencyKey: input.idempotencyKey,
    },
    client,
  );
}

/** A signed admin correction. Requires an admin and a reason, and is logged. */
export async function recordAdjustment(
  input: {
    userId: string;
    adminUserId: string;
    /** May be negative. */
    amountCentavos: number;
    description: string;
    idempotencyKey?: string;
  },
  client?: PrismaTransactionClient,
): Promise<LedgerResult> {
  const wallet = await ensureWallet(input.userId, client);
  return recordWalletTransaction(
    {
      walletId: wallet.id,
      type: WalletTransactionType.ADJUSTMENT,
      amountCentavos: input.amountCentavos,
      description: input.description,
      adminUserId: input.adminUserId,
      idempotencyKey: input.idempotencyKey,
    },
    client,
  );
}

// -----------------------------------------------------------------------------
// DELIBERATELY ABSENT — do not add these.
//
//   topUpWallet()      — a customer may not add their own cash. There is no
//                        cash-in rail, and adding one turns this into a stored
//                        value instrument with the regulatory weight that
//                        implies.
//   transferCredits()  — credits do not move between users. Every function
//                        above touches exactly one wallet.
//   withdrawCredits()  — no cash-out. Credits are spent on orders or they are
//                        not spent.
//   setBalance()       — the balance is derived from the ledger. Writing it
//                        directly is how a ledger stops being the truth.
//
// If a requirement seems to need one of these, that is a product conversation,
// not a patch. See docs/architecture.md § Credits.
// -----------------------------------------------------------------------------
