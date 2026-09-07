import {
  Prisma,
  SubscriptionOrigin,
  SubscriptionStatus,
  type SubscriptionBenefit,
} from '@prisma/client';
import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import { currentPeriodStart } from '@/lib/pricing/checkout';
import {
  NoSubscriptionPaymentRailError,
  isPaidEnrollmentAvailable,
} from '@/lib/subscriptions/payment';

/**
 * Getting onto a plan, and off it.
 *
 * Three rules hold:
 *
 *  - **An inactive plan enrolls nobody.** `SubscriptionPlan.isActive` is the
 *    launch switch and it gates here as well as in the pricing engine, so the
 *    seeded plan is safe to leave in the database indefinitely.
 *  - **One live subscription per person.** Checked here for a good error
 *    message and enforced by a partial unique index, because a double-clicked
 *    button beats any check-then-write.
 *  - **A grant names its grantor.** COMPED and PROMOTIONAL subscriptions are
 *    revenue we choose not to collect; an unattributed one is how a comp list
 *    grows until nobody can say who is on it.
 */

/** ACTIVE and PAST_DUE both occupy the one-live-subscription slot. */
export const LIVE_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.PAST_DUE,
];

export class PlanNotLaunchedError extends Error {
  constructor(planName: string) {
    super(
      `${planName} is not active, so nobody can be enrolled in it. Launching is ` +
        'one flag: npm run plan:activate -- <slug>.',
    );
    this.name = 'PlanNotLaunchedError';
  }
}

export class NoLaunchedPlanError extends Error {
  constructor() {
    super(
      'No subscription plan is live. Launch one first: npm run plan:activate ' +
        '-- <slug>.',
    );
    this.name = 'NoLaunchedPlanError';
  }
}

export class AlreadySubscribedError extends Error {
  constructor() {
    super('This account already holds a live subscription.');
    this.name = 'AlreadySubscribedError';
  }
}

export class GrantNeedsAttributionError extends Error {
  constructor() {
    super(
      'A COMPED or PROMOTIONAL subscription needs a grantedByUserId and a note ' +
        'saying why it was given.',
    );
    this.name = 'GrantNeedsAttributionError';
  }
}

export class NotSubscribedError extends Error {
  constructor() {
    super('This account has no live subscription to cancel.');
    this.name = 'NotSubscribedError';
  }
}

/**
 * One month on, clamped to the length of the target month.
 *
 * A subscription started on 31 January renews on 28 February, not on 3 March.
 * Adding 30 days instead would drift the billing date earlier every month,
 * which is the kind of thing nobody notices until a customer is charged twice
 * in one calendar month.
 */
export function addOneMonth(from: Date): Date {
  const day = from.getUTCDate();
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth();
  const lastDayOfTargetMonth = new Date(Date.UTC(year, month + 2, 0)).getUTCDate();

  return new Date(
    Date.UTC(
      year,
      month + 1,
      Math.min(day, lastDayOfTargetMonth),
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
      from.getUTCMilliseconds(),
    ),
  );
}

/**
 * The subscription occupying this account's one live slot, if any.
 *
 * Deliberately NOT the same question as `getActiveSubscription` in the pricing
 * engine, which asks "does this order get benefits" and therefore also requires
 * the plan to still be active and the period not to have lapsed. This one asks
 * "is this person enrolled", which is what the screens and the enrollment rules
 * need.
 */
export async function liveSubscription(userId: string) {
  return prisma.userSubscription.findFirst({
    where: { userId, status: { in: [...LIVE_SUBSCRIPTION_STATUSES] } },
    include: { plan: { include: { benefits: { orderBy: { sortOrder: 'asc' } } } } },
  });
}

export interface EnrollInput {
  userId: string;
  /** Defaults to the launched plan. */
  planId?: string;
  origin: SubscriptionOrigin;
  /** Required for COMPED and PROMOTIONAL. */
  grantedByUserId?: string;
  grantNote?: string;
  now?: Date;
}

/**
 * Puts an account on a plan.
 *
 * PAID is refused while no payment provider is configured — see
 * `payment.ts` for why a stub is worse than a refusal.
 */
