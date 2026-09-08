import type { SubscriptionOrigin, SubscriptionStatus } from '@prisma/client';

/**
 * Subscription billing: the rules, with no database and no clock.
 *
 * ### The idea that removes the hardest problem
 *
 * A bill is issued BEFORE the period it pays for begins — `INVOICE_LEAD_DAYS`
 * ahead of the boundary. That one choice deletes a whole category of
 * difficulty, so it is worth being explicit about what it buys.
 *
 * The alternative is to bill on the boundary and then decide what happens
 * during the window while payment is in flight. Every answer to that is bad:
 * cut the benefits off instantly and a customer whose transfer is an hour
 * behind loses their free delivery; keep them on during a "grace period" and
 * you are handing out the product on an unpaid month, which the rest of this
 * codebase is careful never to do ("a cron that has not run for an hour must
 * not hand out an hour of unpaid benefits").
 *
 * Billing ahead means the customer pays while still inside the month they
 * already paid for. There is no window to decide about. Benefits stop exactly
 * at the boundary if they did not pay, and nobody ever receives an unpaid one.
 *
 * The grace period that survives is a different and smaller thing: how long a
 * lapsed subscription remains RECOVERABLE — able to be paid late and resumed —
 * rather than how long it keeps working. That is `RECOVERY_DAYS` below.
 *
 * Pure: imports nothing but a type.
 */

/**
 * How far ahead of a period a bill goes out.
 *
 * Seven days. Long enough to reach somebody who checks the app weekly and to
 * survive a weekend and a payday; short enough that the amount is still
 * recognisably about next month. It is also longer than the two-day window a
 * first invoice gets, because a renewal is not urgent to anybody and a nagged
 * customer cancels.
 */
export const INVOICE_LEAD_DAYS = 7;

/**
 * How long the FIRST bill gets before an unpaid enrolment is let go.
 *
 * Two days. A first invoice is different from a renewal: the person is
 * standing at the door with nothing yet, so there is no period to protect and
 * no benefit at risk. What this bounds is how long a half-finished signup sits
 * in the one-live-subscription slot blocking a second attempt — which is the
 * real cost of making it longer.
 */
export const FIRST_INVOICE_DUE_HOURS = 48;

/**
 * How long after the due date a lapsed subscription can still be revived by
 * paying.
 *
 * Note what this is NOT: it is not a period during which benefits continue.
 * Benefits stopped at the boundary. This is how long we keep the door open
 * before the enrolment becomes history and re-subscribing means starting over.
 *
 * Five days rather than three, because the rail that works today is a bank
 * transfer somebody makes by hand and then somebody else confirms — a Friday
 * lapse should survive to Monday afternoon with room for the confirmation to
 * be slow.
 */
export const RECOVERY_DAYS = 5;

/**
 * When to remind somebody, in days before the due date.
 *
 * Two reminders, not five. The dunning ladders that send six emails are built
 * for card failures, where the customer has already agreed to pay and the
 * problem is technical. Here the customer has to actively go and transfer
 * money, and a third reminder reads as harassment for a ₱99 optional extra.
 */
export const REMINDER_DAYS_BEFORE_DUE: readonly number[] = [3, 0];

/** Milliseconds in a day, named because the arithmetic below reads better. */
const DAY_MS = 24 * 60 * 60 * 1000;

export function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * DAY_MS);
}

export function addHours(from: Date, hours: number): Date {
  return new Date(from.getTime() + hours * 60 * 60 * 1000);
}

