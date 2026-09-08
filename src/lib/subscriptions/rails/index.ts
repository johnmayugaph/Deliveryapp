import { ManualSubscriptionRail } from '@/lib/subscriptions/rails/manual-transfer';
import type { SubscriptionRail } from '@/lib/subscriptions/rails/types';

export type {
  CollectableInvoice,
  CollectionMode,
  PaymentMandate,
  PaymentRequest,
  SettlementResult,
  SettlementSource,
  SubscriptionRail,
} from '@/lib/subscriptions/rails/types';
export { SubscriptionRailNotReadyError } from '@/lib/subscriptions/rails/types';
export { ManualSubscriptionRail } from '@/lib/subscriptions/rails/manual-transfer';

/**
 * Choosing how to collect a monthly fee.
 *
 * ### Why there is still no automatic rail
 *
 * Because there is still no provider, and a stub charger is worse than none.
 * That was the original argument in `payment.ts` and it holds: a fake charge
 * reports success, advances the period, and no money arrives — the same
 * failure as an SMS "sender" that prints to a console in production, except
 * the thing that silently does not happen is revenue.
 *
 * What HAS changed is that the seam is now invoice-shaped, so wiring a real
 * provider is implementing one method against a `SubscriptionInvoice` rather
 * than inventing a data model first. See `SubscriptionRail.collect` for what
 * the previous signature got wrong.
 */
export interface SubscriptionRailEnv {
  /**
   * The SAME three variables the order transfer rail reads. Reused
   * deliberately: a deployment that can take a transfer for lunch can take one
   * for a subscription, and asking somebody to configure the same GCash
   * account twice is how the two end up different.
   */
  PAYMENT_TRANSFER_LABEL?: string | undefined;
  PAYMENT_TRANSFER_ACCOUNT_NAME?: string | undefined;
  PAYMENT_TRANSFER_ACCOUNT_NUMBER?: string | undefined;
  /**
   * Set to a provider key once one is implemented. Setting it to anything
   * unrecognised THROWS rather than falling back to the manual rail: a
   * deployment that thinks it has automatic billing and silently has manual
   * billing would discover it a month later, from a customer.
   */
  SUBSCRIPTION_PAYMENT_PROVIDER?: string | undefined;
  [key: string]: string | undefined;
}

const TRANSFER_KEYS = [
  'PAYMENT_TRANSFER_LABEL',
  'PAYMENT_TRANSFER_ACCOUNT_NAME',
  'PAYMENT_TRANSFER_ACCOUNT_NUMBER',
] as const;

export interface SubscriptionRailStatus {
  configured: boolean;
  missing: readonly string[];
  label: string | null;
  mode: 'REQUESTED' | 'AUTHORISED' | null;
  settlement: 'HUMAN' | 'PROVIDER' | null;
  /**
   * True when collecting needs a person to confirm each payment. The health
   * page and the console both say so out loud, because it is the difference
   * between a subscription business and a spreadsheet.
   */
  needsHumanConfirmation: boolean;
}

/**
 * The subscription rail, or null when none is configured.
 *
 * Null is a supported state: the app is fully usable with no plan for sale,
 * and grants (COMPED, PROMOTIONAL) work without any rail at all. So this
 * returns null rather than throwing — the same choice `resolvePaymentRail`
 * makes, and for the same reason. What is NOT supported is a half-filled
 * configuration, which switches the rail off rather than offering a
 * subscription nobody can pay for.
 */
export function resolveSubscriptionRail(
  env: SubscriptionRailEnv = process.env,
): SubscriptionRail | null {
  const provider = env.SUBSCRIPTION_PAYMENT_PROVIDER?.trim();
  if (provider) {
    throw new Error(
      `SUBSCRIPTION_PAYMENT_PROVIDER is set to "${provider}", but no automatic ` +
        'rail is implemented for it. Implement `collect` on a SubscriptionRail ' +
        'in src/lib/subscriptions/rails/, or unset the variable to fall back to ' +
        'the manual transfer rail. It is not defaulted on purpose: a deployment ' +
        'that believes it has automatic billing and quietly has manual billing ' +
        'finds out a month later, from a customer.',
    );
  }

  const label = env.PAYMENT_TRANSFER_LABEL?.trim();
  const accountName = env.PAYMENT_TRANSFER_ACCOUNT_NAME?.trim();
  const accountNumber = env.PAYMENT_TRANSFER_ACCOUNT_NUMBER?.trim();

  if (!label || !accountName || !accountNumber) return null;

  return new ManualSubscriptionRail({ label, accountName, accountNumber });
}

/** Whether a PAID enrolment could be collected. The plan screen asks first. */
export function isPaidEnrollmentAvailable(
  env: SubscriptionRailEnv = process.env,
): boolean {
  try {
    return resolveSubscriptionRail(env) !== null;
  } catch {
    // A misconfigured provider is not an available rail. It throws on resolve
    // so somebody fixes it; it must not read as "yes" here and let an
    // enrolment through to a rail that does not exist.
    return false;
  }
}

export function subscriptionRailStatus(
  env: SubscriptionRailEnv = process.env,
): SubscriptionRailStatus {
  const missing = TRANSFER_KEYS.filter((key) => !env[key]?.trim());
  let rail: SubscriptionRail | null = null;
  try {
    rail = resolveSubscriptionRail(env);
  } catch {
    rail = null;
  }

  return {
    configured: rail !== null,
    missing,
    label: rail?.customerLabel ?? null,
    mode: rail?.mode ?? null,
    settlement: rail?.settlement ?? null,
    needsHumanConfirmation: rail?.settlement === 'HUMAN',
  };
}
