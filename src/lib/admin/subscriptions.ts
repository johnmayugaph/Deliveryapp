import { SubscriptionOrigin, SubscriptionStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  invoiceState,
  isCollectable,
  type InvoiceState,
} from '@/lib/subscriptions/billing-policy';
import { LIVE_SUBSCRIPTION_STATUSES } from '@/lib/subscriptions/enrollment';

/**
 * The console's view of the subscription rail.
 *
 * Two numbers carry this screen, and they are not the same number.
 *
 * **What is billed, and what actually arrived.** Monthly recurring revenue on
 * a card rail is close enough to money that people quote it as though it were.
 * On a rail where the customer has to remember, and a person has to confirm,
 * it is a ceiling — the difference between the two is the collection rate, and
 * it is the only figure that says whether this rail works. A dashboard showing
 * MRR alone would report a healthy subscription business while nobody paid.
 *
 * **How many confirmations this month costs.** One person, per subscriber, per
 * month, forever. At twenty subscribers that is a coffee's worth of attention;
 * at four hundred it is somebody's job, and at that point a provider's
 * percentage is cheaper than the person. The number is on the screen so the
 * decision to stop using this rail is made by looking at it rather than by
 * somebody quietly drowning.
 */

export interface InvoiceRow {
  id: string;
  reference: string;
  amountCentavos: number;
  state: InvoiceState;
  periodStart: Date;
  periodEnd: Date;
  dueAt: Date;
  issuedAt: Date;

  /** The claim: what the customer says they sent, and when they said it. */
  submittedAt: Date | null;
  submittedReference: string | null;
  attemptCount: number;
  lastAttemptAt: Date | null;
  lastFailureReason: string | null;

  settledAt: Date | null;
  settledVia: string | null;
  settledReference: string | null;
  settledByName: string | null;
  voidedAt: Date | null;
  voidReason: string | null;

  subscriptionId: string;
  /** True when paying this is what starts the plan rather than extending it. */
  isFirstBill: boolean;
  planName: string;
  subscriberId: string;
  subscriberName: string | null;
  subscriberPhone: string;
}

export interface SubscriptionOverview {
  /** Unpaid and uncancelled, oldest deadline first. The work queue. */
  outstanding: InvoiceRow[];
  /** Settled or cancelled, newest first. The record. */
  recent: InvoiceRow[];

  /** Of the outstanding ones: somebody has sent money and is waiting. */
  awaitingReviewCount: number;
  /** Of the outstanding ones: past their deadline. */
  overdueCount: number;
  outstandingCentavos: number;

  /**
   * What the live paid subscriptions would bill in a month. A CEILING, not
   * revenue — see the note above.
   */
  mrrCentavos: number;
  /** How many subscriptions that figure is made of, by status. */
  activeCount: number;
  pendingPaymentCount: number;
  pastDueCount: number;
  compedCount: number;

  /** Money actually confirmed this calendar month. */
  collectedThisMonthCentavos: number;
  collectedThisMonthCount: number;

  /**
   * The month's confirmation workload: bills falling due this month, whether
   * or not they have been raised yet, split by what is left to do.
   */
  confirmationsThisMonth: number;
  confirmationsDone: number;
  confirmationsLeft: number;
}

/** First instant of the current calendar month, UTC. */
function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** First instant of next month, UTC. */
function nextMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

const named = (user: { fullName: string | null; displayName: string | null } | null) =>
  user?.displayName ?? user?.fullName ?? null;

type InvoiceWithRelations = Awaited<ReturnType<typeof loadInvoices>>[number];

async function loadInvoices(where: object, orderBy: object, take: number) {
  return prisma.subscriptionInvoice.findMany({
    where,
    orderBy,
    take,
    include: {
      settledBy: { select: { fullName: true, displayName: true } },
      subscription: {
        select: {
          id: true,
          status: true,
          plan: { select: { name: true } },
          user: {
            select: { id: true, fullName: true, displayName: true, phone: true },
          },
        },
      },
    },
  });
}

function toRow(invoice: InvoiceWithRelations, now: Date): InvoiceRow {
  return {
    id: invoice.id,
    reference: invoice.reference,
    amountCentavos: invoice.amountCentavos,
    state: invoiceState(invoice, now),
    periodStart: invoice.periodStart,
    periodEnd: invoice.periodEnd,
    dueAt: invoice.dueAt,
    issuedAt: invoice.issuedAt,

    submittedAt: invoice.submittedAt,
    submittedReference: invoice.submittedReference,
    attemptCount: invoice.attemptCount,
    lastAttemptAt: invoice.lastAttemptAt,
    lastFailureReason: invoice.lastFailureReason,

    settledAt: invoice.settledAt,
    settledVia: invoice.settledVia,
    settledReference: invoice.settledReference,
    settledByName: named(invoice.settledBy),
    voidedAt: invoice.voidedAt,
    voidReason: invoice.voidReason,

    subscriptionId: invoice.subscription.id,
    // The subscription is still waiting for its first payment, so confirming
    // this one starts the plan. Worth showing: it is the invoice where a
    // customer is sitting with no benefits at all, which makes it the one to
    // check first.
    isFirstBill: invoice.subscription.status === SubscriptionStatus.PENDING_PAYMENT,
    planName: invoice.subscription.plan.name,
    subscriberId: invoice.subscription.user.id,
    subscriberName: named(invoice.subscription.user),
    subscriberPhone: invoice.subscription.user.phone,
  };
}

