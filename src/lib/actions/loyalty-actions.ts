'use server';

import { revalidatePath } from 'next/cache';
import { requireOnboardedUser } from '@/lib/auth/session';
import { redeemPoints } from '@/lib/loyalty/redemption';
import { formatCentavos } from '@/lib/money';

/**
 * The customer's own redemption action.
 *
 * Resolves the account from the session, never from an argument: a client
 * cannot name whose points it is spending. The amount IS a client input, and
 * it is validated against the programme's block size and the real balance
 * inside a serializable transaction — see `redeemPoints`.
 */

export type RedeemResult =
  | { ok: true; message: string }
  | { ok: false; message: string };

export async function redeemPointsAction(
  pointsRequested: number,
): Promise<RedeemResult> {
  try {
    const user = await requireOnboardedUser();
    const result = await redeemPoints({
      userId: user.id,
      pointsRequested: Math.floor(pointsRequested),
    });

    if (!result.ok) return { ok: false, message: result.message };

    revalidatePath('/points');
    revalidatePath('/credits');
    revalidatePath('/');

    return {
      ok: true,
      message:
        `${result.pointsSpent} points became ${formatCentavos(result.centavosGranted)} ` +
        'in credits. Spend it on your next order.',
    };
  } catch (error) {
    // The named refusals all come back through `result` above. Anything here
    // is unexpected and is not the customer's problem to read.
    console.error('redeem points failed:', error);
    return { ok: false, message: 'That did not go through. Try again in a moment.' };
  }
}
