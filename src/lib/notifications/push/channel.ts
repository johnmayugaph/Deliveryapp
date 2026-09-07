import { NotificationChannel } from '@prisma/client';
import type {
  DeliveryOutcome,
  DeliveryTarget,
  NotificationChannelAdapter,
} from '@/lib/notifications/channels';
import { PushDeliveryError, sendPush } from '@/lib/notifications/push/send';
import { resolveVapidConfig, type VapidConfig } from '@/lib/notifications/push/vapid';
import {
  livePushSubscriptions,
  markPushDelivered,
  markPushFailed,
  markPushGone,
} from '@/lib/notifications/push/subscriptions';
import { MalformedSubscriptionKeysError } from '@/lib/notifications/push/encrypt';

/**
 * Push, as one of the channels the delivery pass walks.
 *
 * The fan-out lives here rather than in the delivery table. One person can have
 * a phone and two laptops, and a `NotificationDelivery` row per device would
 * make "was this person told" a question you answer by counting rows and
 * guessing. So: one delivery row for the channel, and this adapter reaches
 * every live browser behind it.
 *
 * Which means deciding what a partial success is. It succeeds if ANY browser
 * took the message, because the person was reached; the failures are recorded
 * on the subscriptions themselves, which is where a dead device belongs. It
 * fails only if every browser failed — and if there were no browsers at all,
 * that is not a failure either: it means the person turned push on and then
 * revoked permission, and the delivery is SKIPPED rather than retried three
 * times against nothing.
 */

export class NoPushSubscriptionsError extends Error {
  constructor() {
    super('That person has no browser subscribed to push.');
    this.name = 'NoPushSubscriptionsError';
  }
}

export class PushChannel implements NotificationChannelAdapter {
  readonly channel = NotificationChannel.PUSH;

  constructor(private readonly config: VapidConfig = resolveVapidConfig()) {}

  async deliver(target: DeliveryTarget): Promise<DeliveryOutcome> {
    const subscriptions = await livePushSubscriptions(target.userId);
    if (subscriptions.length === 0) {
      throw new NoPushSubscriptionsError();
    }

    const payload = {
      title: target.title,
      body: target.body,
      href: target.href,
      ...(target.tag ? { tag: target.tag } : {}),
    };

    let delivered = 0;
    let gone = 0;
    const errors: string[] = [];

    for (const subscription of subscriptions) {
      try {
        const outcome = await sendPush({
          subscription,
          payload,
          urgency: target.urgency,
          config: this.config,
        });

        if (outcome.kind === 'GONE') {
          await markPushGone(subscription.id);
          gone += 1;
          continue;
        }

        await markPushDelivered(subscription.id);
        delivered += 1;
      } catch (error) {
        if (error instanceof MalformedSubscriptionKeysError) {
          // Keys that cannot work will never work. Retrying is pure waste, so
          // this is the same disposition as a 410.
          await markPushGone(subscription.id);
          gone += 1;
          errors.push(`${subscription.endpoint}: ${error.message}`);
          continue;
        }

        await markPushFailed(subscription.id);
        errors.push(
          `${subscription.endpoint}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (delivered > 0) {
      return {
        provider: 'web-push',
        providerMessageId: null,
        // Reported so a partial fan-out is visible rather than rounded up to
        // a clean success.
        note:
          gone > 0 || errors.length > 0
            ? `${delivered} of ${subscriptions.length} device(s); ${gone} gone`
            : undefined,
      };
    }

    if (gone === subscriptions.length) {
      // Every browser is gone. Not worth a retry, and not an incident.
      throw new NoPushSubscriptionsError();
    }

    throw new PushDeliveryError(
      `push failed for all ${subscriptions.length} device(s): ${errors.join('; ')}`,
    );
  }
}
