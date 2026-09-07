/**
 * The seam where a subscription charge would happen.
 *
 * It has no implementations, deliberately. The app's two money rails are
 * cash-on-delivery, which a rider collects against a specific order, and
 * credits, which are rewards we grant and which are spendable on orders only —
 * that constraint is enforced in `src/lib/wallet/ledger.ts`, in SQL triggers,
 * and in tests. Charging ₱99 of granted credits for a subscription would break
 * it, and would be a comp dressed up as revenue besides.
 *
 * So a PAID subscription cannot be created until a real gateway is chosen. The
 * alternative — a stub that records a charge nobody made — is the same failure
 * mode as an SMS "sender" that prints to a console in production: everything
 * reports success and no money arrives.
 *
 * When a provider is picked, it lands here as a `SubscriptionCharger`, and
 * `enrollInPlan` stops refusing PAID.
 */

export interface SubscriptionCharge {
  /** The provider's own reference, for reconciliation. */
  reference: string;
  amountCentavos: number;
  chargedAt: Date;
}

export interface SubscriptionCharger {
  readonly providerName: string;
  charge(input: {
    userId: string;
    amountCentavos: number;
    description: string;
  }): Promise<SubscriptionCharge>;
}

export class NoSubscriptionPaymentRailError extends Error {
  constructor() {
    super(
      'No subscription payment provider is configured, so a PAID subscription ' +
        'cannot be created. The app charges cash on delivery or credits, and ' +
        'credits are spendable on orders only by design — neither can bill a ' +
        'monthly fee. Grant a COMPED or PROMOTIONAL subscription instead, or ' +
        'add a gateway in src/lib/subscriptions/payment.ts.',
    );
    this.name = 'NoSubscriptionPaymentRailError';
  }
}

/** Just the variables charger selection reads. */
export interface SubscriptionPaymentEnv {
  SUBSCRIPTION_PAYMENT_PROVIDER?: string | undefined;
  [key: string]: string | undefined;
}

/**
 * Resolves a charger, or throws.
 *
 * There is no development fallback on purpose: a fake charge in development
 * becomes a fake charge in production the day someone copies the config.
 */
export function resolveSubscriptionCharger(
  env: SubscriptionPaymentEnv = process.env,
): SubscriptionCharger {
  const provider = env.SUBSCRIPTION_PAYMENT_PROVIDER;
  if (provider) {
    throw new Error(
      `SUBSCRIPTION_PAYMENT_PROVIDER is set to "${provider}", but no charger is ` +
        'implemented for it. Add one in src/lib/subscriptions/payment.ts.',
    );
  }
  throw new NoSubscriptionPaymentRailError();
}

/** Whether a paid enrollment could succeed. The plan screen asks before offering it. */
export function isPaidEnrollmentAvailable(
  env: SubscriptionPaymentEnv = process.env,
): boolean {
  try {
    resolveSubscriptionCharger(env);
    return true;
  } catch {
    return false;
  }
}
