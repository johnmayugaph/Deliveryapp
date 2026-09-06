import {
  SupportTicketStatus,
  type ServiceKey,
  type SupportTicket,
} from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getService } from '@/lib/services/registry';

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
 */

export interface CreateTicketInput {
  userId: string;
  /** Omit for account/general issues. */
  serviceType?: ServiceKey;
  relatedOrderId?: string;
  categorySlug?: string;
  subject: string;
  body: string;
}

/** Sequential per day, readable over the phone: DA-20260906-0042. */
async function nextTicketNumber(now: Date = new Date()): Promise<string> {
  const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
  const startOfDay = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const countToday = await prisma.supportTicket.count({
    where: { createdAt: { gte: startOfDay } },
  });
  return `DA-${datePart}-${String(countToday + 1).padStart(4, '0')}`;
}

export async function createSupportTicket(input: CreateTicketInput): Promise<SupportTicket> {
  // Validate the vertical against the registry when one is given, so a ticket
  // can never point at a service that does not exist.
  if (input.serviceType) {
    await getService(input.serviceType);
  }

  // A ticket about an order inherits that order's vertical — the customer
  // should not have to tell us something we already know.
  let serviceType = input.serviceType ?? null;
  if (input.relatedOrderId) {
    const order = await prisma.order.findUnique({
      where: { id: input.relatedOrderId },
      select: { serviceType: true, customerId: true },
    });
    if (order && order.customerId === input.userId) {
      serviceType = order.serviceType;
    }
  }

  return prisma.supportTicket.create({
    data: {
      ticketNumber: await nextTicketNumber(),
      userId: input.userId,
      serviceType,
      relatedOrderId: input.relatedOrderId ?? null,
      categorySlug: input.categorySlug ?? null,
      subject: input.subject.trim(),
      body: input.body.trim(),
      status: SupportTicketStatus.OPEN,
    },
  });
}

/** A person's tickets, newest first — across every vertical, like the orders list. */
export async function listUserTickets(userId: string): Promise<SupportTicket[]> {
  return prisma.supportTicket.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
}

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
