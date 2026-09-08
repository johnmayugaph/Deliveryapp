import { ManualTransferRail } from '@/lib/payments/rails/manual-transfer';
import type { PaymentRail } from '@/lib/payments/rails/types';

export type {
  ConfirmationSource,
  HostedRedirect,
  PaymentRail,
  PaymentStart,
  TransferInstructions,
} from '@/lib/payments/rails/types';
export { PaymentRailNotReadyError } from '@/lib/payments/rails/types';
export { ManualTransferRail } from '@/lib/payments/rails/manual-transfer';

/** Just the variables rail selection reads. */
export interface PaymentEnv {
  /**
   * All three or none. A checkout that offers a transfer without an account to
   * send it to takes an order nobody can pay, so a half-filled configuration
   * switches the rail OFF rather than guessing — the same rule the CAPTCHA and
   * the email provider follow, for the same reason.
   */
  PAYMENT_TRANSFER_LABEL?: string | undefined;
  PAYMENT_TRANSFER_ACCOUNT_NAME?: string | undefined;
  PAYMENT_TRANSFER_ACCOUNT_NUMBER?: string | undefined;
  [key: string]: string | undefined;
}

/** What is missing, for the health page to say out loud. */
export interface PaymentRailStatus {
  configured: boolean;
  missing: readonly string[];
  label: string | null;
  confirmation: 'HUMAN' | 'PROVIDER' | null;
}

const TRANSFER_KEYS = [
  'PAYMENT_TRANSFER_LABEL',
  'PAYMENT_TRANSFER_ACCOUNT_NAME',
  'PAYMENT_TRANSFER_ACCOUNT_NUMBER',
] as const;

/**
 * The prepaid rail, or null when none is configured.
 *
 * Null is a supported state, not a failure: cash on delivery works with no
 * configuration at all and is what this app runs on today. Prepayment is
 * something a deployment turns on when it has an account to receive it, and
 * until then the method is simply not offered — never offered-and-broken.
 *
 * Deliberately unlike `resolveSmsSender`, which throws in production. There,
 * nothing works without a gateway: no SMS means nobody can log in, so failing
 * loudly is the only honest option. Here the app is fully usable without a
 * prepaid rail, so refusing to boot over it would be theatre.
 */
export function resolvePaymentRail(env: PaymentEnv = process.env): PaymentRail | null {
  const label = env.PAYMENT_TRANSFER_LABEL?.trim();
  const accountName = env.PAYMENT_TRANSFER_ACCOUNT_NAME?.trim();
  const accountNumber = env.PAYMENT_TRANSFER_ACCOUNT_NUMBER?.trim();

  if (!label || !accountName || !accountNumber) return null;

  return new ManualTransferRail({ label, accountName, accountNumber });
}

export function paymentRailStatus(env: PaymentEnv = process.env): PaymentRailStatus {
  const missing = TRANSFER_KEYS.filter((key) => !env[key]?.trim());
  const rail = resolvePaymentRail(env);

  return {
    configured: rail !== null,
    missing,
    label: rail?.customerLabel ?? null,
    confirmation: rail?.confirmation ?? null,
  };
}
