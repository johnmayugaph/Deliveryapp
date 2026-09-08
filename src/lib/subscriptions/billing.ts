import {
  NotificationKind,
  Prisma,
  SubscriptionStatus,
  type SubscriptionInvoice,
} from '@prisma/client';
import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import { generateInvoiceReference } from '@/lib/reference-numbers';
import { withSerializationRetry } from '@/lib/db/serializable';
import { enqueueNotification } from '@/lib/notifications/enqueue';
import {
  addOneMonth,
  firstPeriodFor,
  invoiceState,
  isCollectable,
  manilaDateLabel,
  nextRenewsAt,
  renewalInvoiceIsDue,
  renewalPeriodFor,
} from '@/lib/subscriptions/billing-policy';

/**
 * Raising a bill, taking a claim on it, and settling it.
 *
 * The three writes that move money for a subscription, and the reason the
 * invoice table exists. Each one is either idempotent or a compare-and-set,
 * because all three are reachable from a cron that runs every minute and a
 * button somebody can double-tap.
 */

export class InvoiceNotFoundError extends Error {
  constructor(readonly reference: string) {
    super(`No subscription invoice with reference ${reference}.`);
    this.name = 'InvoiceNotFoundError';
  }
}

export class InvoiceNotCollectableError extends Error {
  constructor(
    readonly reference: string,
    readonly why: string,
  ) {
    super(`Invoice ${reference} cannot be paid: ${why}`);
    this.name = 'InvoiceNotCollectableError';
  }
}

/** How many times to retry a reference collision before giving up. */
const REFERENCE_ATTEMPTS = 5;

// -----------------------------------------------------------------------------
// Raising a bill
// -----------------------------------------------------------------------------

/**
 * Raises the bill for one period, or returns the one already raised.
 *
 * **Idempotent by construction**, which is the whole reason the unique index
 * on `(subscriptionId, periodStart)` exists: this is called from a sweep that
 * runs every minute, and a second call for the same period has to find the
 * existing row rather than bill the customer again. That is not a nicety — a
 * duplicated ₱99 invoice is a customer being asked for money they do not owe,
 * and the recovery is a support conversation and a void.
 *
 * The amount is COPIED from the plan here and never read through the relation
 * afterwards. Raising the plan price changes what future invoices say; it does
 * not change what somebody already owes. The immutability trigger makes that
 * true even against a hand-written UPDATE.
 */
export async function issueInvoice(
  input: {
    subscriptionId: string;
    periodStart: Date;
    periodEnd: Date;
    dueAt: Date;
    amountCentavos: number;
  },
  client?: PrismaTransactionClient,
): Promise<{ invoice: SubscriptionInvoice; alreadyExisted: boolean }> {
  const db = client ?? prisma;

  const existing = await db.subscriptionInvoice.findUnique({
    where: {
      subscriptionId_periodStart: {
        subscriptionId: input.subscriptionId,
        periodStart: input.periodStart,
      },
    },
  });
  if (existing) {
    return { invoice: existing, alreadyExisted: true };
  }

  for (let attempt = 1; attempt <= REFERENCE_ATTEMPTS; attempt += 1) {
    try {
      const invoice = await db.subscriptionInvoice.create({
        data: {
          subscriptionId: input.subscriptionId,
          reference: generateInvoiceReference(input.periodStart),
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          dueAt: input.dueAt,
          amountCentavos: input.amountCentavos,
        },
      });
      return { invoice, alreadyExisted: false };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const target = String(error.meta?.target ?? '');
        // The PERIOD collided: another process raised this bill between the
        // read above and this write. That is the idempotency working, so read
        // its row and hand that back rather than failing a cron.
        if (target.includes('periodStart')) {
          const raced = await db.subscriptionInvoice.findUnique({
            where: {
              subscriptionId_periodStart: {
                subscriptionId: input.subscriptionId,
                periodStart: input.periodStart,
              },
            },
          });
          if (raced) return { invoice: raced, alreadyExisted: true };
        }
        // The REFERENCE collided: a one-in-24-million coincidence. Retry.
        if (target.includes('reference') && attempt < REFERENCE_ATTEMPTS) {
          continue;
        }
      }
      throw error;
    }
  }

  throw new Error('Could not allocate a subscription invoice reference');
}

/**
 * The bill a subscription owes next, raised if it is time.
 *
 * Returns null when there is nothing to raise: a grant (nothing is collected),
 * a cancelled subscription, or a renewal that is not yet inside its lead
 * window.
 */
