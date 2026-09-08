'use server';

import { revalidatePath } from 'next/cache';
import { OrderActor, PaymentMethod } from '@prisma/client';
import { requireCurrentUser, requireOnboardedUser } from '@/lib/auth/session';
import {
  placeOrder,
  quoteCheckout,
  type CartLineInput,
  type CheckoutQuote,
} from '@/lib/orders/place-order';
import { cancellationStatusForActor, transitionOrder } from '@/lib/orders/state-machine';
import { settleCancelledOrder } from '@/lib/orders/maintenance';
import { prisma } from '@/lib/prisma';

/**
 * Server actions for checkout.
 *
 * Every one of these resolves the customer from the session rather than from
 * its arguments. A client cannot name whose order it is placing, whose credits
 * it is spending, or whose order it is cancelling.
 */

export interface CheckoutFormInput {
  storeId: string;
  lines: CartLineInput[];
  dropoffAddressId: string;
  paymentMethod: PaymentMethod;
  useCredits: boolean;
  tipCentavos?: number;
  includeCutlery?: boolean;
  merchantNotes?: string;
  /**
   * The surge the screen displayed. A ceiling, never a price — see
   * `CheckoutInput.acceptedSurgeCentavos`. Placement refuses if the market has
   * got busier since, rather than billing more than was shown.
   */
  acceptedSurgeCentavos?: number;
  /** A promo code as typed. Resolved server-side; never a discount. */
  promoCode?: string;
  /**
   * The promo discount the screen displayed. A floor, never a price — see
   * `CheckoutInput.acceptedPromoDiscountCentavos`. Placement refuses if the
   * code can no longer give that much, rather than billing the difference.
   */
  acceptedPromoDiscountCentavos?: number;
}

export type QuoteResult =
  | { ok: true; quote: CheckoutQuote }
  | { ok: false; message: string };

/** Prices a cart for display. Same code path as placement, so no drift. */
export async function quoteCheckoutAction(input: CheckoutFormInput): Promise<QuoteResult> {
  try {
    const user = await requireOnboardedUser();
    const quote = await quoteCheckout({ customerId: user.id, ...input });
    return { ok: true, quote };
  } catch (error) {
    return { ok: false, message: toUserMessage(error) };
  }
}

export type PlaceOrderResult =
  | { ok: true; orderId: string; orderNumber: string }
  | {
      ok: false;
      message: string;
      /**
       * Set when the refusal is one the screen fixes by RE-QUOTING rather than
       * by retrying: the market got busier, or a code ran out while somebody
       * was choosing. Both need the new total shown before another attempt;
       * every other failure needs the message and nothing else.
       */
      code?: 'SURGE_CHANGED' | 'PROMO_INVALID';
    };

export async function placeOrderAction(input: CheckoutFormInput): Promise<PlaceOrderResult> {
  try {
    const user = await requireOnboardedUser();
    const { order } = await placeOrder({ customerId: user.id, ...input });

    revalidatePath('/');
    revalidatePath('/orders');
    revalidatePath('/credits');

    return { ok: true, orderId: order.id, orderNumber: order.orderNumber };
  } catch (error) {
    const message = toUserMessage(error);
    if (error instanceof Error && error.name === 'SurgeChangedError') {
      return { ok: false, message, code: 'SURGE_CHANGED' };
    }
    if (error instanceof Error && error.name === 'PromoNoLongerValidError') {
      return { ok: false, message, code: 'PROMO_INVALID' };
    }
    return { ok: false, message };
  }
}

export type CancelOrderResult = { ok: true; refundedCentavos: number } | { ok: false; message: string };

/**
 * Customer-initiated cancellation.
 *
 * Whether it is allowed at all is the transition map's decision — a food order
 * can be cancelled while the store is deciding or cooking, but not once a
 * partner is carrying it. Any credits spent come back to credits.
 */
export async function cancelOrderAction(
  orderId: string,
  reason: string,
): Promise<CancelOrderResult> {
  try {
    const user = await requireCurrentUser();

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { customerId: true },
    });
    if (!order || order.customerId !== user.id) {
      return { ok: false, message: 'Order not found' };
    }

    const trimmed = reason.trim();
    const refundedCentavos = await prisma.$transaction(async (tx) => {
      await transitionOrder(
        {
          orderId,
          to: cancellationStatusForActor(OrderActor.CUSTOMER),
          actor: OrderActor.CUSTOMER,
          actorUserId: user.id,
          reason: trimmed || 'Cancelled by the customer.',
        },
        tx,
      );
      const settlement = await settleCancelledOrder(
        { orderId, reason: 'Order cancelled' },
        tx,
      );
      return settlement.creditsRefundedCentavos;
    });

    revalidatePath('/orders');
    revalidatePath(`/orders/${orderId}`);
    revalidatePath('/credits');

    return { ok: true, refundedCentavos };
  } catch (error) {
    return { ok: false, message: toUserMessage(error) };
  }
}

/**
 * Turns a domain error into something worth showing a customer.
 *
 * The domain errors are written to be read — "This store delivers within
 * Manila", "Hindi nakasagot ang store" — so named errors pass through. Anything
 * unnamed is logged and replaced, because an internal message is not a
 * customer's problem.
 */
function toUserMessage(error: unknown): string {
  const NAMED_DOMAIN_ERRORS = new Set([
    'EmptyCartError',
    'StoreUnavailableError',
    'UnavailableItemsError',
    'AddressNotUsableError',
    'InsufficientCreditsForPaymentError',
    'InsufficientCreditsError',
    'ServiceNotActiveError',
    'NotAuthenticatedError',
    'OnboardingIncompleteError',
    'NoDeliveryFeeRuleError',
    // "It got busier while you were ordering" — written for the customer, and
    // the message they need in order to know to look at the total again.
    'SurgeChangedError',
    // "That code could not be applied" — a campaign ran out between the quote
    // and the tap. Named for the same reason: the customer needs to know to
    // look at the total again rather than to try the same thing twice.
    'PromoNoLongerValidError',
    'IllegalTransitionError',
    'MissingTransitionReasonError',
    'ServiceDetailsNotImplementedError',
    'RangeError',
  ]);

  if (error instanceof Error && NAMED_DOMAIN_ERRORS.has(error.name)) {
    return error.message;
  }

  console.error('checkout action failed:', error);
  return 'That did not go through. Try again in a moment.';
}
