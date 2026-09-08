'use server';

import { revalidatePath } from 'next/cache';
import { requireCurrentUser } from '@/lib/auth/session';
import {
  PaymentAlreadySettledError,
  PaymentNotExpectedError,
  PaymentRailUnavailableError,
  UnreadableReferenceError,
  submitPaymentReference,
} from '@/lib/payments/manual';
import { MAX_REFERENCE_LENGTH } from '@/lib/payments/policy';

/**
 * The customer's own side of a payment: "I have sent it, here is the number."
 *
 * Separate from the console's actions in `admin-actions.ts`, which confirm and
 * refuse. The split matters because these two things look similar and are not:
 * this records a CLAIM by the person who owes money, and those record a
 * DECISION by somebody who checked. Only the second moves the order.
 */

export type PaymentActionResult = { ok: true; message: string } | { ok: false; message: string };

export async function submitPaymentReferenceAction(
  _previous: PaymentActionResult | null,
  formData: FormData,
): Promise<PaymentActionResult> {
  try {
    const user = await requireCurrentUser();
    const orderId = String(formData.get('orderId') ?? '');
    const reference = String(formData.get('reference') ?? '').slice(
      0,
      // Trimmed before validation so a paste of half a receipt gets the
      // "that does not look like a reference" message rather than a
      // database error about a long string.
      MAX_REFERENCE_LENGTH * 2,
    );

    await submitPaymentReference({ orderId, userId: user.id, reference });

    revalidatePath(`/orders/${orderId}`);
    revalidatePath('/orders');
    return {
      ok: true,
      message: 'Got it. We are checking your payment — this is usually quick.',
    };
  } catch (error) {
    if (error instanceof UnreadableReferenceError) {
      return { ok: false, message: error.message };
    }
    if (error instanceof PaymentAlreadySettledError) {
      return { ok: false, message: error.message };
    }
    if (error instanceof PaymentNotExpectedError) {
      // Deliberately vague about WHY. The cases are "not your order" and "not
      // waiting for a payment", and distinguishing them for a stranger poking
      // at order ids tells them which ids are real.
      return { ok: false, message: 'That order is not waiting for a payment.' };
    }
    if (error instanceof PaymentRailUnavailableError) {
      return {
        ok: false,
        message: 'Paying in advance is switched off right now. Nothing has been charged.',
      };
    }
    throw error;
  }
}