/**
 * One month on, clamped to the length of the target month.
 *
 * A subscription started on 31 January renews on 28 February, not on 3 March.
 * Adding 30 days would drift the billing date earlier every month, which
 * nobody notices until somebody is billed twice in one calendar month.
 *
 * It LIVES here, in the pure module, and `enrollment.ts` re-exports it from
 * here rather than the other way round. The first draft had it the other way
 * and that was a mistake worth naming: `enrollment.ts` imports `prisma`, so
 * re-exporting through it would have dragged the database client into every
 * module that wanted the date arithmetic — including a client component. This
 * codebase has taken a page down that way four times, which is why
 * `src/tests/live-tracking.test.ts` guards the shape and why this module's
 * header claims to import nothing but a type.
 *
 * Same move as `ACTIVE_JOB_STATUSES`: the definition goes to the bottom of the
 * dependency graph and the old home re-exports it, so nothing that already
 * imported it has to change.
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

// -----------------------------------------------------------------------------
// What a bill covers, and when it goes out
// -----------------------------------------------------------------------------

export interface BillingPeriod {
  periodStart: Date;
  periodEnd: Date;
  /** When the money has to be with us. */
  dueAt: Date;
}

/**
 * The period a renewal invoice covers: the one that starts when the current
 * one ends.
 *
 * `dueAt` is the boundary itself, not later. The customer has the lead days to
 * pay, and the deadline is the moment their current month runs out — which is
 * the honest deadline, because that is when the benefits stop.
 */
export function renewalPeriodFor(
  currentRenewsAt: Date,
  addMonth: (from: Date) => Date,
): BillingPeriod {
  return {
    periodStart: currentRenewsAt,
    periodEnd: addMonth(currentRenewsAt),
    dueAt: currentRenewsAt,
  };
}

/**
 * The period a FIRST invoice covers.
 *
 * It starts when they pay, not now — but an invoice has to name a period
 * before anybody has paid, so this names the optimistic one and
 * `nextRenewsAt` corrects it at settlement. See the note there; the honest
 * summary is that the invoice records what was offered and the subscription
 * records what they got.
 */
export function firstPeriodFor(
  now: Date,
  addMonth: (from: Date) => Date,
): BillingPeriod {
  return {
    periodStart: now,
    periodEnd: addMonth(now),
    dueAt: addHours(now, FIRST_INVOICE_DUE_HOURS),
  };
}

/**
 * Whether a renewal invoice should go out yet.
 *
 * True inside the lead window and after it — so a sweep that did not run for
 * a week still issues the bill rather than skipping the period, which is the
 * failure mode of a `now === boundary - 7 days` test.
 */
export function renewalInvoiceIsDue(
  currentRenewsAt: Date,
  now: Date,
): boolean {
  return now.getTime() >= addDays(currentRenewsAt, -INVOICE_LEAD_DAYS).getTime();
}

/**
 * The new `renewsAt` once an invoice is settled.
 *
 * One period from whichever is LATER: the current renewal date, or the moment
 * the money arrived.
 *
 *  - Paid on time (before the boundary): the term is continuous, and the
 *    invoice's stamped period is exactly what they got.
 *  - Paid late (after the boundary): the term starts now, so somebody who
 *    pays three days late gets a full month rather than twenty-seven days.
 *
 * The second case is the one worth choosing deliberately. Billing them for a
 * month and giving them part of it is defensible — the invoice does say the
 * dates — but it means a late payer is quietly charged more per day than a
 * punctual one, and the reason they were late is often that our own
 * confirmation was slow. A full month from payment is the answer that cannot
 * embarrass anybody.
 *
 * ### The first payment is not either of those cases
 *
 * `isFirstPayment` exists because on a brand-new enrolment `currentRenewsAt`
 * is the payment DEADLINE — `FIRST_INVOICE_DUE_HOURS` out — and not a boundary
 * anybody has bought. Taking the later of the two would hand a new subscriber
 * the unused remainder of their own deadline, so somebody who paid within the
 * hour got a month plus two days while somebody who paid at the deadline got a
 * month. Worse, it contradicted the row: settlement sets `startedAt` to the
 * moment the money arrived, so the record said the term began at payment and
 * ended a month after the deadline.
 *
 * Found by a live-database script that asserted "a month from the payment" and
 * got a month and two days.
 */
