import { NotificationUrgency } from '@prisma/client';
import { encryptPushPayload, type SubscriptionKeys } from '@/lib/notifications/push/encrypt';
import {
  pushAudience,
  vapidAuthorization,
  type VapidConfig,
} from '@/lib/notifications/push/vapid';

/**
 * The Web Push Protocol request — RFC 8030.
 *
 * One POST per subscription, to a URL the browser gave us. The push service
 * holds the message until the browser next connects, then hands over bytes it
 * cannot read.
 *
 * The important thing this file gets right is the difference between a
 * subscription that is GONE and a send that merely FAILED. A 404 or 410 means
 * the browser has thrown the subscription away — retrying it is guaranteed
 * waste, and the row should be marked dead so it stops being attempted. Any
 * other error might be transient. Conflating the two either retries a dead
 * device forever or discards a live one over a momentary 500.
 */

/** What a service worker receives and renders. Kept small: 3993 bytes total. */
export interface PushPayload {
  title: string;
  body: string;
  /** Where clicking it goes, as an app-relative path. */
  href: string;
  /** Groups replaceable notifications, e.g. one per order. */
  tag?: string;
}

export type PushOutcome =
  | { kind: 'SENT'; status: number }
  /** The push service says this subscription no longer exists. */
  | { kind: 'GONE'; status: number };

export class PushDeliveryError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PushDeliveryError';
  }
}

export interface PushSubscriptionRecord {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * How hard the push service should try, per RFC 8030 §5.3.
 *
 * `high` wakes a device that is conserving battery; `normal` waits for the next
 * time it is awake anyway. Mapping OPERATIONAL to high is the same judgement
 * that decides whether a message is worth an SMS: somebody is waiting on an
 * action. Marking everything high would get us deprioritised by the services
 * that pay attention to it, which costs us the messages that actually matter.
 */
export function urgencyHeader(urgency: NotificationUrgency): 'high' | 'normal' {
  return urgency === NotificationUrgency.OPERATIONAL ? 'high' : 'normal';
}

/**
 * How long the push service should hold an undelivered message.
 *
 * Four hours for the operational ones and a day for the rest. Not longer: a
 * dispatch offer that surfaces tomorrow is worse than useless, because the
 * partner taps a job that was reassigned last night.
 */
export function ttlSeconds(urgency: NotificationUrgency): number {
  return urgency === NotificationUrgency.OPERATIONAL ? 4 * 60 * 60 : 24 * 60 * 60;
}

/**
 * A `Topic` collapses messages: a second one with the same topic REPLACES the
 * first if the first has not been delivered yet.
 *
 * This is what stops a lock screen filling with five states of the same order.
 * The header is limited to 32 base64url characters, so a tag is hashed down
 * rather than passed through — an order number is short enough today, but a
 * silently dropped header is not a failure worth risking on that.
 */
export function topicHeader(tag: string): string {
  return Buffer.from(tag, 'utf8').toString('base64url').slice(0, 32);
}

export interface SendPushInput {
  subscription: PushSubscriptionRecord;
  payload: PushPayload;
  urgency: NotificationUrgency;
  config: VapidConfig;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  now?: Date;
}

export async function sendPush(input: SendPushInput): Promise<PushOutcome> {
  const keys: SubscriptionKeys = {
    p256dh: input.subscription.p256dh,
    auth: input.subscription.auth,
  };

  // A malformed key throws out of here rather than being retried: the keys are
  // the browser's and will not become valid on a second attempt.
  const encrypted = encryptPushPayload(JSON.stringify(input.payload), keys);

  const headers: Record<string, string> = {
    authorization: vapidAuthorization({
      audience: pushAudience(input.subscription.endpoint),
      config: input.config,
      ...(input.now ? { now: input.now } : {}),
    }),
    'content-encoding': 'aes128gcm',
    'content-type': 'application/octet-stream',
    ttl: String(ttlSeconds(input.urgency)),
    urgency: urgencyHeader(input.urgency),
  };
  if (input.payload.tag) {
    headers.topic = topicHeader(input.payload.tag);
  }

  const doFetch = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(input.subscription.endpoint, {
      method: 'POST',
      headers,
      body: encrypted.body,
      // The delivery pass walks a batch; one unresponsive service must not
      // stall the rest of it.
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new PushDeliveryError('push request failed or timed out', undefined, error);
  }

  // 404: the endpoint was never real, or the service retired it.
  // 410 Gone: the browser unsubscribed, cleared its data, or was uninstalled.
  // Either way the subscription is dead and must not be retried.
  if (response.status === 404 || response.status === 410) {
    return { kind: 'GONE', status: response.status };
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new PushDeliveryError(
      `push service answered HTTP ${response.status}` +
        (detail ? `: ${detail.slice(0, 200)}` : ''),
      response.status,
    );
  }

  return { kind: 'SENT', status: response.status };
}
