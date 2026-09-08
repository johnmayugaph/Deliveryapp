import { PaymentEventType } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { paymentInstructionsFor } from '@/lib/payments/manual';
import type { TransferDetails } from '@/components/orders/PayByTransfer';

/**
 * The payment panel's data, or nothing.
 *
 * A thin wrapper whose whole job is to not throw. `paymentInstructionsFor`
 * raises typed errors — the order is not waiting for a transfer, no rail is
 * configured — and every one of them is a legitimate reason to render no panel
 * rather than a reason to fail a page. An order screen that 500s because a
 * deployment has not set an account number is a worse outcome than a screen
 * with one section missing, especially since the section it would be missing
 * is the one telling somebody how to pay.
 *
 * It also narrows a union to one arm. When a provider rail arrives, `begin()`
 * can return a REDIRECT instead of instructions, and the order screen will
 * need a different component for it — so this returns null for that arm rather
 * than trying to render a URL as a set of bank details.
 */
export async function transferDetailsFor(
  orderId: string,
): Promise<TransferDetails | null> {
  try {
    const start = await paymentInstructionsFor(orderId);
    if (start.kind !== 'INSTRUCTIONS') return null;
    return {
      label: start.label,
      accountName: start.accountName,
      accountNumber: start.accountNumber,
      amountCentavos: start.amountCentavos,
      ourReference: start.ourReference,
    };
  } catch {
    return null;
  }
}

/**
 * The newest reason a payment was refused, for the screen the customer retries
 * on.
 *
 * The reason already reaches them as a notification, and that is not enough.
 * The console demands a reason precisely so somebody can act on it — "check
 * the last four digits" is the whole value — and making them leave the payment
 * form, open their inbox and come back to find out what to change is how a
 * refusal becomes a support ticket instead of a corrected reference.
 *
 * Found in a browser: the order screen showed "We could not match that
 * payment", which is true, generic, and useless.
 */
export async function latestRefusalNote(orderId: string): Promise<string | null> {
  const refusal = await prisma.paymentEvent.findFirst({
    where: { orderId, type: PaymentEventType.CHARGE_REFUSED },
    orderBy: { createdAt: 'desc' },
    select: { note: true },
  });
  return refusal?.note ?? null;
}
