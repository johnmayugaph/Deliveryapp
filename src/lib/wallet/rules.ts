import { WalletTransactionType } from '@prisma/client';

/**
 * The rules that make the credits ledger a ledger. Pure, so they are testable
 * without a database, and shared by `ledger.ts` and the SQL guards in
 * `prisma/sql/wallet_append_only.sql` — the two must agree.
 */

/** Types that may only ever increase a balance. All are granted by us. */
export const CREDIT_TYPES: readonly WalletTransactionType[] = [
  WalletTransactionType.PROMO_CREDIT,
  WalletTransactionType.REFUND,
  WalletTransactionType.REFERRAL_BONUS,
];

/** Types that may only ever decrease a balance. */
export const DEBIT_TYPES: readonly WalletTransactionType[] = [
  WalletTransactionType.ORDER_PAYMENT,
];

/** Types that must name the order they belong to. */
export const ORDER_LINKED_TYPES: readonly WalletTransactionType[] = [
  WalletTransactionType.ORDER_PAYMENT,
  WalletTransactionType.REFUND,
];

export class InvalidLedgerEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidLedgerEntryError';
  }
}

/**
 * Derives the SIGNED ledger amount from the transaction type.
 *
 * Callers pass a magnitude and a type; they never pass a sign. That is what
 * makes it impossible to book a payment as a credit by passing the wrong
 * number. `ADJUSTMENT` is the single signed type, because an admin correction
 * legitimately goes either way.
 */
export function signedAmountFor(
  type: WalletTransactionType,
  amountCentavos: number,
): number {
  if (!Number.isInteger(amountCentavos)) {
    throw new InvalidLedgerEntryError(
      `Ledger amounts must be whole centavos, got ${amountCentavos}`,
    );
  }
  if (amountCentavos === 0) {
    throw new InvalidLedgerEntryError('A ledger entry of zero centavos means nothing');
  }

  if (type === WalletTransactionType.ADJUSTMENT) {
    return amountCentavos;
  }

  if (amountCentavos < 0) {
    throw new InvalidLedgerEntryError(
      `${type} takes a positive magnitude; the sign is derived from the type`,
    );
  }

  if (CREDIT_TYPES.includes(type)) {
    return amountCentavos;
  }
  if (DEBIT_TYPES.includes(type)) {
    return -amountCentavos;
  }

  throw new InvalidLedgerEntryError(`Unhandled transaction type "${type}"`);
}

/** Replays a ledger to a balance. The authoritative definition of "balance". */
export function replayLedger(
  entries: readonly { amountCentavos: number }[],
): number {
  return entries.reduce((total, entry) => total + entry.amountCentavos, 0);
}
