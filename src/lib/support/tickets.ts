import {
  NotificationKind,
  SupportTicketPriority,
  SupportTicketStatus,
  type Prisma,
  type ServiceKey,
  type SupportTicket,
  type SupportTicketMessage,
} from '@prisma/client';
import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import { getService } from '@/lib/services/registry';
import { getLifecycle } from '@/lib/orders/transitions';
import { generateTicketNumber } from '@/lib/reference-numbers';
import { enqueueNotification } from '@/lib/notifications/enqueue';
import { administratorsToAlert } from '@/lib/monitoring/queries';
import {
  customerMayReply,
  normaliseMessage,
  normaliseSubject,
  priorityForNewTicket,
  statusAfterCustomerMessage,
  statusAfterSupportMessage,
  MAX_SUBJECT_LENGTH,
} from './policy';

/**
 * Unified support.
 *
 * ONE `SupportTicket` model covers every vertical, carrying a `serviceType` and
 * an optional `relatedOrderId`. There is no per-service ticket table and no
 * per-service help flow — a customer with a problem should not have to work out
 * which product they are in.
 *
 * `serviceType` is nullable: an account or app-level problem belongs to no
 * single vertical, and forcing one would make the data lie.
 *
 * TWO PROPERTIES THIS FILE EXISTS TO HOLD.
 *
 * **A ticket nobody can see is not support.** Raising one enqueues a
 * notification to every administrator in the same transaction as the ticket
 * itself, so there is no ordering in which somebody asks for help and nobody
 * is told. The cron sweep then chases the ones still unanswered — see
 * `chaseWaitingTickets` in `orders/maintenance.ts`.
 *
 * **A thread belongs to exactly one customer.** Every read and every write
 * takes the user id and filters on it, rather than fetching by ticket id and
 * checking afterwards: an ownership check that happens after the row is loaded
 * is one somebody later moves, and the ids here are guessable enough to matter.
 */

export class TicketNotFoundError extends Error {
  constructor() {
    super('That conversation could not be found.');
    this.name = 'TicketNotFoundError';
  }
}

export class TicketClosedError extends Error {
  constructor() {
    super(
      'This conversation is closed. Start a new one and we will pick it up ' +
        'from there.',
    );
    this.name = 'TicketClosedError';
  }
}

export interface CreateTicketInput {
  userId: string;
  /** Omit for account/general issues. */
  serviceType?: ServiceKey;
  relatedOrderId?: string;
  categorySlug?: string;
  /** Optional. Derived from the message when blank — see `normaliseSubject`. */
  subject?: string;
  body: string;
}

export async function createSupportTicket(
  input: CreateTicketInput,
): Promise<SupportTicket> {
  // Validate the vertical against the registry when one is given, so a ticket
  // can never point at a service that does not exist.
  if (input.serviceType) {
    await getService(input.serviceType);
  }

  const body = normaliseMessage(input.body);
  const subject = normaliseSubject(input.subject, body);

  // A ticket about an order inherits that order's vertical — the customer
  // should not have to tell us something we already know — and its priority,
  // because an order that is happening right now cannot wait for the queue.
  let serviceType = input.serviceType ?? null;
  let relatedOrderId: string | null = null;
  let aboutLiveOrder = false;

  if (input.relatedOrderId) {
    const order = await prisma.order.findUnique({
      where: { id: input.relatedOrderId },
      select: { id: true, serviceType: true, customerId: true, status: true },
    });
    // Silently dropped rather than rejected when it is not theirs: the id
    // arrives from a form field, and the useful behaviour is a general ticket
    // rather than an error about a record they should not know exists.
    if (order && order.customerId === input.userId) {
      serviceType = order.serviceType;
      relatedOrderId = order.id;
      // Registry-driven: each service declares its own terminal statuses, and
      // nothing here knows which services exist.
      aboutLiveOrder = !getLifecycle(order.serviceType).terminalStatuses.includes(
        order.status,
      );
    }
  }

  const priority = priorityForNewTicket({ aboutLiveOrder });
  const now = new Date();

  const ticket = await prisma.$transaction(async (tx) => {
    const created = await tx.supportTicket.create({
      data: {
        ticketNumber: generateTicketNumber(),
        userId: input.userId,
        serviceType,
        relatedOrderId,
        categorySlug: input.categorySlug ?? null,
        subject,
        body,
        status: SupportTicketStatus.OPEN,
        priority,
        lastMessageAt: now,
      },
    });

    await alertAdministrators(
      {
        ticket: created,
        // "New", not a wait: nobody has had a chance yet, and a first alert
        // that already sounds late is one that stops meaning anything.
        event: 'NEW',
        dedupeKey: `support-new:${created.id}`,
      },
      tx,
    );

    return created;
  });

  return ticket;
}

