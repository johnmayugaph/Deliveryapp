'use server';

import { revalidatePath } from 'next/cache';
import {
  AlreadySubscribedError,
  NoLaunchedPlanError,
  PlanIsFreeError,
  PlanNotLaunchedError,
  NotSubscribedError,
  cancelSubscription,
  enrollInPlan,
} from '@/lib/subscriptions/enrollment';
import {
  InvoiceNotCollectableError,
  InvoiceNotFoundError,
  issueDueInvoiceFor,
  submitInvoiceReference,
} from '@/lib/subscriptions/billing';
import { NoSubscriptionPaymentRailError } from '@/lib/subscriptions/payment';
import { SubscriptionOrigin } from '@prisma/client';
import { requireOnboardedUser } from '@/lib/auth/session';

/**
 * The customer's own side of a subscription: sign up, say you have paid, leave.
 *
 * ### There used to be no `subscribeAction`
 *
 * The comment that stood here said so, and gave the reason: enrolling needed
 * either a payment rail, which did not exist, or a grant, which is deliberately
 * not self-service — "a button that appeared to enroll someone and then failed
 * would be worse than no button". That was right, and it is now out of date,
 * because a rail exists: a transfer the customer makes and a person confirms.
 *
 * The button still cannot appear when there is nowhere to send the money. That
 * check has not been relaxed, it has moved — `enrollInPlan` refuses without a
 * rail, `isPaidEnrollmentAvailable` decides whether `/plus` renders the
 * control at all, and this action handles the refusal in case the environment
 * changes between the render and the tap.
 *
 * ### Signing up and paying are two acts, and the split is the honest part
 *
 * `subscribeAction` does NOT make somebody a subscriber. It creates a
 * PENDING_PAYMENT enrolment and raises the first bill, which confers nothing:
 * the pricing engine requires `status = ACTIVE`, so no benefit exists until a
 * person has confirmed the transfer. That is why the screen says "waiting for
 * payment" rather than "active", and why this action's message names the
 * amount instead of congratulating anybody.
 *
 * Cancelling, as before, is the customer's own decision and needs no approval.
 */

export type SubscriptionActionResult =
  | { ok: true; message: string }
  | { ok: false; message: string };

/**
 * Enrol, and raise the first bill in the same breath.
 *
 * The invoice is issued HERE rather than left to the sweep. The sweep would
 * pick it up within the minute, but a customer who taps Subscribe and is shown
 * a screen with nothing to pay has been given a dead end, and "check back in a
 * moment" is not a payment instruction. `issueDueInvoiceFor` is idempotent on
 * the period, so the sweep finding the same bill a minute later is a no-op
 * rather than a second charge.
 */
export async function subscribeAction(): Promise<SubscriptionActionResult> {
  const user = await requireOnboardedUser();

  try {
    const subscription = await enrollInPlan({
      userId: user.id,
      origin: SubscriptionOrigin.PAID,
    });

    // If this fails the enrolment still stands, and the sweep raises the bill
    // on its next pass — so it is not wrapped in the same transaction as the
    // enrolment. What that costs is a screen that says "waiting for payment"
    // with no amount for up to a minute; what a shared transaction would cost
    // is a signup lost to a reference collision.
    await issueDueInvoiceFor({
      id: subscription.id,
      status: subscription.status,
      origin: subscription.origin,
      renewsAt: subscription.renewsAt,
      startedAt: subscription.startedAt,
      plan: subscription.plan,
    });
  } catch (error) {
    if (error instanceof AlreadySubscribedError) {
      return { ok: false, message: 'You already have a plan.' };
    }
    if (error instanceof NoLaunchedPlanError || error instanceof PlanNotLaunchedError) {
      return { ok: false, message: 'That plan is not open for sign-ups.' };
    }
    if (error instanceof NoSubscriptionPaymentRailError) {
      // The screen checked this before rendering the button, so reaching here
      // means the rail was switched off in between. Nothing has been charged
      // and nothing has been enrolled.
      return {
        ok: false,
        message: 'Sign-ups are closed right now. Nothing has been charged.',
      };
    }
    if (error instanceof PlanIsFreeError) {
      // A ₱0 plan cannot be billed, so it cannot be sold either. Somebody has
      // misconfigured the plan and a customer is reading the consequence.
      return {
        ok: false,
        message: 'This plan cannot be bought right now. Nothing has been charged.',
      };
    }
    throw error;
  }

  revalidatePath('/plus');
  revalidatePath('/profile');
  return {
    ok: true,
    message:
      'You are signed up. Send the transfer below and we will switch your ' +
      'benefits on once we see it.',
  };
}

/**
 * "I have sent it, here is the reference."
 *
 * Records a CLAIM and settles nothing — the same split the order rail makes
 * between a submitted reference and a confirmed payment. Re-submitting is
 * allowed on purpose: the commonest reason to submit twice is having mistyped
 * the number, and refusing the correction would leave the wrong one in
 * somebody's queue.
 */
export async function submitInvoiceReferenceAction(
  _previous: SubscriptionActionResult | null,
  formData: FormData,
): Promise<SubscriptionActionResult> {
  const user = await requireOnboardedUser();
  const invoiceId = String(formData.get('invoiceId') ?? '');
  const reference = String(formData.get('reference') ?? '').slice(0, 240);

  try {
    await submitInvoiceReference({ invoiceId, userId: user.id, reference });
  } catch (error) {
    if (error instanceof InvoiceNotFoundError) {
      // Deliberately vague. The cases are "no such bill" and "not yours", and
      // telling a stranger poking at invoice ids which is which says which
      // ids are real.
      return { ok: false, message: 'That bill is not waiting for a payment.' };
    }
    if (error instanceof InvoiceNotCollectableError) {
      return { ok: false, message: error.message };
    }
    throw error;
  }

  revalidatePath('/plus');
  return {
    ok: true,
    message: 'Got it. We are checking your transfer — this is usually quick.',
  };
}

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
