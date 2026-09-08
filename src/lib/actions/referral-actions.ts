'use server';

import { revalidatePath } from 'next/cache';
import { requireOnboardedUser } from '@/lib/auth/session';
import { attributeReferral } from '@/lib/referrals/attribution';
import { formatCentavos } from '@/lib/money';

/**
 * Server actions for referrals.
 *
 * Both resolve the account from the session, never from arguments: a client
 * cannot name whose account is being attributed, which is the difference
 * between a referral programme and a way to attach strangers to your code.
 */

export type EnterCodeResult =
  | { ok: true; message: string }
  | { ok: false; message: string };

/**
 * Enters a code by hand, for somebody who was TOLD it rather than sent a link.
 *
 * Which is most of them. A code read out in a jeepney or typed into a group
 * chat never passes through the cookie, and a referral feature reachable only
 * by clicking a link works for the half of sharing that happens on a screen.
 *
 * The refusals are the policy's own sentences — "that is your own invite
 * code", "this account already used an invite code" — because each one tells
 * the person something different about what to do next.
 */
export async function enterReferralCodeAction(
  rawCode: string,
): Promise<EnterCodeResult> {
  try {
    const user = await requireOnboardedUser();
    const result = await attributeReferral({
      refereeId: user.id,
      code: rawCode,
    });

    if (!result.ok) {
      return { ok: false, message: result.message };
    }

    revalidatePath('/invite');
    revalidatePath('/credits');
    revalidatePath('/');

    const who = result.referrerName ? ` from ${result.referrerName}` : '';
    return {
      ok: true,
      message:
        result.refereeGrantedCentavos > 0
          ? `${formatCentavos(result.refereeGrantedCentavos)} in credits${who}. Spend it on your first order.`
          : `Invite${who} accepted.`,
    };
  } catch {
    // Named domain refusals all come back through `result` above; anything
    // reaching here is unexpected and is not the customer's problem.
    return { ok: false, message: 'That did not go through. Try again later.' };
  }
}