export async function issueDueInvoiceFor(
  subscription: {
    id: string;
    status: SubscriptionStatus;
    origin: string;
    renewsAt: Date;
    startedAt: Date;
    plan: { monthlyPriceCentavos: number };
  },
  now: Date = new Date(),
  client?: PrismaTransactionClient,
): Promise<{ invoice: SubscriptionInvoice; alreadyExisted: boolean } | null> {
  if (subscription.origin !== 'PAID') return null;
  if (subscription.plan.monthlyPriceCentavos <= 0) return null;

  // A first bill and a renewal bill are different periods computed different
  // ways, and conflating them is how a customer gets billed for a month they
  // are already inside.
  if (subscription.status === SubscriptionStatus.PENDING_PAYMENT) {
    const period = firstPeriodFor(subscription.startedAt, addOneMonth);
    return issueInvoice(
      {
        subscriptionId: subscription.id,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        dueAt: period.dueAt,
        amountCentavos: subscription.plan.monthlyPriceCentavos,
      },
      client,
    );
  }

  if (
    subscription.status !== SubscriptionStatus.ACTIVE &&
    subscription.status !== SubscriptionStatus.PAST_DUE
  ) {
    return null;
  }

  if (!renewalInvoiceIsDue(subscription.renewsAt, now)) return null;

  const period = renewalPeriodFor(subscription.renewsAt, addOneMonth);
  return issueInvoice(
    {
      subscriptionId: subscription.id,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      dueAt: period.dueAt,
      amountCentavos: subscription.plan.monthlyPriceCentavos,
    },
    client,
  );
}

// -----------------------------------------------------------------------------
// The customer's claim
// -----------------------------------------------------------------------------

/**
 * Records that the customer says they have sent the money.
 *
 * This settles nothing. It moves the invoice into `AWAITING_REVIEW` so it
 * appears in somebody's queue, and it is deliberately the customer's own
 * unverified word — the same split `PaymentEvent` makes between
 * CHARGE_SUBMITTED and CHARGE_CONFIRMED for an order.
 *
 * Re-submitting overwrites the previous claim rather than being refused: the
 * commonest reason to submit twice is having mistyped the reference, and
 * refusing the correction would leave the wrong one in the queue.
 */
export async function submitInvoiceReference(
  input: { invoiceId: string; userId: string; reference: string; now?: Date },
): Promise<SubscriptionInvoice> {
  const now = input.now ?? new Date();
  const claimed = input.reference.trim().slice(0, 120);

  if (claimed.length === 0) {
    throw new InvoiceNotCollectableError(
      input.invoiceId,
      'a reference is what makes the transfer findable, so it cannot be blank',
    );
  }

  const invoice = await prisma.subscriptionInvoice.findUnique({
    where: { id: input.invoiceId },
    include: { subscription: { select: { userId: true } } },
  });
  if (!invoice) throw new InvoiceNotFoundError(input.invoiceId);

  // An invoice id is not an authorisation. The one place this would matter is
  // somebody marking another person's bill as paid, which would put it in the
  // review queue and, if an admin confirmed it without looking, give away a
  // month.
  if (invoice.subscription.userId !== input.userId) {
    throw new InvoiceNotFoundError(invoice.reference);
  }

  const state = invoiceState(invoice, now);
  if (!isCollectable(state)) {
    throw new InvoiceNotCollectableError(
      invoice.reference,
      state === 'SETTLED' ? 'it is already paid' : 'it has been cancelled',
    );
  }

  return prisma.subscriptionInvoice.update({
    where: { id: invoice.id },
    data: { submittedAt: now, submittedReference: claimed },
  });
}

// -----------------------------------------------------------------------------
// Settling
// -----------------------------------------------------------------------------

export interface SettlementOutcome {
  invoice: SubscriptionInvoice;
  /** The subscription's new renewal date. */
  renewsAt: Date;
  /** True when this settlement started the subscription rather than extending it. */
  startedTheSubscription: boolean;
}

/**
 * Marks an invoice paid and moves the subscription's term.
 *
 * ### The two things that make it safe
 *
 * **A compare-and-set, not a read-then-write.** The invoice is claimed with
 * `UPDATE ... WHERE "settledAt" IS NULL`, and the affected row count is
 * checked. Two administrators looking at the same review queue is normal, and
 * both tapping Confirm must not advance the term by two months.
 *
 * **One transaction for both writes.** The invoice's settlement and the
 * subscription's new `renewsAt` are the same fact: a settled invoice whose
 * subscription did not move is a customer who paid and got nothing, and the
 * reverse is a month given away. Serializable, because the new term is
 * computed from the current one.
 */
