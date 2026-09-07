'use server';

import { revalidatePath } from 'next/cache';
import { getCurrentUser } from '@/lib/auth/session';
import {
  NothingRatedError,
  OrderNotFoundError,
  OrderNotReviewableError,
  submitReview,
} from '@/lib/ratings/reviews';

/**
 * Rating an order.
 *
 * Its own module, and no audit row: a customer rating their own dinner is not
 * a privileged action. What it IS, though, is a write that moves a number
 * dispatch ranking scores on, so everything about who may do it lives one
 * layer down in `lib/ratings/reviews.ts` — the order is fetched with the
 * signed-in id in the WHERE, the window is checked there, and a score for a
 * subject the order does not have is dropped there.
 *
 * Nothing here trusts the form for anything except the values being rated.
 */

export interface ReviewActionResult {
  ok: boolean;
  message: string;
}

export async function submitReviewAction(
  _previous: ReviewActionResult | null,
  formData: FormData,
): Promise<ReviewActionResult> {
  const user = await getCurrentUser();
  if (!user) {
    return { ok: false, message: 'Sign in again and your rating will be saved.' };
  }

  const orderId = String(formData.get('orderId') ?? '').trim();

  try {
    await submitReview({
      orderId,
      userId: user.id,
      storeStars: formData.get('storeStars'),
      partnerStars: formData.get('partnerStars'),
      comment: formData.get('comment'),
    });
  } catch (error) {
    if (
      error instanceof NothingRatedError ||
      error instanceof OrderNotReviewableError ||
      error instanceof OrderNotFoundError
    ) {
      return { ok: false, message: error.message };
    }
    throw error;
  }

  // The order screen, the list that prompts for unrated ones, and the shop's
  // public page — whose star count just changed.
  revalidatePath(`/orders/${orderId}`);
  revalidatePath('/orders');
  revalidatePath('/');
  return {
    ok: true,
    message: 'Thank you. Your comment goes to the shop and to us, not onto their page.',
  };
}
