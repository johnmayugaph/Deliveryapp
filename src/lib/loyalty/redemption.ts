import { LoyaltyEntryType, Prisma, WalletTransactionType } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { ensureWallet, recordWalletTransaction } from '@/lib/wallet/ledger';
import { ensureLoyaltyAccount, recordLoyaltyEntry } from '@/lib/loyalty/ledger';
import { getProgramme } from '@/lib/loyalty/programme';
import { formatCentavos } from '@/lib/money';
import {
  REDEMPTION_REFUSAL_TEXT,
  quoteRedemption,
  type RedemptionRefusal,
} from '@/lib/loyalty/policy';

/**
 * Turning points into credits.
 *
 * **This is the only place in the app where a customer causes credits to come
 * into existence.** A referral needs somebody else to sign up and order; a
 * promo needs an administrator to type a reason; a refund needs an order that
 * went wrong. This needs one tap by the person who benefits.
 *
 * So it is written to be exact rather than convenient:
 *
 *  - **One transaction, SERIALIZABLE.** Two taps racing at a balance of 500
 *    must not both succeed. The points balance is read from the ledger inside
 *    the transaction, and the database's own
 *    `loyalty_account_balance_non_negative` is the backstop under that.
 *  - **Points out before credits in.** The debit is written first, so a
 *    failure after it cannot leave credits granted against points nobody took.
 *    The reverse order would be the expensive way round.
 *  - **The two rows name each other.** `LoyaltyEntry.walletTransactionId` is
 *    required for REDEEMED by a CHECK constraint, so a redemption that granted
 *    nothing, or granted something nobody can find, cannot be recorded.
 *  - **Credits through `grantCredit` only.** Not a second write path into the
 *    wallet, not a balance field. The credits ledger keeps its own rules and
 *    this respects them the same as every other caller.
 *
 * What it deliberately does NOT do is let points pay for an order directly.
 * Points are converted, then the credits are spent by the ordinary checkout —
 * so there is exactly one spendable balance and one place that spends it.
 */

export type RedemptionResult =
  | {
      ok: true;
      pointsSpent: number;
      centavosGranted: number;
      pointsRemaining: number;
      creditsBalanceCentavos: number;
    }
  | { ok: false; refusal: RedemptionRefusal; message: string };

/**
 * Redeems points for credits.
 *
 * `pointsRequested` comes from the customer, so it is validated against the
 * programme's block size and against their real balance — never trusted, and
 * never silently floored to something they did not ask for.
 */
export async function redeemPoints(input: {
  userId: string;
  pointsRequested: number;
}): Promise<RedemptionResult> {
  const programme = await getProgramme();

  // Cheap refusals first, outside the transaction: a programme that is off or
  // a request that is not a whole block needs no lock to answer.
  const preview = quoteRedemption(programme, {
    pointsRequested: input.pointsRequested,
    // Not yet checked against the balance — that has to happen inside the
    // transaction, so pass a value that cannot cause a false refusal here.
    pointsAvailable: Number.MAX_SAFE_INTEGER,
  });
  if (preview.refusal !== null) {
    return {
      ok: false,
      refusal: preview.refusal,
      message: REDEMPTION_REFUSAL_TEXT[preview.refusal],
    };
  }

  try {
    return await prisma.$transaction(
      async (tx) => {
        const account = await ensureLoyaltyAccount(input.userId, tx);

        // The authoritative check, inside the transaction. The ledger sum,
        // not the cached column, because the column is derived and a racing
        // write may not have updated it yet.
        const held = await tx.loyaltyEntry.aggregate({
          where: { accountId: account.id },
          _sum: { points: true },
        });
        const available = held._sum.points ?? 0;

        const quote = quoteRedemption(programme, {
          pointsRequested: input.pointsRequested,
          pointsAvailable: available,
        });
        if (quote.refusal !== null) {
          return {
            ok: false as const,
            refusal: quote.refusal,
            message: REDEMPTION_REFUSAL_TEXT[quote.refusal],
          };
        }

        // Credits first, so its id can be named by the points row — the CHECK
        // constraint requires the link, and a points row cannot be written
        // and then updated to add it, because the ledger is append-only.
        //
        // The ORDER of effects still puts the customer at no risk: both writes
        // are in one transaction, so a failure between them rolls back the
        // credits as well.
        const wallet = await ensureWallet(input.userId, tx);
        const credit = await recordWalletTransaction(
          {
            walletId: wallet.id,
            type: WalletTransactionType.PROMO_CREDIT,
            amountCentavos: quote.centavosGranted,
            description: `${quote.pointsSpent} points redeemed`,
            metadata: { source: 'LOYALTY_REDEMPTION', points: quote.pointsSpent },
          },
          tx,
        );

        const debit = await recordLoyaltyEntry(
          {
            accountId: account.id,
            type: LoyaltyEntryType.REDEEMED,
            points: quote.pointsSpent,
            description: `Redeemed for ${formatCentavos(quote.centavosGranted)} in credits`,
            walletTransactionId: credit.transaction.id,
          },
          tx,
        );

        return {
          ok: true as const,
          pointsSpent: quote.pointsSpent,
          centavosGranted: quote.centavosGranted,
          pointsRemaining: debit.pointsBalance,
          creditsBalanceCentavos: credit.balanceCentavos,
        };
      },
      // The isolation level that makes the balance read above trustworthy.
      // Without it two concurrent taps could both read 500 and both spend it.
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    // A serialization failure means somebody else's redemption committed
    // first. Refusing with "not enough points" would be wrong if they still
    // have some, so re-read and answer from the truth.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === 'P2034' || error.code === 'P2002')
    ) {
      return {
        ok: false,
        refusal: 'NOT_ENOUGH_POINTS',
        message:
          'That did not go through — your points may have just changed. Check the ' +
          'balance and try again.',
      };
    }
    throw error;
  }
}
