import { Prisma } from '@prisma/client';
import { WalletTransactionType } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { grantCredit } from '@/lib/wallet/ledger';
import { withSerializationRetry } from '@/lib/db/serializable';
import { hashGiftCode } from '@/lib/gift-cards/codes';
import {
  REFUSAL_TEXT,
  giftCardStatus,
  giftCodeLooksPlausible,
  ledgerDescriptionFor,
  normaliseGiftCode,
  refusalForStatus,
  type GiftCardRefusal,
} from '@/lib/gift-cards/policy';

/**
 * Redeeming a gift card.
 *
 * ### Why a result rather than an exception
 *
 * A wrong code is the ORDINARY case here, not a fault: somebody misread a
 * letter on a printed card, or their partner already used it. Exceptions are
 * for the unexpected, and a function whose commonest outcome is a throw makes
 * every caller wrap it in a try/catch that swallows real errors too. So this
 * returns a discriminated result and reserves throwing for things that are
 * genuinely wrong.
 *
 * ### The three things that make it airtight
 *
 * **A compare-and-set, not a read-then-write.** The card is claimed with
 * `UPDATE ... WHERE "redeemedAt" IS NULL`, and the affected row count is
 * checked. That is atomic in Postgres at any isolation level, so two people
 * typing the same code at the same instant cannot both win — independently of
 * the transaction's isolation, and independently of whether a future caller
 * remembers to use one.
 *
 * **The ledger row is written first, inside the same transaction.** It has to
 * be: `gift_card_redemption_is_complete` requires `redeemedAt` and
 * `walletTransactionId` to be set together, and a CHECK constraint in Postgres
 * cannot be deferred, so there is no moment where one is set without the
 * other. If the compare-and-set then loses, the whole transaction rolls back
 * and the credits row goes with it.
 *
 * **The grant is idempotent on the card.** Keyed `gift-card:<id>`, so even a
 * retried transaction credits once. That key is also unique in the database,
 * which makes it a second, independent barrier to double-crediting: two
 * transactions that somehow both got past the compare-and-set would collide
 * on it.
 *
 * ### What is not here: a rate limiter
 *
 * Deliberately, and this is a judgement worth stating rather than hiding. The
 * defence against guessing is the ~78 bits in the code, not a throttle: at a
 * million attempts a second, expecting one hit takes longer than the age of
 * the universe. A malformed code is refused with no database work at all, and
 * a well-formed wrong one costs a single index seek on a unique hash. So a
 * throttle here would protect the server from load rather than the cards from
 * theft — worth having when this app gets general rate limiting, and not worth
 * a bespoke table and a false sense of security before then.
 */

export type RedeemResult =
  | {
      ok: true;
      amountCentavos: number;
      /** The non-secret handle, safe to show and to store. */
      reference: string;
      balanceCentavos: number;
    }
  | { ok: false; refusal: GiftCardRefusal; message: string };

const refuse = (refusal: GiftCardRefusal): RedeemResult => ({
  ok: false,
  refusal,
  message: REFUSAL_TEXT[refusal],
});

/** Thrown inside the transaction purely to roll it back. Never escapes. */
class LostTheRace extends Error {}

/**
 * Redeems a code into the signed-in customer's credits.
 *
 * `userId` comes from the session, never from an argument the client controls
 * — every caller in this app resolves it that way, and a gift card is the one
 * place where getting that wrong would credit a stranger.
 */
export async function redeemGiftCard(
  input: { rawCode: string; userId: string },
  now: Date = new Date(),
): Promise<RedeemResult> {
  const code = normaliseGiftCode(input.rawCode);

  // Refused without touching the database. A hash comparison cannot fix a
  // typo, and this field is reachable by anybody with an account.
  if (!giftCodeLooksPlausible(code)) {
    return refuse('MALFORMED');
  }

  const codeHash = hashGiftCode(code);

  try {
    return await withSerializationRetry(() =>
      prisma.$transaction(
        async (tx) => {
          const card = await tx.giftCard.findUnique({ where: { codeHash } });
          if (!card) {
            return refuse('UNKNOWN');
          }

          // This decides the MESSAGE. The compare-and-set below is what
          // decides the outcome — between this read and that write somebody
          // else may claim the card, and only the row count can tell us.
          const refusal = refusalForStatus(giftCardStatus(card, now));
          if (refusal !== null) {
            return refuse(refusal);
          }

          // The credits first, so the card row can be completed in one write.
          // A frozen balance does NOT refuse: see the note in `policy.ts` —
          // the ledger blocks freezes against debits only, and a card that
          // landed in a held balance is recoverable while a wasted card is
          // not.
          const granted = await grantCredit(
            {
              userId: input.userId,
              type: WalletTransactionType.GIFT_CARD,
              amountCentavos: card.amountCentavos,
              // The REFERENCE, never the code. This string is persisted in an
              // append-only table and appears in every backup; putting the
              // code in it would undo the whole point of hashing it.
              description: ledgerDescriptionFor(card.reference),
              idempotencyKey: `gift-card:${card.id}`,
              metadata: { giftCardId: card.id, reference: card.reference },
            },
            tx,
          );

          const { count } = await tx.giftCard.updateMany({
            where: { id: card.id, redeemedAt: null, voidedAt: null },
            data: {
              redeemedAt: now,
              redeemedById: input.userId,
              walletTransactionId: granted.transaction.id,
            },
          });
          if (count !== 1) {
            // Somebody claimed it in the microseconds since the read. Roll
            // the credits back with it — this is the case the whole
            // transaction exists for.
            throw new LostTheRace();
          }

          return {
            ok: true as const,
            amountCentavos: card.amountCentavos,
            reference: card.reference,
            balanceCentavos: granted.balanceCentavos,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  } catch (error) {
    if (error instanceof LostTheRace) {
      return refuse('ALREADY_REDEEMED');
    }
    // The independent second barrier: the grant's idempotency key is unique in
    // the database, so two transactions that both got past the compare-and-set
    // collide here instead of double-crediting. Same customer-facing answer.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002' &&
      String(error.meta?.target ?? '').includes('idempotencyKey')
    ) {
      return refuse('ALREADY_REDEEMED');
    }
    throw error;
  }
}