/**
 * Tells every administrator that somebody is waiting.
 *
 * Takes a transaction client so the alert and the thing it is about commit
 * together. A failure to enqueue rolls the ticket back, which is the right way
 * round: a support system that accepts a message and tells nobody is worse
 * than one that says "try again".
 */
async function alertAdministrators(
  input: {
    ticket: Pick<SupportTicket, 'id' | 'ticketNumber' | 'subject'>;
    /**
     * Which of the three things happened. Carried through to the template
     * rather than inferred there: a customer's reply announced as a new
     * ticket is how an administrator learns to stop reading the title.
     */
    event: 'NEW' | 'CUSTOMER_REPLIED' | 'STILL_WAITING';
    waitLabel?: string;
    dedupeKey: string;
  },
  client?: PrismaTransactionClient,
): Promise<number> {
  const admins = await administratorsToAlert();
  for (const admin of admins) {
    await enqueueNotification(
      {
        userId: admin.id,
        kind: NotificationKind.SUPPORT_TICKET_WAITING,
        context: {
          ticketNumber: input.ticket.ticketNumber,
          ticketSubject: input.ticket.subject.slice(0, MAX_SUBJECT_LENGTH),
          ticketEvent: input.event,
          ...(input.waitLabel === undefined ? {} : { waitLabel: input.waitLabel }),
        },
        href: `/admin/support/${input.ticket.id}`,
        dedupeKey: `${input.dedupeKey}:${admin.id}`,
      },
      client,
    );
  }
  return admins.length;
}

/** Used by the chasing sweep, which is outside the creating transaction. */
export async function alertAdministratorsOfWait(input: {
  ticket: Pick<SupportTicket, 'id' | 'ticketNumber' | 'subject'>;
  waitLabel: string;
}): Promise<number> {
  return alertAdministrators({
    ticket: input.ticket,
    event: 'STILL_WAITING',
    waitLabel: input.waitLabel,
    dedupeKey: `support-waiting:${input.ticket.id}`,
  });
}

// --- Reading -----------------------------------------------------------------

/** A person's tickets, newest first — across every vertical, like the orders list. */
export async function listUserTickets(userId: string): Promise<SupportTicket[]> {
  return prisma.supportTicket.findMany({
    where: { userId },
    orderBy: { lastMessageAt: 'desc' },
    take: 50,
  });
}

export type TicketThread = SupportTicket & {
  messages: (SupportTicketMessage & {
    author: { id: string; fullName: string | null; displayName: string | null } | null;
  })[];
};

/**
 * One thread, for the person it belongs to.
 *
 * `userId` is part of the WHERE, not a check after the fact. Returns null
 * rather than throwing so the caller can render a 404 — telling somebody a
 * ticket exists but is not theirs is telling them something.
 */
export async function getTicketForUser(
  ticketId: string,
  userId: string,
): Promise<TicketThread | null> {
  return prisma.supportTicket.findFirst({
    where: { id: ticketId, userId },
    include: {
      messages: {
        orderBy: { createdAt: 'asc' },
        include: {
          author: { select: { id: true, fullName: true, displayName: true } },
        },
      },
    },
  });
}

/** How many of somebody's own threads are waiting on them. Drives a badge. */
export async function ticketsAwaitingCustomer(userId: string): Promise<number> {
  return prisma.supportTicket.count({
    where: { userId, status: SupportTicketStatus.AWAITING_CUSTOMER },
  });
}

// --- Writing -----------------------------------------------------------------

export interface AddMessageResult {
  message: SupportTicketMessage;
  status: SupportTicketStatus;
}

/**
 * The customer adds to their own thread.
 *
 * Reopens the ticket unless it is closed — see `statusAfterCustomerMessage` for
 * why that is the interesting rule.
 */
