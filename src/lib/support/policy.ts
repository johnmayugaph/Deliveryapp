import { SupportTicketPriority, SupportTicketStatus } from '@prisma/client';

/**
 * What a support ticket's state means, and when somebody has been left waiting
 * too long.
 *
 * All of it pure, and all of it data rather than branches — for the same reason
 * the service registry is data. "Which states are waiting on us" and "how long
 * is too long" are decisions that change with how many people are answering
 * tickets, not with how the code is shaped.
 *
 * The one number worth arguing about is `SUPPORT_RESPONSE_TARGET_MINUTES`, and
 * it is deliberately not an SLA. Nobody has promised a customer anything. It is
 * the point at which an unanswered ticket becomes visible to whoever is running
 * the business, which is a different and much more useful thing.
 */

export interface StatusPolicy {
  /** For a customer, on their own thread. */
  label: string;
  /** For the console queue, where "open" is ambiguous. */
  queueLabel: string;
  /**
   * Somebody is waiting for us. Drives the queue, the ageing sweep and the
   * count on the overview.
   */
  waitingOnUs: boolean;
  /**
   * The customer may add to the thread. False once closed: a closed ticket
   * takes a new one instead, so a conversation from March does not reopen with
   * an unrelated question and lose its own resolution.
   */
  customerMayReply: boolean;
  /** Done. Not shown in the queue by default. */
  finished: boolean;
}

/**
 * Keyed by EVERY status, so adding one is a compile error until somebody
 * decides whether it means a person is waiting.
 */
export const TICKET_STATUS_POLICY: Readonly<
  Record<SupportTicketStatus, StatusPolicy>
> = {
  [SupportTicketStatus.OPEN]: {
    label: 'Waiting for us',
    queueLabel: 'Needs an answer',
    waitingOnUs: true,
    customerMayReply: true,
    finished: false,
  },
  // A human has asked the customer something. The clock is on them, so this is
  // NOT waiting on us — counting it would make the queue permanently red and
  // teach whoever reads it to ignore the number.
  [SupportTicketStatus.AWAITING_CUSTOMER]: {
    label: 'Waiting for you',
    queueLabel: 'Waiting on the customer',
    waitingOnUs: false,
    customerMayReply: true,
    finished: false,
  },
  [SupportTicketStatus.ESCALATED]: {
    label: 'With a supervisor',
    queueLabel: 'Escalated',
    waitingOnUs: true,
    customerMayReply: true,
    finished: false,
  },
  // Resolved still accepts a reply, and that is the point: "this did not
  // actually fix it" is the most valuable message on the thread, and making
  // somebody open a second ticket to say it is how it gets lost.
  [SupportTicketStatus.RESOLVED]: {
    label: 'Resolved',
    queueLabel: 'Resolved',
    waitingOnUs: false,
    customerMayReply: true,
    finished: true,
  },
  [SupportTicketStatus.CLOSED]: {
    label: 'Closed',
    queueLabel: 'Closed',
    waitingOnUs: false,
    customerMayReply: false,
    finished: true,
  },
};

/** Every status a queue shows unless somebody asks for the finished ones. */
export const QUEUE_STATUSES: readonly SupportTicketStatus[] = (
  Object.keys(TICKET_STATUS_POLICY) as SupportTicketStatus[]
).filter((status) => !TICKET_STATUS_POLICY[status].finished);

/** Every status where somebody is waiting on an answer from us. */
export const WAITING_STATUSES: readonly SupportTicketStatus[] = (
  Object.keys(TICKET_STATUS_POLICY) as SupportTicketStatus[]
).filter((status) => TICKET_STATUS_POLICY[status].waitingOnUs);

export function customerMayReply(status: SupportTicketStatus): boolean {
  return TICKET_STATUS_POLICY[status].customerMayReply;
}

/**
 * Where a thread goes when the customer adds to it.
 *
 * The rule that matters: anything not closed becomes OPEN again. A ticket that
 * was RESOLVED and gets "it is still broken" must return to the queue, and a
 * ticket sitting in AWAITING_CUSTOMER must not stay there once the customer has
 * answered — that is precisely the state in which tickets are forgotten.
 */
export function statusAfterCustomerMessage(
  status: SupportTicketStatus,
): SupportTicketStatus {
  if (!customerMayReply(status)) return status;
  return SupportTicketStatus.OPEN;
}

/**
 * Where a thread goes when support replies.
 *
 * Deliberately conservative: a reply moves OPEN to AWAITING_CUSTOMER, and
 * leaves everything else where it is. Marking something resolved is a
 * judgement an agent makes explicitly, not a side effect of typing — and an
 * escalated ticket that de-escalated itself because somebody sent a holding
 * message is how a hard problem gets dropped.
 */
