import Link from 'next/link';
import { redirect } from 'next/navigation';
import { NotificationChannel, NotificationKind } from '@prisma/client';
import { getCurrentUser } from '@/lib/auth/session';
import {
  listChannelSwitches,
  listNotifications,
  sentChannels,
} from '@/lib/notifications/inbox';
import {
  markAllReadAction,
  openNotificationAction,
  setSmsEnabledAction,
} from '@/lib/actions/notification-actions';

export const dynamic = 'force-dynamic';

/**
 * The inbox.
 *
 * One inbox for one account, whichever app the person is using: a woman who
 * sells lunch and drives in the evening should not have to check two lists.
 * Rows are keyed by kind rather than by which app raised them.
 *
 * Every control here is a plain form post. Opening a notification marks it read
 * on the server and redirects, so the inbox works before the bundle arrives.
 */

/** A glyph per kind. A lookup, so a new kind is one line rather than a branch. */
const KIND_GLYPH: Readonly<Record<NotificationKind, string>> = {
  [NotificationKind.ORDER_SUBMITTED]: '🧾',
  [NotificationKind.ORDER_ACCEPTED]: '👩‍🍳',
  [NotificationKind.ORDER_READY]: '🛍️',
  [NotificationKind.ORDER_RIDER_ASSIGNED]: '🛵',
  [NotificationKind.ORDER_PICKED_UP]: '📦',
  [NotificationKind.ORDER_ARRIVED]: '📍',
  [NotificationKind.ORDER_DELIVERED]: '✅',
  [NotificationKind.ORDER_CANCELLED]: '⚠️',
  [NotificationKind.ORDER_LOST_TO_TIMEOUT]: '⏰',
  [NotificationKind.DISPATCH_OFFER]: '🔔',
  [NotificationKind.CREDITS_GRANTED]: '🎁',
  [NotificationKind.SUBSCRIPTION_ENDED]: '📄',
};

function timeAgo(at: Date, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - at.getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return at.toLocaleDateString('en-PH', { day: 'numeric', month: 'short' });
}

export default async function NotificationsPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login?next=%2Fnotifications');
  }

  const [notifications, switches] = await Promise.all([
    listNotifications(user.id, { limit: 50 }),
    listChannelSwitches(user.id),
  ]);
  const sms = switches.find((row) => row.channel === NotificationChannel.SMS);
  const now = new Date();
  const unread = notifications.filter((row) => row.readAt === null).length;

  return (
    <main className="pb-4">
      <header className="bg-surface px-4 pb-3 pt-5 shadow-sm">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="text-xl font-bold">Notifications</h1>
          {unread > 0 ? (
            <form action={markAllReadAction}>
              <button type="submit" className="text-[12px] font-semibold text-brand-700">
                Mark all as read
              </button>
            </form>
          ) : null}
        </div>
        <p className="mt-0.5 text-[11px] text-ink-muted">
          One inbox for everything — orders, store and fleet.
        </p>
      </header>

      {/* The one switch a person has. The inbox itself is not optional: it is
          the record of what we told them. */}
      {sms ? (
        <section
          aria-labelledby="sms-heading"
          className="mx-4 mt-4 rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5"
        >
          <h2 id="sms-heading" className="text-[13px] font-semibold">
            SMS
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-ink-muted">
            {sms.enabled
              ? 'We text you the ones that need an answer: a new order for your store, a new job, a cancellation.'
              : 'SMS is off. Everything still arrives in this inbox; we just will not text you.'}
          </p>
          <form action={setSmsEnabledAction} className="mt-3">
            <input type="hidden" name="enabled" value={sms.enabled ? 'false' : 'true'} />
            <button
              type="submit"
              className="rounded-xl bg-surface-sunken px-3 py-2 text-[13px] font-semibold"
            >
              {sms.enabled ? 'Turn SMS off' : 'Turn SMS on'}
            </button>
          </form>
        </section>
      ) : null}

      {notifications.length === 0 ? (
        <p className="px-4 py-8 text-sm text-ink-muted">
          No notifications yet. Updates about your orders show up here.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-black/5">
          {notifications.map((notification) => {
            const channels = sentChannels(notification.deliveries);
            return (
              <li key={notification.id} className="bg-surface">
                <form action={openNotificationAction}>
                  <input type="hidden" name="notificationId" value={notification.id} />
                  <input type="hidden" name="href" value={notification.href ?? '/notifications'} />
                  <button
                    type="submit"
                    className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-brand-50/60"
                  >
                    <span aria-hidden className="mt-0.5 text-lg">
                      {KIND_GLYPH[notification.kind]}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={`block text-sm ${
                          notification.readAt === null ? 'font-bold' : 'font-medium'
                        }`}
                      >
                        {notification.title}
                      </span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">
                        {notification.body}
                      </span>
                      <span className="mt-1 block text-[11px] text-ink-faint">
                        {timeAgo(notification.createdAt, now)}
                        {channels.includes(NotificationChannel.SMS) ? ' · texted' : ''}
                      </span>
                    </span>
                    {notification.readAt === null ? (
                      <span
                        aria-label="Unread"
                        className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand-600"
                      />
                    ) : null}
                  </button>
                </form>
              </li>
            );
          })}
        </ul>
      )}

      <p className="px-4 pt-5 text-[11px] text-ink-faint">
        <Link href="/help" className="font-semibold text-brand-700">
          Help and support
        </Link>
      </p>
    </main>
  );
}
