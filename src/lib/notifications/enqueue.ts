import {
  NotificationChannel,
  NotificationKind,
  type Order,
} from '@prisma/client';
import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import { getService } from '@/lib/services/registry';
import { storeIdFromDetails } from '@/lib/merchant/access';
import {
  KIND_POLICY,
  channelCarries,
  deliverableAt,
  type NotificationAudience,
} from '@/lib/notifications/policy';
import { renderNotification, type NotificationContext } from '@/lib/notifications/templates';
import { notificationForStatus } from '@/lib/notifications/order-events';

/**
 * Putting a message in the outbox.
 *
 * Two properties matter more than anything else here:
 *
 *  - **Enqueueing is part of the transaction that caused it.** An order that
 *    moved to READY_FOR_PICKUP and a notification saying so either both happen
 *    or neither does. The alternative — notify after committing — loses the
 *    message whenever the process dies in between, and those are exactly the
 *    moments somebody is waiting.
 *  - **Enqueueing never breaks the thing that caused it.** A template that
 *    throws must not roll back a delivered order, so the callers wrap this and
 *    swallow. Losing a notification is bad; losing the delivery is worse.
 *
 * Sending is somebody else's job: `deliverPending()` runs from cron. Nothing on
 * a request path waits for an SMS gateway.
 */

export interface EnqueueInput {
  userId: string;
  kind: NotificationKind;
  context: NotificationContext;
  /** Where tapping it goes. An in-app path. */
  href?: string;
  relatedOrderId?: string;
  /**
   * What makes this message unique. Two enqueues with the same key collapse
   * onto one row — a retried transition, a cron that ran twice, two tabs both
   * advancing the same order.
   */
  dedupeKey: string;
  now?: Date;
}

/**
 * Writes one notification and its per-channel deliveries.
 *
 * Returns null when the key already exists, which is a success: somebody has
 * already been told.
 */
export async function enqueueNotification(
  input: EnqueueInput,
  client?: PrismaTransactionClient,
): Promise<{ id: string; channels: NotificationChannel[] } | null> {
  const db = client ?? prisma;
  const now = input.now ?? new Date();
  const policy = KIND_POLICY[input.kind];
  const rendered = renderNotification(input.kind, input.context);

  // Preferences are read per recipient, not per message: one query, and a
  // channel the person switched off becomes a SKIPPED row rather than a
  // silently missing one, so the record still shows what we chose not to send.
  const preferences = await db.notificationPreference.findMany({
    where: { userId: input.userId },
  });
  const preferenceByChannel = new Map(
    preferences.map((row) => [row.channel, row.enabled] as const),
  );

  const deliveries = policy.channels.map((channel) => {
    const carries = channelCarries({
      channel,
      urgency: policy.urgency,
      preference: preferenceByChannel.get(channel),
    });
    return {
      channel,
      status: carries ? ('PENDING' as const) : ('SKIPPED' as const),
      nextAttemptAt: carries
        ? deliverableAt({ urgency: policy.urgency, channel, now })
        : now,
    };
  });

  // Three statements, no exceptions. `skipDuplicates` becomes ON CONFLICT DO
  // NOTHING, which matters because this runs inside the caller's transaction:
  // a unique violation would abort that transaction at the database level, and
  // catching the error in TypeScript would not put it back. A dropped
  // notification must never cost a delivered order.
  const { count } = await db.notification.createMany({
    data: [
      {
        userId: input.userId,
        kind: input.kind,
        urgency: policy.urgency,
        title: rendered.title,
        body: rendered.body,
        smsBody: rendered.sms,
        href: input.href ?? null,
        relatedOrderId: input.relatedOrderId ?? null,
        dedupeKey: input.dedupeKey,
        createdAt: now,
      },
    ],
    skipDuplicates: true,
  });

  if (count === 0) {
    // Somebody has already been told. That is a success.
    return null;
  }

  const notification = await db.notification.findUniqueOrThrow({
    where: { dedupeKey: input.dedupeKey },
    select: { id: true },
  });

  await db.notificationDelivery.createMany({
    data: deliveries.map((delivery) => ({ ...delivery, notificationId: notification.id })),
    skipDuplicates: true,
  });

  return {
    id: notification.id,
    channels: deliveries
      .filter((delivery) => delivery.status === 'PENDING')
      .map((delivery) => delivery.channel),
  };
}