export async function subscriptionOverview(
  now: Date = new Date(),
): Promise<SubscriptionOverview> {
  const from = monthStart(now);
  const to = nextMonthStart(now);

  const [
    outstandingRows,
    recentRows,
    liveSubscriptions,
    collected,
    dueThisMonth,
  ] = await Promise.all([
    loadInvoices(
      { settledAt: null, voidedAt: null },
      // Claimed ones first — there is a customer behind each of those waiting
      // on a person — then by deadline. Ordering by `dueAt` alone would bury
      // a submitted transfer under a stack of bills nobody has paid yet.
      [{ submittedAt: 'desc' }, { dueAt: 'asc' }],
      200,
    ),
    loadInvoices(
      { OR: [{ settledAt: { not: null } }, { voidedAt: { not: null } }] },
      [{ issuedAt: 'desc' }],
      50,
    ),
    prisma.userSubscription.findMany({
      where: { status: { in: [...LIVE_SUBSCRIPTION_STATUSES] } },
      select: {
        status: true,
        origin: true,
        plan: { select: { monthlyPriceCentavos: true } },
      },
    }),
    prisma.subscriptionInvoice.aggregate({
      where: { settledAt: { gte: from, lt: to } },
      _sum: { amountCentavos: true },
      _count: true,
    }),
    // Every bill whose deadline lands in this month, raised or not. Raised
    // ones are invoice rows; unraised ones are live paid subscriptions whose
    // term ends this month, because a renewal's deadline IS its boundary.
    Promise.all([
      prisma.subscriptionInvoice.findMany({
        where: { dueAt: { gte: from, lt: to } },
        select: {
          subscriptionId: true,
          settledAt: true,
          voidedAt: true,
          dueAt: true,
          submittedAt: true,
        },
      }),
      prisma.userSubscription.findMany({
        where: {
          status: { in: [...LIVE_SUBSCRIPTION_STATUSES] },
          origin: SubscriptionOrigin.PAID,
          renewsAt: { gte: from, lt: to },
        },
        select: { id: true },
      }),
    ]),
  ]);

  const outstanding = outstandingRows.map((invoice) => toRow(invoice, now));
  const recent = recentRows.map((invoice) => toRow(invoice, now));

  // A grant is not revenue and must not be counted as any, whatever price its
  // plan carries. `isBillable` says the same thing in the policy module; here
  // it is the origin filter.
  const paid = liveSubscriptions.filter(
    (subscription) => subscription.origin === SubscriptionOrigin.PAID,
  );

  const mrrCentavos = paid
    .filter((subscription) => subscription.status === SubscriptionStatus.ACTIVE)
    .reduce(
      (total, subscription) => total + subscription.plan.monthlyPriceCentavos,
      0,
    );

  const [invoicesDue, unbilled] = dueThisMonth;

  // Union by subscription, because a subscription with a bill already raised
  // appears in both lists and confirming it is one job, not two.
  const withInvoice = new Set(invoicesDue.map((row) => row.subscriptionId));
  const workload = new Set([...withInvoice, ...unbilled.map((row) => row.id)]);
  const confirmationsDone = invoicesDue.filter(
    (row) => row.settledAt !== null || row.voidedAt !== null,
  ).length;

  return {
    outstanding,
    recent,

    awaitingReviewCount: outstanding.filter((row) => row.state === 'AWAITING_REVIEW')
      .length,
    overdueCount: outstanding.filter((row) => row.state === 'OVERDUE').length,
    outstandingCentavos: outstanding
      .filter((row) => isCollectable(row.state))
      .reduce((total, row) => total + row.amountCentavos, 0),

    mrrCentavos,
    activeCount: paid.filter((s) => s.status === SubscriptionStatus.ACTIVE).length,
    pendingPaymentCount: paid.filter(
      (s) => s.status === SubscriptionStatus.PENDING_PAYMENT,
    ).length,
    pastDueCount: paid.filter((s) => s.status === SubscriptionStatus.PAST_DUE).length,
    compedCount: liveSubscriptions.length - paid.length,

    collectedThisMonthCentavos: collected._sum.amountCentavos ?? 0,
    collectedThisMonthCount: collected._count,

    confirmationsThisMonth: workload.size,
    confirmationsDone,
    confirmationsLeft: Math.max(0, workload.size - confirmationsDone),
  };
}
