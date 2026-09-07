'use server';

import { revalidatePath } from 'next/cache';
import { cancelSubscription, NotSubscribedError } from '@/lib/subscriptions/enrollment';
import { requireOnboardedUser } from '@/lib/auth/session';

/**
 * Subscription actions.
 *
 * There is no `subscribeAction`. Enrolling requires either a payment rail,
 * which does not exist yet, or a grant, which is deliberately not self-service
 * — see `src/lib/subscriptions/payment.ts` and `npm run plan:comp`. A button
 * that appeared to enroll someone and then failed would be worse than no
 * button.
 *
 * Cancelling, on the other hand, is always the customer's own decision and
 * needs no approval from anybody.
 */
export async function cancelSubscriptionAction(): Promise<{ error?: string }> {
  const user = await requireOnboardedUser();

  try {
    await cancelSubscription({ userId: user.id, reason: 'Cancelled by the customer' });
  } catch (error) {
    if (error instanceof NotSubscribedError) {
      return { error: 'You have no active plan.' };
    }
    throw error;
  }

  revalidatePath('/plus');
  revalidatePath('/profile');
  return {};
}
