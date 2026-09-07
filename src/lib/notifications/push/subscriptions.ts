import { prisma } from '@/lib/prisma';
import { MalformedSubscriptionKeysError } from '@/lib/notifications/push/encrypt';

/**
 * The store of browsers that have agreed to receive push.
 *
 * Registration is idempotent on the endpoint, because that is what the browser
 * guarantees: `pushManager.subscribe()` on a profile that already has a
 * subscription returns the same endpoint. So a page that registers on every
 * load — which is the correct thing for a page to do, since a subscription can
 * be revoked without telling us — must not create a row every time.
 */

const P256DH_BYTES = 65;
const AUTH_BYTES = 16;
/** Long enough for any real push service URL; short enough not to be a payload. */
const MAX_ENDPOINT_LENGTH = 1024;

export class InvalidPushEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPushEndpointError';
  }
}

export interface RegisterPushInput {
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | undefined;
}

/**
 * Checks what the browser sent before it reaches the table.
 *
 * These three values arrive from a client, so they are input, not fact. A
 * wrong-length key would encrypt fine and deliver nothing; an endpoint pointing
 * somewhere other than a push service would make this app into a POST relay
 * that signs its requests with our VAPID key.
 */
export function validatePushSubscription(input: {
  endpoint: string;
  p256dh: string;
  auth: string;
}): void {
  if (input.endpoint.length > MAX_ENDPOINT_LENGTH) {
    throw new InvalidPushEndpointError('That push endpoint is implausibly long.');
  }

  let url: URL;
  try {
    url = new URL(input.endpoint);
  } catch {
    throw new InvalidPushEndpointError('That push endpoint is not a URL.');
  }

  // Push services are HTTPS-only. Allowing anything else would let a caller
  // aim our signed, encrypted POSTs at a host of their choosing.
  if (url.protocol !== 'https:') {
    throw new InvalidPushEndpointError('A push endpoint must be an https: URL.');
  }

  if (Buffer.from(input.p256dh, 'base64url').length !== P256DH_BYTES) {
    throw new MalformedSubscriptionKeysError(
      `The p256dh key must decode to ${P256DH_BYTES} bytes.`,
    );
  }
  if (Buffer.from(input.auth, 'base64url').length !== AUTH_BYTES) {
    throw new MalformedSubscriptionKeysError(
      `The auth secret must decode to ${AUTH_BYTES} bytes.`,
    );
  }
}

/**
 * Records a browser, or refreshes what we know about one.
 *
 * The upsert is on the endpoint, and it reassigns `userId` — deliberately. Two
 * people sharing a laptop profile is one browser, and whoever most recently
 * granted permission is the one whose notifications belong on that screen.
 * Leaving the old owner would send one person's order updates to another.
 *
 * It also clears `expiredAt`: a browser that just subscribed is alive again,
 * whatever the push service said about it last week.
 */
export async function registerPushSubscription(
  input: RegisterPushInput,
): Promise<{ id: string }> {
  validatePushSubscription(input);

  const now = new Date();
  return prisma.webPushSubscription.upsert({
    where: { endpoint: input.endpoint },
    create: {
      userId: input.userId,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      userAgent: input.userAgent ?? null,
    },
    update: {
      userId: input.userId,
      // The keys are rotated by the browser when it re-subscribes, so a
      // refresh that kept the old ones would encrypt for a key nobody holds.
      p256dh: input.p256dh,
      auth: input.auth,
      userAgent: input.userAgent ?? null,
      lastSeenAt: now,
      expiredAt: null,
      failureCount: 0,
    },
    select: { id: true },
  });
}

/** The subscriptions worth attempting for one person. */
export async function livePushSubscriptions(userId: string) {
  return prisma.webPushSubscription.findMany({
    where: { userId, expiredAt: null },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
    orderBy: { lastSeenAt: 'desc' },
  });
}

/** Whether this person has any browser that could receive a push. */
export async function hasLivePushSubscription(userId: string): Promise<boolean> {
  const count = await prisma.webPushSubscription.count({
    where: { userId, expiredAt: null },
  });
  return count > 0;
}

/** For the device list: enough to recognise a browser, never the keys. */
export async function listPushDevices(userId: string) {
  return prisma.webPushSubscription.findMany({
    where: { userId },
    select: {
      id: true,
      userAgent: true,
      createdAt: true,
      lastSeenAt: true,
      expiredAt: true,
    },
    orderBy: [{ expiredAt: 'asc' }, { lastSeenAt: 'desc' }],
  });
}

/** After a send lands. Also clears a soft-failure streak. */
export async function markPushDelivered(id: string): Promise<void> {
  await prisma.webPushSubscription.update({
    where: { id },
    data: { lastSeenAt: new Date(), failureCount: 0 },
  });
}

/**
 * After a 404 or 410: the browser is gone.
 *
 * The row stays. "This person used to have push and lost it" answers a support
 * question that a deleted row cannot, and the delivery pass skips it either
 * way. `lastSeenAt` is pinned to no later than `expiredAt` because the table
 * insists a dead subscription cannot also look freshly seen.
 */
export async function markPushGone(id: string): Promise<void> {
  const now = new Date();
  await prisma.webPushSubscription.updateMany({
    where: { id, expiredAt: null },
    data: { expiredAt: now, lastSeenAt: now },
  });
}

/** After a transient failure. Counts, but does not condemn. */
export async function markPushFailed(id: string): Promise<void> {
  await prisma.webPushSubscription.update({
    where: { id },
    data: { failureCount: { increment: 1 } },
  });
}

/**
 * Removing a device from the list, at the person's request.
 *
 * A real delete rather than an expiry, because this is somebody saying "not
 * this browser" rather than a browser disappearing — and leaving the row would
 * mean the next `subscribe()` from that browser silently resurrected it.
 */
export async function forgetPushDevice(input: {
  userId: string;
  id: string;
}): Promise<boolean> {
  const { count } = await prisma.webPushSubscription.deleteMany({
    // Scoped by userId: an id alone would let anyone unsubscribe anyone.
    where: { id: input.id, userId: input.userId },
  });
  return count > 0;
}
