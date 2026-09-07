import { NotificationChannel } from '@prisma/client';
import { resolveSmsSender, SmsDeliveryError } from '@/lib/auth/sms';
import type { SmsSender } from '@/lib/auth/sms';

/**
 * How a notification actually leaves the building.
 *
 * One interface, one adapter per channel, so the third channel is a file rather
 * than a refactor. Push is the obvious next one: a `PushChannel` with a
 * `WebPushSubscription` table, keys from the environment, and the same
 * `deliver()` signature. Nothing above this layer would change.
 */

export interface DeliveryTarget {
  /** E.164, for channels that need a number. */
  phone: string;
  title: string;
  body: string;
  /** The short form, already rendered at enqueue time. */
  sms: string;
}

export interface DeliveryOutcome {
  /** The sender that handled it, for support. */
  provider: string;
  providerMessageId: string | null;
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
 * SMS resolution can throw — in production with no gateway configured, it
 * refuses rather than pretending. When it does, the channel is simply absent
 * and its deliveries stay PENDING, which is the honest state: nothing was sent
 * and the row still says so.
 */
export function resolveChannels(): Map<NotificationChannel, NotificationChannelAdapter> {
  const adapters = new Map<NotificationChannel, NotificationChannelAdapter>();
  adapters.set(NotificationChannel.IN_APP, new InAppChannel());

  try {
    adapters.set(NotificationChannel.SMS, new SmsChannel());
  } catch {
    // No gateway. Leave SMS out; `deliverPending` reports it as unconfigured.
  }

  return adapters;
}

export { SmsDeliveryError };