export async function settleInvoice(
  input: {
    invoiceId: string;
    /** The rail that collected it: `manual`, or a provider key. */
    via: string;
    /** What was accepted: the reference an admin checked, or a provider's id. */
    reference: string;
    /** The administrator who confirmed it. Null when a provider did. */
    settledById?: string | null;
    now?: Date;
  },
): Promise<SettlementOutcome> {
  const now = input.now ?? new Date();
  const reference = input.reference.trim().slice(0, 120);

  // A settlement with nothing to point at cannot be reconciled against a
  // statement later, which is the only evidence this rail leaves. The database
  // refuses it too (`subscription_invoice_settlement_is_complete`); this is
  // here so the refusal is a sentence rather than a constraint violation.
  if (reference.length === 0) {
    throw new InvoiceNotCollectableError(
      input.invoiceId,
      'a settlement needs the reference it was matched against — without one ' +
        'nobody can check the month against a statement',
    );
  }

  return withSerializationRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const invoice = await tx.subscriptionInvoice.findUnique({
          where: { id: input.invoiceId },
          include: {
            subscription: { include: { plan: { select: { name: true } } } },
          },
        });
        if (!invoice) throw new InvoiceNotFoundError(input.invoiceId);

        const state = invoiceState(invoice, now);
        if (!isCollectable(state)) {
          throw new InvoiceNotCollectableError(
            invoice.reference,
            state === 'SETTLED'
              ? 'it is already paid, so confirming again would take the same month twice'
              : 'it has been cancelled',
          );
        }

        const { count } = await tx.subscriptionInvoice.updateMany({
          where: { id: invoice.id, settledAt: null, voidedAt: null },
          data: {
            settledAt: now,
            settledVia: input.via,
            settledReference: reference,
            settledById: input.settledById ?? null,
          },
        });
        if (count !== 1) {
          // Somebody confirmed it between the read and this write. Refuse
          // rather than proceeding: the term has already moved.
          throw new InvoiceNotCollectableError(
            invoice.reference,
            'somebody confirmed it while this was being submitted',
          );
        }

        const startedTheSubscription =
          invoice.subscription.status === SubscriptionStatus.PENDING_PAYMENT;

        const renewsAt = nextRenewsAt({
          currentRenewsAt: invoice.subscription.renewsAt,
          settledAt: now,
          addMonth: addOneMonth,
          // A first payment buys a month from the moment it arrives. The
          // subscription's current `renewsAt` is only the payment deadline —
          // see `nextRenewsAt`.
          isFirstPayment: startedTheSubscription,
        });

        await tx.userSubscription.update({
          where: { id: invoice.subscriptionId },
          data: {
            status: SubscriptionStatus.ACTIVE,
            renewsAt,
            // A subscription coming back from PAST_DUE or starting for the
            // first time has not ended. Clearing this matters: the terminal
            // guard keys on it, and a live row with an `endedAt` reads as
            // history to every screen.
            endedAt: null,
            // The paid term starts now for a first payment, so the record
            // should say so rather than keeping the moment they tapped
            // Subscribe.
            ...(startedTheSubscription ? { startedAt: now } : {}),
          },
        });

        // Told inside the transaction, with the transaction's client — the
        // same discipline `confirmPayment` follows for an order. On this rail
        // a person confirms by hand, so the gap between "I have sent it" and
        // any acknowledgement is measured in hours, and silence in that gap
        // is indistinguishable from a lost payment. It goes here rather than
        // in the console action so that a provider webhook settling the same
        // invoice tells the customer too.
        await enqueueNotification(
          {
            userId: invoice.subscription.userId,
            kind: NotificationKind.SUBSCRIPTION_PAYMENT_CONFIRMED,
            href: '/plus',
            context: {
              planName: invoice.subscription.plan.name,
              amountCentavos: invoice.amountCentavos,
              invoiceReference: invoice.reference,
              dueLabel: manilaDateLabel(renewsAt),
            },
            // Keyed to the invoice: settling is a compare-and-set, so this
            // can only succeed once per bill anyway, and a serialization
            // retry replaying it must not send a second message.
            dedupeKey: `subscription-paid:${invoice.id}`,
            now,
          },
          tx,
        );

        const settled = await tx.subscriptionInvoice.findUniqueOrThrow({
          where: { id: invoice.id },
        });

        return { invoice: settled, renewsAt, startedTheSubscription };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

/**
 * Refuses a claimed reference: it did not check out.
 *
 * Clears the submission so the customer can send a corrected one, records why
 * against the invoice, and counts an attempt. It does NOT void the invoice —
 * the money is still owed, and a mistyped reference is not a cancellation.
 */
export async function refuseInvoiceClaim(
  input: { invoiceId: string; reason: string; now?: Date },
): Promise<SubscriptionInvoice> {
  const now = input.now ?? new Date();
  const reason = input.reason.trim();

  if (reason.length === 0) {
    throw new InvoiceNotCollectableError(
      input.invoiceId,
      'a refusal needs a reason — the customer is shown it, and "no" with no ' +
        'reason is unanswerable',
    );
  }

  const invoice = await prisma.subscriptionInvoice.findUnique({
    where: { id: input.invoiceId },
  });
  if (!invoice) throw new InvoiceNotFoundError(input.invoiceId);

  if (invoice.settledAt !== null) {
    throw new InvoiceNotCollectableError(
      invoice.reference,
      'it is already paid; refusing it now would leave the term paid for and ' +
        'the bill outstanding',
    );
  }

  const refused = await prisma.$transaction(async (tx) => {
    const updated = await tx.subscriptionInvoice.update({
      where: { id: invoice.id },
      data: {
        submittedAt: null,
        submittedReference: null,
        attemptCount: { increment: 1 },
        lastAttemptAt: now,
        lastFailureReason: reason.slice(0, 300),
      },
      include: {
        subscription: {
          select: { userId: true, plan: { select: { name: true } } },
        },
      },
    });

    await enqueueNotification(
      {
        userId: updated.subscription.userId,
        kind: NotificationKind.SUBSCRIPTION_PAYMENT_REFUSED,
        href: '/plus',
        context: {
          planName: updated.subscription.plan.name,
          invoiceReference: updated.reference,
          // Verbatim, which is what makes the console's refusal text
          // something a customer reads. A "no" they cannot act on is worse
          // than no answer, because they stop trying.
          reason: reason.slice(0, 300),
        },
        // Keyed to the ATTEMPT, not the invoice: somebody who mistypes twice
        // is told twice, because each refusal is about a different reference.
        dedupeKey: `subscription-refused:${invoice.id}:${updated.attemptCount}`,
        now,
      },
      tx,
    );

    return updated;
  });

  return refused;
}

/**
 * Cancels a bill nobody has paid.
 *
 * For a subscription that was cancelled mid-period, a bill raised in error, or
 * a customer who has been comped instead. Compare-and-sets on `settledAt` so a
 * payment landing at this instant wins rather than being voided out from under
 * somebody who has already sent the money.
 */
export async function voidInvoice(
  input: { invoiceId: string; reason: string; now?: Date },
  client?: PrismaTransactionClient,
): Promise<SubscriptionInvoice> {
  const db = client ?? prisma;
  const now = input.now ?? new Date();
  const reason = input.reason.trim();

  if (reason.length === 0) {
    throw new InvoiceNotCollectableError(
      input.invoiceId,
      'cancelling a bill needs a reason',
    );
  }

  const invoice = await db.subscriptionInvoice.findUnique({
    where: { id: input.invoiceId },
  });
  if (!invoice) throw new InvoiceNotFoundError(input.invoiceId);

  const state = invoiceState(invoice, now);
  if (state === 'SETTLED') {
    throw new InvoiceNotCollectableError(
      invoice.reference,
      'it is already paid, so there is nothing to cancel. Money back is a ' +
        'refund, and there is no refund rail for a subscription',
    );
  }
  if (state === 'VOID') {
    throw new InvoiceNotCollectableError(
      invoice.reference,
      'it is already cancelled',
    );
  }

  const { count } = await db.subscriptionInvoice.updateMany({
    where: { id: invoice.id, settledAt: null, voidedAt: null },
    data: { voidedAt: now, voidReason: reason.slice(0, 300) },
  });
  if (count !== 1) {
    throw new InvoiceNotCollectableError(
      invoice.reference,
      'somebody paid or cancelled it while this was being submitted',
    );
  }

  return db.subscriptionInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
}

/** The bill a customer currently owes, if any. For their own screen. */
export async function outstandingInvoiceFor(
  userId: string,
  now: Date = new Date(),
): Promise<SubscriptionInvoice | null> {
  const invoices = await prisma.subscriptionInvoice.findMany({
    where: {
      subscription: { userId },
      settledAt: null,
      voidedAt: null,
    },
    orderBy: { dueAt: 'asc' },
  });
  // The oldest collectable one. There should be at most one — a period is
  // billed once and the next is not raised until this one's period begins —
  // but taking the oldest is right if a lapse ever leaves two.
  return invoices.find((invoice) => isCollectable(invoiceState(invoice, now))) ?? null;
}