export function nextRenewsAt(input: {
  currentRenewsAt: Date;
  settledAt: Date;
  addMonth: (from: Date) => Date;
  /** True when this payment STARTS the plan rather than extending it. */
  isFirstPayment?: boolean;
}): Date {
  if (input.isFirstPayment) return input.addMonth(input.settledAt);

  const from =
    input.settledAt.getTime() > input.currentRenewsAt.getTime()
      ? input.settledAt
      : input.currentRenewsAt;
  return input.addMonth(from);
}

// -----------------------------------------------------------------------------
// What state a bill is in
// -----------------------------------------------------------------------------

/**
 * The five states an invoice can be in — derived, never stored.
 *
 * A `status` column beside the timestamps would be a second truth, and the
 * first time it drifted a settled invoice would read as outstanding and be
 * chased. Same discipline as a gift card's status and a wallet's balance.
 */
export type InvoiceState =
  | 'OPEN'
  | 'AWAITING_REVIEW'
  | 'OVERDUE'
  | 'SETTLED'
  | 'VOID';

/** Just the columns the state depends on. Structural, so a row passes in. */
export interface InvoiceTimestamps {
  dueAt: Date;
  submittedAt: Date | null;
  settledAt: Date | null;
  voidedAt: Date | null;
}

/**
 * A total function from four timestamps and a clock to one state.
 *
 * The branch order is the content:
 *
 *  - **Settled wins over everything.** Money arrived; nothing later can
 *    un-arrive it.
 *  - **Void next.** The database refuses an invoice that is both
 *    (`subscription_invoice_not_settled_and_void`), so this only decides what
 *    to say about data that cannot exist.
 *  - **AWAITING_REVIEW beats OVERDUE.** This one matters for a human reason:
 *    somebody who has sent the money and is waiting on us must not be shown
 *    "overdue". They did their part. It is our queue that is behind, and the
 *    console's review list is keyed on this state.
 *  - **OVERDUE, then OPEN.**
 */
export function invoiceState(
  invoice: InvoiceTimestamps,
  now: Date = new Date(),
): InvoiceState {
  if (invoice.settledAt !== null) return 'SETTLED';
  if (invoice.voidedAt !== null) return 'VOID';
  if (invoice.submittedAt !== null) return 'AWAITING_REVIEW';
  if (now.getTime() >= invoice.dueAt.getTime()) return 'OVERDUE';
  return 'OPEN';
}

/** Whether this invoice is still money we expect to receive. */
export function isCollectable(state: InvoiceState): boolean {
  return state === 'OPEN' || state === 'AWAITING_REVIEW' || state === 'OVERDUE';
}

/**
 * "12 September" — a date, not "in 7 days".
 *
 * Lives here because three things render it: the bill notification, the
 * confirmation notification, and the customer's own screen. A relative label
 * is wrong the moment a notification sits unread, and the whole point of
 * billing a week ahead is that the message is read late and is still useful.
 * Manila time, like every other timestamp a customer sees.
 */
export function manilaDateLabel(at: Date): string {
  return at.toLocaleDateString('en-PH', {
    timeZone: 'Asia/Manila',
    day: 'numeric',
    month: 'long',
  });
}

/**
 * What the customer reads about each state.
 *
 * Compile-enforced over the union, so a new state cannot ship without a
 * sentence.
 */
export const INVOICE_STATE_TEXT: Readonly<Record<InvoiceState, string>> = {
  OPEN: 'Due soon',
  AWAITING_REVIEW: 'We are checking your transfer',
  OVERDUE: 'Overdue',
  SETTLED: 'Paid',
  VOID: 'Cancelled',
};

