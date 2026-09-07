'use server';

import { revalidatePath } from 'next/cache';
import { NotificationChannel } from '@prisma/client';
import { requireOnboardedUser } from '@/lib/auth/session';
import { setChannelEnabled } from '@/lib/notifications/inbox';
import {
  forgetPushDevice,
  InvalidPushEndpointError,
  registerPushSubscription,
} from '@/lib/notifications/push/subscriptions';
import { MalformedSubscriptionKeysError } from '@/lib/notifications/push/encrypt';

/**
 * Registering and forgetting browsers.
 *
 * Unlike the rest of the inbox actions these cannot be plain form posts: the
 * subscription only exists after `pushManager.subscribe()` resolves in the
 * browser, so JavaScript is doing the asking either way. They return a result
 * rather than redirecting, because the caller is a client component that has to
 * reconcile what the browser thinks with what the server now knows.
 */

export interface PushActionResult {
  ok: boolean;
  /** Shown to the person. Written for somebody who is not debugging. */
  message?: string;
}

/** What the browser's `PushSubscription.toJSON()` gives us. */
export interface SubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/**
 * Records this browser and turns the channel on.
 *
 * Called on every page load where push is already permitted, not only when
 * somebody flips the switch. A browser can rotate its keys or drop a
 * subscription without telling the server, and `pushsubscriptionchange` fires
 * in a worker with no session to authenticate as — so re-registering on each
 * visit is the only reliable way to keep the stored keys current. The upsert
 * makes that free.
 */
export async function registerPushAction(
  subscription: SubscriptionInput,
  userAgent?: string,
): Promise<PushActionResult> {
  const user = await requireOnboardedUser();

  if (
    typeof subscription?.endpoint !== 'string' ||
    typeof subscription?.keys?.p256dh !== 'string' ||
    typeof subscription?.keys?.auth !== 'string'
  ) {
    return { ok: false, message: 'That browser did not give us a usable subscription.' };
  }

  try {
    await registerPushSubscription({
      userId: user.id,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      userAgent: userAgent?.slice(0, 300),
    });
  } catch (error) {
    if (
      error instanceof InvalidPushEndpointError ||
      error instanceof MalformedSubscriptionKeysError
    ) {
      // A bad endpoint or key is a client problem, and saying so is more useful
      // than a generic failure — but the detail stays out of the UI.
      return {
        ok: false,
        message: 'This browser sent something we cannot use. Try turning it off and on again.',
      };
    }
    throw error;
  }

  // Registering IS consent: somebody who granted browser permission and
  // subscribed has asked for push, so the channel switch follows.
  await setChannelEnabled({
    userId: user.id,
    channel: NotificationChannel.PUSH,
    enabled: true,
  });

  revalidatePath('/notifications');
  return { ok: true };
}

/**
 * Turns push off for this account.
 *
 * The switch, not the device: it stops every browser, because somebody who
 * turns notifications off in one place means it. The browser-side
 * `unsubscribe()` is the caller's job — this is the half that survives them
 * clearing site data.
 */
export async function disablePushAction(): Promise<PushActionResult> {
  const user = await requireOnboardedUser();

  await setChannelEnabled({
    userId: user.id,
    channel: NotificationChannel.PUSH,
    enabled: false,
  });

  revalidatePath('/notifications');
  return { ok: true };
}

/** Removes one browser from the list, at the person's request. */
export async function forgetPushDeviceAction(formData: FormData): Promise<void> {
  const user = await requireOnboardedUser();
  const id = String(formData.get('deviceId') ?? '');
  if (id) {
    // Scoped to this user inside `forgetPushDevice`, so an id from elsewhere
    // removes nothing.
    await forgetPushDevice({ userId: user.id, id });
  }
  revalidatePath('/notifications');
}