/** Everyone who should hear about something happening to an order. */
export async function resolveOrderAudience(
  order: Pick<Order, 'id' | 'customerId' | 'assignedRiderId' | 'details'>,
  audience: NotificationAudience,
  client?: PrismaTransactionClient,
): Promise<string[]> {
  const db = client ?? prisma;

  if (audience === 'CUSTOMER') {
    return [order.customerId];
  }

  if (audience === 'FLEET_PARTNER') {
    if (!order.assignedRiderId) {
      return [];
    }
    const partner = await db.fleetPartner.findUnique({
      where: { id: order.assignedRiderId },
      select: { userId: true },
    });
    return partner ? [partner.userId] : [];
  }

  // Every member who works the queue, because any of them may be the one
  // holding the phone. A store with three staff should not depend on the owner
  // being awake.
  const storeId = storeIdFromDetails(order.details);
  if (!storeId) {
    return [];
  }
  const members = await db.storeMember.findMany({
    where: { storeId },
    select: { userId: true },
  });
  return members.map((member) => member.userId);
}

/**
 * Raises whatever a status change is worth raising.
 *
 * Called from inside `transitionOrder`'s transaction. Reads the map, resolves
 * each audience, renders per audience — a timeout cancellation says different
 * things to a customer and to a store — and writes the rows.
 */
export async function notifyOrderStatus(
  input: {
    order: Pick<
      Order,
      'id' | 'orderNumber' | 'serviceType' | 'customerId' | 'assignedRiderId' | 'details' | 'status'
    >;
    /** Present for a cancellation: what goes back to the customer. */
    refundedCentavos?: number;
    reason?: string | null;
    storeName?: string;
    now?: Date;
  },
  client?: PrismaTransactionClient,
): Promise<number> {
  const spec = notificationForStatus(input.order.status);
  if (!spec) {
    return 0;
  }

  const service = await getService(input.order.serviceType);
  const storeName = input.storeName ?? (await storeNameFor(input.order.details, client));
  let written = 0;

  for (const [audience, kind] of Object.entries(spec.audiences) as [
    NotificationAudience,
    NotificationKind,
  ][]) {
    const userIds = await resolveOrderAudience(input.order, audience, client);

    for (const userId of userIds) {
      const result = await enqueueNotification(
        {
          userId,
          kind,
          relatedOrderId: input.order.id,
          href: hrefFor(audience, input.order),
          context: {
            serviceName: service.displayName,
            orderNumber: input.order.orderNumber,
            storeName,
            amountCentavos: input.refundedCentavos,
            reason: input.reason ?? undefined,
          },
          // One message per person per status of this order, however many times
          // the transition is attempted.
          dedupeKey: `order-status:${input.order.id}:${input.order.status}:${userId}`,
          now: input.now,
        },
        client,
      );
      if (result) {
        written += 1;
      }
    }
  }

  return written;
}

/**
 * The store's name, for copy that names it.
 *
 * One extra read on the handful of statuses that notify, and only where the
 * vertical has a store at all — PARCEL has none, and that is a null rather than
 * a special case.
 */
async function storeNameFor(
  details: Order['details'],
  client?: PrismaTransactionClient,
): Promise<string | undefined> {
  const storeId = storeIdFromDetails(details);
  if (!storeId) {
    return undefined;
  }
  const store = await (client ?? prisma).store.findUnique({
    where: { id: storeId },
    select: { name: true },
  });
  return store?.name;
}

/** Where a given audience should land when they tap the message. */
function hrefFor(
  audience: NotificationAudience,
  order: Pick<Order, 'id' | 'details'>,
): string {
  if (audience === 'CUSTOMER') {
    return `/orders/${order.id}`;
  }
  if (audience === 'FLEET_PARTNER') {
    return '/fleet/job';
  }
  const storeId = storeIdFromDetails(order.details);
  return storeId ? `/merchant/${storeId}` : '/merchant';
}
