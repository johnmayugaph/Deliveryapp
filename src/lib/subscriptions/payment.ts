/**
 * Where the subscription payment seam used to live.
 *
 * It has moved to `src/lib/subscriptions/rails/`, which is now the same shape
 * as the order payment seam in `lib/payments/rails/` — a directory with a
 * types module, one rail per file, and a resolver that returns null when
 * nothing is configured.
 *
 * ### What changed, and why the old shape had to go
 *
 * The old seam was a single `SubscriptionCharger` with:
 *
 *     charge({ userId, amountCentavos, description })
 *
 * That signature was right about the hard part — refusing to fake a charge —
 * and wrong about three things that would have bitten the moment a provider
 * landed:
 *
 *  1. **No idempotency key.** A retried webhook or a re-run cron would charge
 *     the same month twice. `collect` now takes one, derived from the invoice.
 *  2. **No invoice.** A charge tied to a `userId` and an amount cannot say
 *     which period it paid for, so nothing could be reconciled and a customer
 *     asking "what was this ₱99 for" had no answer. Rails now settle a named
 *     `SubscriptionInvoice`.
 *  3. **No mandate.** The thing that makes billing *recurring* rather than a
 *     payment is a stored, revocable authorisation. The old interface could
 *     not describe one, so "add a gateway here" was a bigger job than it
 *     looked.
 *
 * The refusal it existed to make is still made, in
 * `resolveSubscriptionRail`: an unrecognised `SUBSCRIPTION_PAYMENT_PROVIDER`
 * throws rather than quietly falling back, because a deployment that believes
 * it has automatic billing and has manual billing finds out a month later from
 * a customer.
 *
 * What is NEW is that there is now a rail that works: a transfer the customer
 * makes and a person confirms. It is not recurring — see
 * `ManualSubscriptionRail` for the honest accounting of what that costs — but
 * it means a plan can be sold.
 *
 * This file re-exports so that nothing which already imported from here had to
 * change. Prefer importing from `@/lib/subscriptions/rails` in new code.
 */

export {
  isPaidEnrollmentAvailable,
  resolveSubscriptionRail,
  subscriptionRailStatus,
} from '@/lib/subscriptions/rails';

export type {
  CollectableInvoice,
  CollectionMode,
  PaymentMandate,
  PaymentRequest,
  SettlementResult,
  SettlementSource,
  SubscriptionRail,
  SubscriptionRailEnv,
  SubscriptionRailStatus,
} from '@/lib/subscriptions/rails';

/**
 * Kept because it is the sentence somebody reads when they try to sell a plan
 * with nowhere to send the money, and because the actions layer names it.
 *
 * The message has changed: the old one said no rail could ever bill a monthly
 * fee, which was true when credits were the only alternative to cash. It is
 * not true now — a transfer rail exists and needs three environment
 * variables.
 */
export class NoSubscriptionPaymentRailError extends Error {
  constructor() {
    super(
      'No way to collect a subscription fee is configured, so a paid plan ' +
        'cannot be sold. Set PAYMENT_TRANSFER_LABEL, ' +
        'PAYMENT_TRANSFER_ACCOUNT_NAME and PAYMENT_TRANSFER_ACCOUNT_NUMBER — ' +
        'the same account the checkout transfer uses — and subscribers will be ' +
        'billed by transfer, confirmed by hand. Or grant a COMPED subscription ' +
        'instead, which needs no rail at all.',
    );
    this.name = 'NoSubscriptionPaymentRailError';
  }
}
