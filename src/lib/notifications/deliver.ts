import {
  NotificationChannel,
  NotificationDeliveryStatus,
} from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  MAX_DELIVERY_ATTEMPTS,
  retryDelayMs,
} from '@/lib/notifications/policy';
import { resolveChannels } from '@/lib/notifications/channels';

/**
 * The delivery pass.
 *
 * Runs from `npm run jobs:orders` alongside the order timeouts, for the same
 * reason dispatch does: there is no background worker, and a request must never
 * wait on an SMS gateway. How quickly a store hears about an order is bounded
 * by how often the cron runs — a real limitation, written down rather than
 * hidden.
 *
 * Everything here is idempotent and bounded: a batch at a time, three attempts
 * per delivery, and a row that has been sent is never picked up again.
 */

export interface DeliveryPassResult {
  sent: number;
  failed: number;
  retrying: number;
  /** Channels a message was waiting for that have no adapter configured. */
  unconfigured: NotificationChannel[];
}

export async function deliverPending(
  options: { now?: Date; limit?: number } = {},
): Promise<DeliveryPassResult> {
  const now = options.now ?? new Date();
  const adapters = resolveChannels();

  const due = await prisma.notificationDelivery.findMany({
    where: {
      status: NotificationDeliveryStatus.PENDING,
      nextAttemptAt: { lte: now },
    },
    orderBy: { nextAttemptAt: 'asc' },
    take: options.limit ?? 100,
    include: {
      notification: {
        include: { user: { select: { phone: true } } },
      },
    },
  });

  const result: DeliveryPassResult = {
    sent: 0,
    failed: 0,
    retrying: 0,
    unconfigured: [],
  };

  for (const delivery of due) {
    const adapter = adapters.get(delivery.channel);
    if (!adapter) {
      // Left PENDING on purpose. The moment a gateway is configured, the
      // backlog goes out; marking it FAILED would throw the message away for a
      // reason that has nothing to do with the message.
      if (!result.unconfigured.includes(delivery.channel)) {
        result.unconfigured.push(delivery.channel);
      }
      continue;
    }

    // Both forms were rendered when the row was written. Nothing is rendered
    // here, so an edited template cannot rewrite a message already queued.
    const target = {
      phone: delivery.notification.user.phone,
      title: delivery.notification.title,
      body: delivery.notification.body,
      sms: delivery.notification.smsBody,
    };

    try {
      const outcome = await adapter.deliver(target);
      await prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: {
          status: NotificationDeliveryStatus.SENT,
          sentAt: new Date(),
          attempts: delivery.attempts + 1,
          provider: outcome.provider,
          providerMessageId: outcome.providerMessageId,
          lastError: null,
        },
      });
      result.sent += 1;
    } catch (error) {
      const attempts = delivery.attempts + 1;
      const message = error instanceof Error ? error.message : String(error);
      const giveUp = attempts >= MAX_DELIVERY_ATTEMPTS;

      await prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: {
          status: giveUp
            ? NotificationDeliveryStatus.FAILED
            : NotificationDeliveryStatus.PENDING,
          attempts,
          lastError: message.slice(0, 500),
          nextAttemptAt: giveUp
            ? delivery.nextAttemptAt
            : new Date(now.getTime() + retryDelayMs(attempts)),
        },
      });

      if (giveUp) {
        result.failed += 1;
      } else {
        result.retrying += 1;
      }
    }
  }

  return result;
}

/** Marks a channel's pending deliveries as skipped when somebody opts out. */
export async function skipPendingForChannel(input: {
  userId: string;
  channel: NotificationChannel;
}): Promise<number> {
  const { count } = await prisma.notificationDelivery.updateMany({
    where: {
      channel: input.channel,
      status: NotificationDeliveryStatus.PENDING,
      notification: { userId: input.userId },
    },
    data: { status: NotificationDeliveryStatus.SKIPPED },
  });
  return count;
}
