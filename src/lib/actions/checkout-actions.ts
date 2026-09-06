'use server';

import { revalidatePath } from 'next/cache';
import { OrderActor, PaymentMethod } from '@prisma/client';
import { requireCurrentUser } from '@/lib/auth/session';
import {
  placeOrder,
  quoteCheckout,
  type CartLineInput,
  type CheckoutQuote,
} from '@/lib/orders/place-order';
import { cancellationStatusForActor, transitionOrder } from '@/lib/orders/state-machine';
import { refundOrderCredits } from '@/lib/orders/maintenance';
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
}

export type QuoteResult =
  | { ok: true; quote: CheckoutQuote }
  | { ok: false; message: string };

/** Prices a cart for display. Same code path as placement, so no drift. */
export async function quoteCheckoutAction(input: CheckoutFormInput): Promise<QuoteResult> {
  try {
    const user = await requireCurrentUser();
    const quote = await quoteCheckout({ customerId: user.id, ...input });
    return { ok: true, quote };
  } catch (error) {
    return { ok: false, message: toUserMessage(error) };
  }
}

export type PlaceOrderResult =
  | { ok: true; orderId: string; orderNumber: string }
  | { ok: false; message: string };

export async function placeOrderAction(input: CheckoutFormInput): Promise<PlaceOrderResult> {
  try {
    const user = await requireCurrentUser();
    const { order } = await placeOrder({ customerId: user.id, ...input });

    revalidatePath('/');
    revalidatePath('/orders');
    revalidatePath('/credits');

    return { ok: true, orderId: order.id, orderNumber: order.orderNumber };
  } catch (error) {
    return { ok: false, message: toUserMessage(error) };
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
          reason: trimmed || 'Kinansela ng customer.',
        },
        tx,
      );
      return refundOrderCredits({ orderId, reason: 'Kinansela ang order' }, tx);
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
    'NoDeliveryFeeRuleError',
    'IllegalTransitionError',
    'MissingTransitionReasonError',
    'ServiceDetailsNotImplementedError',
    'RangeError',
  ]);

  if (error instanceof Error && NAMED_DOMAIN_ERRORS.has(error.name)) {
    return error.message;
  }

  console.error('checkout action failed:', error);
  return 'Hindi natuloy. Subukan mo muli maya-maya.';
}