export async function addCustomerMessage(input: {
  ticketId: string;
  userId: string;
  body: string;
}): Promise<AddMessageResult> {
  const body = normaliseMessage(input.body);

  const ticket = await prisma.supportTicket.findFirst({
    where: { id: input.ticketId, userId: input.userId },
    select: { id: true, status: true, ticketNumber: true, subject: true },
  });
  if (!ticket) throw new TicketNotFoundError();
  if (!customerMayReply(ticket.status)) throw new TicketClosedError();

  const nextStatus = statusAfterCustomerMessage(ticket.status);
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const message = await tx.supportTicketMessage.create({
      data: {
        ticketId: ticket.id,
        authorUserId: input.userId,
        isFromSupport: false,
        body,
      },
    });

    await tx.supportTicket.update({
      where: { id: ticket.id },
      data: {
        status: nextStatus,
        lastMessageAt: now,
        // Cleared so the chasing sweep can fire again. A customer who has
        // replied to a resolved ticket and heard nothing is waiting exactly as
        // much as one who has never been answered.
        alertedAt: null,
      },
    });

    // Only when the thread came back to us. A message on a ticket already in
    // the queue does not need a second alert — that is what the wait is for.
    if (ticket.status !== SupportTicketStatus.OPEN) {
      await alertAdministrators(
        {
          ticket,
          event: 'CUSTOMER_REPLIED',
          // Keyed on the message, so each new reply is its own alert — two
          // messages a day apart are two things to know about.
          dedupeKey: `support-reopened:${message.id}`,
        },
        tx,
      );
    }

    return { message, status: nextStatus };
  });
}

/**
 * A human answers.
 *
 * Sets `firstRespondedAt` once and never clears it, which is what makes "has
 * anybody replied to this at all" answerable later — the number that actually
 * matters when deciding whether support is working.
 */
export async function addSupportReply(input: {
  ticketId: string;
  agentId: string;
  body: string;
}): Promise<AddMessageResult> {
  const body = normaliseMessage(input.body);

  const ticket = await prisma.supportTicket.findUnique({
    where: { id: input.ticketId },
    select: {
      id: true,
      userId: true,
      status: true,
      ticketNumber: true,
      subject: true,
      firstRespondedAt: true,
      assignedAgentId: true,
    },
  });
  if (!ticket) throw new TicketNotFoundError();

  const nextStatus = statusAfterSupportMessage(ticket.status);
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const message = await tx.supportTicketMessage.create({
      data: {
        ticketId: ticket.id,
        authorUserId: input.agentId,
        isFromSupport: true,
        body,
      },
    });

    await tx.supportTicket.update({
      where: { id: ticket.id },
      data: {
        status: nextStatus,
        lastMessageAt: now,
        ...(ticket.firstRespondedAt === null ? { firstRespondedAt: now } : {}),
        // Whoever answered owns it, unless somebody already does. Assignment
        // by replying rather than by a separate button: an unassigned ticket
        // that has been answered is a ticket two people answer.
        ...(ticket.assignedAgentId === null ? { assignedAgentId: input.agentId } : {}),
      },
    });

    // Never carries the reply text — see the template. Enqueued inside the
    // transaction so an answered ticket and the customer being told about it
    // cannot come apart.
    await enqueueNotification(
      {
        userId: ticket.userId,
        kind: NotificationKind.SUPPORT_REPLY,
        context: {
          ticketNumber: ticket.ticketNumber,
          ticketSubject: ticket.subject,
        },
        href: `/help/tickets/${ticket.id}`,
        dedupeKey: `support-reply:${message.id}`,
      },
      tx,
    );

    return { message, status: nextStatus };
  });
}

/** Takes or hands over a ticket. */
export async function assignTicket(input: {
  ticketId: string;
  agentId: string | null;
}): Promise<void> {
  await prisma.supportTicket.update({
    where: { id: input.ticketId },
    data: { assignedAgentId: input.agentId },
  });
}

/**
 * Moves a ticket's state by hand.
 *
 * The timestamps are set here rather than by a trigger because they are not
 * the same fact: `resolvedAt` is when somebody believed the problem was fixed
 * and `closedAt` is when the conversation ended, and a ticket can be resolved,
 * reopened by a reply, and resolved again.
 */
export async function setTicketStatus(input: {
  ticketId: string;
  status: SupportTicketStatus;
  priority?: SupportTicketPriority;
}): Promise<void> {
  const now = new Date();
  const data: Prisma.SupportTicketUpdateInput = {
    status: input.status,
    ...(input.priority === undefined ? {} : { priority: input.priority }),
  };
  if (input.status === SupportTicketStatus.RESOLVED) data.resolvedAt = now;
  if (input.status === SupportTicketStatus.CLOSED) data.closedAt = now;
  await prisma.supportTicket.update({ where: { id: input.ticketId }, data });
}

// --- The help section --------------------------------------------------------

/**
 * FAQ categories for the help section, driven by the Service registry.
 * Categories for a service that does not exist are dropped rather than rendered
 * as an empty section.
 */
export async function listHelpCategories() {
  const categories = await prisma.faqCategory.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: 'asc' },
    include: { articles: { orderBy: { sortOrder: 'asc' } }, service: true },
  });
  return categories.filter(
    (category) => category.serviceType === null || category.service !== null,
  );
}
