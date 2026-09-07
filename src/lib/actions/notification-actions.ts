'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { NotificationChannel } from '@prisma/client';
import { requireOnboardedUser } from '@/lib/auth/session';
import { markAllRead, markRead, setChannelEnabled } from '@/lib/notifications/inbox';

/**
 * Inbox actions.
 *
 * All three are plain form posts with no client JavaScript required: opening a
 * notification is a submit that marks it read and redirects, which means the
 * inbox works on a phone that has not finished loading the bundle. Unlike
 * signing in, none of these needs a cookie, so nothing here has to be gated on
 * hydration.
 */

/** Marks one read, then goes where it points. */
export async function openNotificationAction(formData: FormData): Promise<void> {
  const user = await requireOnboardedUser();
  const notificationId = String(formData.get('notificationId') ?? '');
  const href = String(formData.get('href') ?? '/notifications');

  if (notificationId) {
    await markRead({ userId: user.id, notificationId });
  }

  // Only in-app paths, and only ours: the value comes from our own row, but
  // treating it as untrusted costs one check and closes an open-redirect.
  const safe = href.startsWith('/') && !href.startsWith('//') ? href : '/notifications';
  redirect(safe);
}

export async function markAllReadAction(): Promise<void> {
  const user = await requireOnboardedUser();
  await markAllRead(user.id);
  revalidatePath('/notifications');
  revalidatePath('/', 'layout');
}

export async function setSmsEnabledAction(formData: FormData): Promise<void> {
  const user = await requireOnboardedUser();
  const enabled = formData.get('enabled') === 'true';

  await setChannelEnabled({
    userId: user.id,
    channel: NotificationChannel.SMS,
    enabled,
  });

  revalidatePath('/notifications');
  revalidatePath('/profile');
}