export async function enrollInPlan(input: EnrollInput) {
  const now = input.now ?? new Date();

  if (input.origin === SubscriptionOrigin.PAID && !isPaidEnrollmentAvailable()) {
    throw new NoSubscriptionPaymentRailError();
  }

  const isGrant = input.origin !== SubscriptionOrigin.PAID;
  if (isGrant && (!input.grantedByUserId || !input.grantNote?.trim())) {
    throw new GrantNeedsAttributionError();
  }

  const plan = input.planId
    ? await prisma.subscriptionPlan.findUniqueOrThrow({ where: { id: input.planId } })
    : await prisma.subscriptionPlan.findFirst({
        where: { isActive: true },
        orderBy: { sortOrder: 'asc' },
      });

  if (!plan) {
    throw new NoLaunchedPlanError();
  }
  if (!plan.isActive) {
    throw new PlanNotLaunchedError(plan.name);
  }

  const existing = await liveSubscription(input.userId);
  if (existing) {
    throw new AlreadySubscribedError();
  }

  try {
    return await prisma.userSubscription.create({
      data: {
        userId: input.userId,
        planId: plan.id,
        status: SubscriptionStatus.ACTIVE,
        origin: input.origin,
        grantedByUserId: isGrant ? input.grantedByUserId : null,
        grantNote: isGrant ? input.grantNote?.trim() : null,
        startedAt: now,
        renewsAt: addOneMonth(now),
      },
      include: { plan: { include: { benefits: true } } },
    });
  } catch (error) {
    // The partial unique index is the real guard; two clicks arriving together
    // both pass the check above and one of them lands here.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new AlreadySubscribedError();
    }
    throw error;
  }
}

/**
 * Ends a subscription now.
 *
 * Now, not at the end of the period: every subscription that exists today is a
 * grant, so there is nothing paid-for to run down. When a gateway lands, a paid
 * cancellation should keep its benefits until `renewsAt` — which means setting
 * `endedAt` to `renewsAt` here and relaxing the `endedAt: null` filter in
 * `getActiveSubscription`. Both are named so the change is one search away.
 */
export async function cancelSubscription(input: {
  userId: string;
  reason?: string;
  now?: Date;
  client?: PrismaTransactionClient;
}) {
  const db = input.client ?? prisma;
  const now = input.now ?? new Date();

  const existing = await db.userSubscription.findFirst({
    where: { userId: input.userId, status: { in: [...LIVE_SUBSCRIPTION_STATUSES] } },
  });
  if (!existing) {
    throw new NotSubscribedError();
  }

  return db.userSubscription.update({
    where: { id: existing.id },
    data: {
      status: SubscriptionStatus.CANCELLED,
      cancelledAt: now,
      endedAt: now,
      grantNote: input.reason?.trim() ? input.reason.trim() : existing.grantNote,
    },
  });
}

export interface BenefitUsageLine {
  benefit: SubscriptionBenefit;
  usageCount: number;
  creditedCentavos: number;
  discountedCentavos: number;
  /** Null when the benefit has no monthly cap. */
  remainingUses: number | null;
  /** Null when the benefit has no monthly ceiling. */
  remainingCreditCentavos: number | null;
}

/**
 * What this month's benefits have actually delivered.
 *
 * Reads the same `SubscriptionBenefitUsage` rows the pricing engine writes and
 * compares them against the same caps, so the number on the screen is the
 * number checkout will enforce — not a second calculation that can disagree.
 */
export async function monthToDateUsage(
  subscription: { id: string; plan: { benefits: SubscriptionBenefit[] } },
  now: Date = new Date(),
): Promise<BenefitUsageLine[]> {
  const periodStart = currentPeriodStart(now);
  const rows = await prisma.subscriptionBenefitUsage.findMany({
    where: { userSubscriptionId: subscription.id, periodStart },
  });
  const byBenefitId = new Map(rows.map((row) => [row.benefitId, row]));

  return subscription.plan.benefits.map((benefit) => {
    const row = byBenefitId.get(benefit.id);
    const usageCount = row?.usageCount ?? 0;
    const creditedCentavos = row?.creditedCentavos ?? 0;

    return {
      benefit,
      usageCount,
      creditedCentavos,
      discountedCentavos: row?.discountedCentavos ?? 0,
      remainingUses:
        benefit.monthlyUsageCap === null
          ? null
          : Math.max(0, benefit.monthlyUsageCap - usageCount),
      remainingCreditCentavos:
        benefit.monthlyCeilingCentavos === null
          ? null
          : Math.max(0, benefit.monthlyCeilingCentavos - creditedCentavos),
    };
  });
}