/**
 * The same five states, read from the other side of the counter.
 *
 * There are two maps because the customer's sentences address the customer:
 * "We are checking your transfer" is exactly right on `/plus` and exactly
 * wrong in the console, where the person reading it is the one doing the
 * checking — it tells them somebody else is on it. A screen that speaks to an
 * operator in the customer's voice is how a queue gets ignored.
 *
 * Compile-enforced over the union like its sibling, so a new state cannot ship
 * with a sentence for only one of the two audiences.
 */
export const INVOICE_STATE_CONSOLE_TEXT: Readonly<Record<InvoiceState, string>> = {
  OPEN: 'Not paid yet',
  AWAITING_REVIEW: 'Says they have paid',
  OVERDUE: 'Overdue',
  SETTLED: 'Paid',
  VOID: 'Cancelled',
};

// -----------------------------------------------------------------------------
// What happens to a subscription whose bill went unpaid
// -----------------------------------------------------------------------------

/**
 * Whether an origin gets billed at all.
 *
 * Read from `origin` rather than from the presence of a grantor, because the
 * two are kept in step by a database constraint
 * (`user_subscription_paid_is_not_granted`) and `origin` is the one the
 * product decision is written in.
 */
export function isBillable(origin: SubscriptionOrigin): boolean {
  return origin === 'PAID';
}

export type LapseDecision =
  /** Nothing to do yet. */
  | { action: 'HOLD'; reason: string }
  /** The term ran out unpaid: stop conferring, keep the door open. */
  | { action: 'LAPSE'; reason: string }
  /** Past recovery: this enrolment is history. */
  | { action: 'END'; reason: string };

/**
 * What to do with a subscription whose period has run out.
 *
 * Deliberately does NOT decide anything about benefits. Benefits are gated by
 * `getActiveSubscription`, which requires ACTIVE and `renewsAt > now`, so a
 * subscription stops conferring the instant its term ends whether or not this
 * has run. That ordering is load-bearing: this function tidies a record, it is
 * not the thing standing between a customer and a free delivery.
 */
export function decideLapse(input: {
  status: SubscriptionStatus;
  origin: SubscriptionOrigin;
  renewsAt: Date;
  /** Whether a collectable invoice still exists for the period just ended. */
  hasCollectableInvoice: boolean;
  now: Date;
}): LapseDecision {
  if (input.now.getTime() < input.renewsAt.getTime()) {
    return { action: 'HOLD', reason: 'The term has not run out.' };
  }

  // An enrolment nobody paid for gets NO recovery window, unlike a lapsed
  // renewal. There is nothing to recover: no period was ever bought, no
  // benefit was ever conferred, and the only thing the row is doing is
  // occupying the one-live slot and blocking a second attempt. Letting it go
  // promptly is the kinder outcome — they can subscribe again.
  if (input.status === 'PENDING_PAYMENT') {
    return {
      action: 'END',
      reason: 'The first payment never arrived, so the enrolment was let go.',
    };
  }

  if (!isBillable(input.origin)) {
    // A grant does not renew itself. Giving somebody a second free month is a
    // decision to make on purpose, the same way approving a fleet partner for
    // a second service is.
    return {
      action: 'END',
      reason: 'A granted subscription ends at its term; re-granting is deliberate.',
    };
  }

  const recoveryEndsAt = addDays(input.renewsAt, RECOVERY_DAYS);
  if (input.now.getTime() >= recoveryEndsAt.getTime()) {
    return {
      action: 'END',
      reason: `Unpaid for more than ${RECOVERY_DAYS} days after the term ended.`,
    };
  }

  if (!input.hasCollectableInvoice) {
    // The term ended, nothing is outstanding, and nothing new was raised.
    // That means the subscription was cancelled or the bill was voided — there
    // is nothing left to collect, so waiting out the recovery window would
    // just leave a dead row looking live.
    return {
      action: 'END',
      reason: 'The term ended with nothing outstanding to collect.',
    };
  }

  return {
    action: 'LAPSE',
    reason: 'The term ended with the bill unpaid. Paying it still restores the plan.',
  };
}
