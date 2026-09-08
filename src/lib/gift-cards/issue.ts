import { Prisma, type GiftCard } from '@prisma/client';
import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import { generateGiftCode, generateReference, hashGiftCode } from '@/lib/gift-cards/codes';
import {
  MAX_GIFT_CARD_CENTAVOS,
  formatGiftCode,
  giftCardStatus,
} from '@/lib/gift-cards/policy';

/**
 * Issuing a gift card, and cancelling one.
 *
 * Issuing is the moment TARA decides to give money away, so it is attributable
 * (an administrator's id and a reason, both on the row) and it is the ONLY
 * moment the plaintext code exists in this system. It is returned to the
 * caller and never stored — see `GiftCard.codeHash`.
 */

export class GiftCardAmountError extends Error {
  constructor(readonly amountCentavos: number) {
    super(
      `A gift card must be worth between 1 and ${MAX_GIFT_CARD_CENTAVOS} centavos, not ${amountCentavos}. ` +
        'A single bearer instrument worth more than that is usually a decimal point in the wrong place.',
    );
    this.name = 'GiftCardAmountError';
  }
}

export class GiftCardNotVoidableError extends Error {
  constructor(readonly reference: string, readonly why: string) {
    super(`Gift card ${reference} cannot be cancelled: ${why}`);
    this.name = 'GiftCardNotVoidableError';
  }
}

export interface IssuedGiftCard {
  card: GiftCard;
  /**
   * The plaintext code, grouped for reading. **This is the only time it
   * exists.** Show it once, hand it over, and do not log it — the row holds
   * only a hash, so nothing can recover it afterwards, which is the point.
   */
  code: string;
}

/** How many times to retry a reference collision before giving up. */
const REFERENCE_ATTEMPTS = 5;

/**
 * Issues one card and returns its code exactly once.
 *
 * The retry loop is for the REFERENCE, not the code. A reference is six
 * characters (about 729 million) and is generated per card, so with enough
 * cards a collision is a birthday problem worth handling rather than a
 * theoretical one — and the unique index means a collision is a clean insert
 * failure, not a corrupted row. The code itself is ~78 bits: a collision there
 * would be a broken CSPRNG, and retrying would paper over it, so it is left to
 * fail loudly.
 */
export async function issueGiftCard(
  input: {
    amountCentavos: number;
    /** The administrator giving the money away. */
    issuedById: string;
    /** Why. Read by whoever comes back to this row later. */
    issuedReason: string;
    note?: string | undefined;
    /** Null or absent means it never expires, which is the default. */
    expiresAt?: Date | null | undefined;
  },
  client?: PrismaTransactionClient,
): Promise<IssuedGiftCard> {
  if (
    !Number.isInteger(input.amountCentavos) ||
    input.amountCentavos <= 0 ||
    input.amountCentavos > MAX_GIFT_CARD_CENTAVOS
  ) {
    throw new GiftCardAmountError(input.amountCentavos);
  }

  const db = client ?? prisma;
  const code = generateGiftCode();
  const codeHash = hashGiftCode(code);

  for (let attempt = 1; attempt <= REFERENCE_ATTEMPTS; attempt += 1) {
    try {
      const card = await db.giftCard.create({
        data: {
          codeHash,
          reference: generateReference(),
          amountCentavos: input.amountCentavos,
          issuedById: input.issuedById,
          issuedReason: input.issuedReason.trim(),
          note: input.note?.trim() || null,
          expiresAt: input.expiresAt ?? null,
        },
      });
      return { card, code: formatGiftCode(code) };
    } catch (error) {
      const isReferenceCollision =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        String(error.meta?.target ?? '').includes('reference');
      if (!isReferenceCollision || attempt === REFERENCE_ATTEMPTS) throw error;
    }
  }

  // Unreachable: the loop either returns or throws.
  throw new Error('Could not allocate a gift card reference');
}

/**
 * Cancels an unredeemed card.
 *
 * Only unredeemed. Once the credits are in somebody's balance there is nothing
 * left to cancel — the money is spendable, and clawing it back is a signed
 * `ADJUSTMENT` against that account with a reason, not a flag on this table.
 * The database refuses the combination too
 * (`gift_card_not_redeemed_and_void`); this is the version that produces a
 * sentence an operator can read.
 *
 * An already-void card is refused rather than re-voided, so the original
 * reason and time survive — the immutability trigger enforces the same thing.
 */
export async function voidGiftCard(
  input: { cardId: string; voidedById: string; reason: string },
  client?: PrismaTransactionClient,
): Promise<GiftCard> {
  const db = client ?? prisma;
  const card = await db.giftCard.findUnique({ where: { id: input.cardId } });
  if (!card) {
    throw new GiftCardNotVoidableError(input.cardId, 'no such card');
  }

  const status = giftCardStatus(card);
  if (status === 'REDEEMED') {
    throw new GiftCardNotVoidableError(
      card.reference,
      'it has already been redeemed, so the credits are in somebody’s balance. ' +
        'Correct that balance with an adjustment instead.',
    );
  }
  if (status === 'VOID') {
    throw new GiftCardNotVoidableError(card.reference, 'it is already cancelled');
  }

  const reason = input.reason.trim();
  if (reason.length === 0) {
    throw new GiftCardNotVoidableError(card.reference, 'a cancellation needs a reason');
  }

  // Compare-and-set on `redeemedAt`, not a plain update. Between the read
  // above and this write, somebody holding the card may have redeemed it —
  // and cancelling a card whose money has already moved would leave the row
  // saying one thing and the ledger another.
  const { count } = await db.giftCard.updateMany({
    where: { id: card.id, redeemedAt: null, voidedAt: null },
    data: { voidedAt: new Date(), voidedById: input.voidedById, voidReason: reason },
  });
  if (count !== 1) {
    throw new GiftCardNotVoidableError(
      card.reference,
      'somebody redeemed or cancelled it while this was being submitted',
    );
  }

  return db.giftCard.findUniqueOrThrow({ where: { id: card.id } });
}
