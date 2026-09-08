import {
  Prisma,
  SubscriptionOrigin,
  SubscriptionStatus,
  type SubscriptionBenefit,
} from '@prisma/client';
import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import { currentPeriodStart } from '@/lib/pricing/checkout';
import { addOneMonth, firstPeriodFor } from '@/lib/subscriptions/billing-policy';
import { isPaidEnrollmentAvailable } from '@/lib/subscriptions/rails';
import { NoSubscriptionPaymentRailError } from '@/lib/subscriptions/payment';
import { voidInvoice } from '@/lib/subscriptions/billing';

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

/**
 * The three statuses that occupy the one-live-subscription slot.
 *
 * PENDING_PAYMENT is in here and confers nothing, which looks like a
 * contradiction and is not: it holds the slot so that somebody with an
 * unfinished enrolment cannot start a second one and end up with two bills.
 * Kept in step with the partial unique index in `prisma/sql/subscriptions.sql`
 * — a status that is live for one and not the other makes an enrolment
 * unsavable.
 */
export const LIVE_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  SubscriptionStatus.PENDING_PAYMENT,
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.PAST_DUE,
];

/**
 * The statuses that actually confer benefits. Exactly one.
 *
 * Named so the claim is greppable rather than implied by a `where` clause
 * three modules away. `getActiveSubscription` in the pricing engine is the
 * enforcement; this is the statement.
 */
export const BENEFIT_CONFERRING_STATUSES: readonly SubscriptionStatus[] = [
  SubscriptionStatus.ACTIVE,
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
 * Re-exported from `billing-policy.ts`, where it now lives, so that nothing
 * which already imported it from here had to change. It moved because the
 * billing rules need it and they must not import this module: `enrollment.ts`
 * reaches for `prisma`, and a pure rule module that pulls in the database
 * client cannot be read from a client component.
 */
export { addOneMonth } from '@/lib/subscriptions/billing-policy';

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

export class PlanIsFreeError extends Error {
  constructor(planName: string) {
    super(
      `${planName} is priced at nothing, so there is no bill to raise. Set a ` +
        'monthly price, or grant it as a COMPED subscription — a ₱0 invoice is ' +
        'not an invoice.',
    );
    this.name = 'PlanIsFreeError';
  }
}

/**
 * Puts an account on a plan.
 *
 * ### The first period is behind the first payment
 *
 * A PAID enrolment lands in `PENDING_PAYMENT` with `renewsAt` set to the
 * moment the first bill is due — NOT a month out. That is the whole of this
 * change and it is worth being blunt about why.
 *
 * The previous version created the row `ACTIVE` with `renewsAt` a month ahead,
 * which was harmless only because PAID enrolment was refused at the door for
 * want of a gateway. The day a rail landed, that line would have handed a
 * month of free deliveries to anybody who tapped Subscribe and then never
 * paid. It is the same mistake `OrderStatus.PENDING_PAYMENT` exists to
 * prevent for food: a prepaid thing is not a thing until the money arrives.
 *
 * A GRANT still starts ACTIVE immediately with a month on the clock. There is
 * nothing to collect, so there is nothing to wait for.
 */
export async function enrollInPlan(input: EnrollInput) {
  const now = input.now ?? new Date();

  const isGrant = input.origin !== SubscriptionOrigin.PAID;

  // Still refused when there is nowhere to send the money — the check moved
  // to the new rail rather than disappearing. Selling a plan and then being
  // unable to say how to pay for it is worse than not offering it.
  if (!isGrant && !isPaidEnrollmentAvailable()) {
    throw new NoSubscriptionPaymentRailError();
  }
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

  // A ₱0 plan cannot be billed, and an invoice for nothing would fail the
  // amount guard inside a cron rather than here where somebody can read it.
  if (!isGrant && plan.monthlyPriceCentavos <= 0) {
    throw new PlanIsFreeError(plan.name);
  }

  const existing = await liveSubscription(input.userId);
  if (existing) {
    throw new AlreadySubscribedError();
  }

  // A grant starts now and runs a month. A paid enrolment starts when the
  // money arrives, so its term is the payment deadline and `settleInvoice`
  // moves it — see `nextRenewsAt`.
  const firstPeriod = firstPeriodFor(now, addOneMonth);

  try {
    return await prisma.userSubscription.create({
      data: {
        userId: input.userId,
        planId: plan.id,
        status: isGrant
          ? SubscriptionStatus.ACTIVE
          : SubscriptionStatus.PENDING_PAYMENT,
        origin: input.origin,
        grantedByUserId: isGrant ? input.grantedByUserId : null,
        grantNote: isGrant ? input.grantNote?.trim() : null,
        startedAt: now,
        renewsAt: isGrant ? addOneMonth(now) : firstPeriod.dueAt,
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
 * Now, not at the end of the period. That was uncontroversial when every
 * subscription was a grant with nothing paid-for to run down; with a paid rail
 * it is a choice, and it is still this one — a customer who taps "end the
 * plan" and is told benefits stop immediately has been told the truth, which
 * is worth more than the fraction of a month they lose. When a gateway lands
 * and cancellation is expected to run to the boundary, this is where it
 * changes: set `endedAt` to `renewsAt` and relax the `endedAt: null` filter in
 * `getActiveSubscription`.
 *
 * **It also cancels any unpaid bill**, in the same transaction. Without that,
 * cancelling leaves a collectable invoice behind: the customer keeps being
 * asked for a month they no longer have, and confirming a late transfer would
 * flip the row back to ACTIVE — the same resurrection the sweep voids invoices
 * to prevent when a term expires. A CANCELLED row is not in
 * `LIVE_SUBSCRIPTION_STATUSES`, so the sweep never revisits it and this is the
 * only place that can.
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

  const reason = input.reason?.trim();

  const run = async (tx: PrismaTransactionClient) => {
    const cancelled = await tx.userSubscription.update({
      where: { id: existing.id },
      data: {
        status: SubscriptionStatus.CANCELLED,
        cancelledAt: now,
        endedAt: now,
        grantNote: reason ? reason : existing.grantNote,
      },
    });

    const outstanding = await tx.subscriptionInvoice.findMany({
      where: { subscriptionId: existing.id, settledAt: null, voidedAt: null },
      select: { id: true },
    });
    for (const invoice of outstanding) {
      await voidInvoice(
        {
          invoiceId: invoice.id,
          reason: `The plan was cancelled before this was paid${
            reason ? `: ${reason}` : ''
          }`,
          now,
        },
        tx,
      );
    }

    return cancelled;
  };

  // An outer transaction wins: a caller that already has one is cancelling as
  // part of something bigger, and nesting would commit half of it.
  return input.client ? run(input.client) : prisma.$transaction(run);
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
