'use server';

import { revalidatePath } from 'next/cache';
import { requireOnboardedUser } from '@/lib/auth/session';
import { redeemGiftCard } from '@/lib/gift-cards/redeem';
import { formatCentavos } from '@/lib/money';

/**
 * Redeeming a gift card, from the credits screen.
 *
 * The customer is resolved from the SESSION, never from an argument. Every
 * action in this app does that, and here it is the difference between adding
 * credits to your own balance and adding them to a stranger's — the one
 * argument this action takes is a code, which is a claim about what you are
 * holding, not about who you are.
 */

export type RedeemGiftCardResult =
  | { ok: true; message: string; amountCentavos: number }
  | { ok: false; message: string };

export async function redeemGiftCardAction(
  rawCode: string,
): Promise<RedeemGiftCardResult> {
  const user = await requireOnboardedUser();

  // A refusal is the ordinary case — a misread letter, a card somebody at home
  // already used — so this returns a sentence rather than throwing. The
  // messages come from `REFUSAL_TEXT` and each says which, unlike the promo
  // field's deliberately uniform answer; see the note in `gift-cards/policy`.
  const outcome = await redeemGiftCard({ rawCode, userId: user.id });

  if (!outcome.ok) {
    return { ok: false, message: outcome.message };
  }

  // The balance moved, so every screen that shows it is stale.
  revalidatePath('/credits');
  revalidatePath('/', 'layout');

  return {
    ok: true,
    amountCentavos: outcome.amountCentavos,
    message: `${formatCentavos(outcome.amountCentavos)} added to your credits.`,
  };
}
