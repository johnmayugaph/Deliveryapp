import { NotificationChannel, NotificationUrgency } from '@prisma/client';
import { resolveSmsSender, SmsDeliveryError } from '@/lib/auth/sms';
import type { SmsSender } from '@/lib/auth/sms';
// A plain import, but push/channel.ts takes only TYPES from this file, so the
// cycle is erased at compile time and there is no runtime one.
import { PushChannel } from '@/lib/notifications/push/channel';

/**
 * How a notification actually leaves the building.
 *
 * One interface, one adapter per channel. Push was the third, added later, and
 * it needed no change above this layer — which was the claim this shape was
 * chosen to make good on. The adapters live in `push/channel.ts` and here.
 */

export interface DeliveryTarget {
  /** Who it is for. Push resolves this to a set of subscribed browsers. */
  userId: string;
  /** E.164, for channels that need a number. */
  phone: string;
  title: string;
  body: string;
  /** The short form, already rendered at enqueue time. */
  sms: string;
  /** An in-app path for a channel whose notification can be tapped. */
  href: string;
  /** Set for channels that can prioritise, and for collapse decisions. */
  urgency: NotificationUrgency;
  /**
   * Groups messages that supersede each other — one per order. A channel that
   * supports collapsing shows only the newest.
   */
  tag?: string | undefined;
}

export interface DeliveryOutcome {
  /** The sender that handled it, for support. */
  provider: string;
  providerMessageId: string | null;
  /**
   * Anything worth recording that is not a failure — a fan-out that reached
   * some devices and not others. Kept out of `lastError`, which means failed.
   */
  note?: string | undefined;
}

export interface NotificationChannelAdapter {
  readonly channel: NotificationChannel;
  deliver(target: DeliveryTarget): Promise<DeliveryOutcome>;
}

/**
 * The inbox.
 *
 * Delivery is a no-op because writing the `Notification` row IS the delivery —
 * the adapter exists so the channel is not a special case in the delivery loop.
 */
export class InAppChannel implements NotificationChannelAdapter {
  readonly channel = NotificationChannel.IN_APP;

  async deliver(): Promise<DeliveryOutcome> {
    return { provider: 'in-app', providerMessageId: null };
  }
}

/** The only channel that reaches a closed tab today. */
export class SmsChannel implements NotificationChannelAdapter {
  readonly channel = NotificationChannel.SMS;

  constructor(private readonly sender: SmsSender = resolveSmsSender()) {}

  async deliver(target: DeliveryTarget): Promise<DeliveryOutcome> {
    const result = await this.sender.send({ to: target.phone, body: target.sms });
    return { provider: result.provider, providerMessageId: result.providerMessageId };
  }
}

/**
 * Builds the adapter set.
 *
 * Both external channels can refuse to be constructed — SMS in production with
 * no gateway, push with no VAPID keys. When one does, the channel is simply
 * absent and its deliveries stay PENDING, which is the honest state: nothing
 * was sent and the row still says so. The moment the configuration appears,
 * the backlog goes out.
 */
export function resolveChannels(): Map<NotificationChannel, NotificationChannelAdapter> {
  const adapters = new Map<NotificationChannel, NotificationChannelAdapter>();
  adapters.set(NotificationChannel.IN_APP, new InAppChannel());

  try {
    adapters.set(NotificationChannel.PUSH, new PushChannel());
  } catch {
    // No VAPID keys. `npm run push:keys` prints what to set.
  }

  try {
    adapters.set(NotificationChannel.SMS, new SmsChannel());
  } catch {
    // No gateway. Leave SMS out; `deliverPending` reports it as unconfigured.
  }

  return adapters;
}

export { SmsDeliveryError };