export function statusAfterSupportMessage(
  status: SupportTicketStatus,
): SupportTicketStatus {
  return status === SupportTicketStatus.OPEN
    ? SupportTicketStatus.AWAITING_CUSTOMER
    : status;
}

// --- Priority ----------------------------------------------------------------

/**
 * What a new ticket starts at.
 *
 * One rule, and it is about time rather than about the vertical: a ticket
 * attached to an order that is happening right now is urgent because the food
 * is in a bag on a motorbike, and the same question about last Tuesday's order
 * is not. Nothing here knows which services exist.
 *
 * URGENT is not reachable from a form on purpose. It exists for a person to
 * set, and a priority a customer can select is a priority every customer
 * selects.
 */
export function priorityForNewTicket(input: {
  /** The related order, if any, is still in flight. */
  aboutLiveOrder: boolean;
}): SupportTicketPriority {
  return input.aboutLiveOrder
    ? SupportTicketPriority.HIGH
    : SupportTicketPriority.NORMAL;
}

/** Highest first, for the queue. */
export const PRIORITY_RANK: Readonly<Record<SupportTicketPriority, number>> = {
  [SupportTicketPriority.URGENT]: 0,
  [SupportTicketPriority.HIGH]: 1,
  [SupportTicketPriority.NORMAL]: 2,
  [SupportTicketPriority.LOW]: 3,
};

// --- Ageing ------------------------------------------------------------------

/**
 * When an unanswered ticket becomes something an administrator is told about
 * again.
 *
 * Two hours, not fifteen minutes: this is one person answering tickets between
 * other work, and an alert that fires before a human could plausibly have got
 * to it is an alert that gets muted. The first alert already went out when the
 * ticket was raised; this is the one that says nobody acted on it.
 */
export const SUPPORT_RESPONSE_TARGET_MINUTES = 120;

/** How long a ticket has been waiting, in whole minutes. */
export function waitingMinutes(input: {
  /** The last thing that happened on the thread. */
  since: Date;
  now: Date;
}): number {
  return Math.max(0, Math.floor((input.now.getTime() - input.since.getTime()) / 60_000));
}

/**
 * Whether a ticket has been waiting long enough to nag about.
 *
 * Answered-then-silent does not count: once a human has replied, the thread is
 * a conversation and the customer is not sitting in front of a screen with no
 * acknowledgement at all. It is that first silence this protects against.
 */
export function needsChasing(input: {
  status: SupportTicketStatus;
  firstRespondedAt: Date | null;
  createdAt: Date;
  now: Date;
  targetMinutes?: number;
}): boolean {
  if (!TICKET_STATUS_POLICY[input.status].waitingOnUs) return false;
  if (input.firstRespondedAt !== null) return false;
  const target = input.targetMinutes ?? SUPPORT_RESPONSE_TARGET_MINUTES;
  return waitingMinutes({ since: input.createdAt, now: input.now }) >= target;
}

/**
 * "3 minutes", "4 hours", "2 days".
 *
 * Coarse on purpose. The question a queue answers is "is this bad", and
 * "1 day 4 hours 11 minutes" makes that harder to see, not easier.
 */
export function describeWait(minutes: number): string {
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

// --- What a person may write -------------------------------------------------

/** Enough to be a sentence. */
export const MIN_MESSAGE_LENGTH = 4;
/**
 * Long enough for somebody to describe what went wrong with an order, short
 * enough that a paste of a whole log does not become a column nobody can read.
 */
export const MAX_MESSAGE_LENGTH = 4000;
export const MAX_SUBJECT_LENGTH = 120;

export class MessageTooShortError extends Error {
  constructor() {
    super('Tell us a little more about what happened.');
    this.name = 'MessageTooShortError';
  }
}

/** Trims, caps, and refuses an empty one. Used on both sides of the thread. */
export function normaliseMessage(raw: unknown): string {
  const body = String(raw ?? '').trim();
  if (body.length < MIN_MESSAGE_LENGTH) throw new MessageTooShortError();
  return body.slice(0, MAX_MESSAGE_LENGTH);
}

/**
 * A subject, derived from the message when somebody did not write one.
 *
 * A required subject field is a form people abandon; a ticket with no subject
 * is a queue row nobody can triage. So the field is optional and this fills it
 * from the first sentence.
 */
export function normaliseSubject(rawSubject: unknown, body: string): string {
  const subject = String(rawSubject ?? '').trim();
  if (subject.length > 0) return subject.slice(0, MAX_SUBJECT_LENGTH);
  const firstLine = body.split('\n')[0]!.trim();
  if (firstLine.length <= MAX_SUBJECT_LENGTH) return firstLine;
  return `${firstLine.slice(0, MAX_SUBJECT_LENGTH - 1).trimEnd()}…`;
}
