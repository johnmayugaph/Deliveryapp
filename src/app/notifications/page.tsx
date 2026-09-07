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
import { forgetPushDeviceAction } from '@/lib/actions/push-actions';
import { PushSwitch } from '@/components/notifications/PushSwitch';
import { isPushConfigured, resolveVapidConfig } from '@/lib/notifications/push/vapid';
import { listPushDevices } from '@/lib/notifications/push/subscriptions';

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
  [NotificationKind.SECURITY_ALERT]: '🔐',
  [NotificationKind.SERVICE_NOW_AVAILABLE]: '🎉',
  [NotificationKind.ERROR_DETECTED]: '🚨',
  [NotificationKind.SUPPORT_TICKET_WAITING]: '📥',
  [NotificationKind.SUPPORT_REPLY]: '💬',
};

/**
 * A recognisable name for a browser, from its user agent.
 *
 * Not a device-detection library: the point is only that a person can tell
 * which row is their phone, and the order of these checks matters because
 * every Chromium browser also claims to be Chrome and Safari.
 */
function describeBrowser(userAgent: string | null): string {
  if (!userAgent) return 'Unknown browser';
  const platform = /Android/i.test(userAgent)
    ? 'Android'
    : /iPhone|iPad|iPod/i.test(userAgent)
      ? 'iPhone'
      : /Windows/i.test(userAgent)
        ? 'Windows'
        : /Mac OS X/i.test(userAgent)
          ? 'Mac'
          : /Linux/i.test(userAgent)
            ? 'Linux'
            : 'Unknown device';
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /OPR\//.test(userAgent)
      ? 'Opera'
      : /Firefox\//.test(userAgent)
        ? 'Firefox'
        : /Chrome\//.test(userAgent)
          ? 'Chrome'
          : /Safari\//.test(userAgent)
            ? 'Safari'
            : 'Browser';
  return `${browser} on ${platform}`;
}

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

  // The public key is read on the server and passed down, rather than sitting
  // in a NEXT_PUBLIC_ variable: one source for it, and no second copy to drift.
  const pushConfigured = isPushConfigured();
  const [notifications, switches, devices] = await Promise.all([
    listNotifications(user.id, { limit: 50 }),
    listChannelSwitches(user.id),
    pushConfigured ? listPushDevices(user.id) : Promise.resolve([]),
  ]);
  const sms = switches.find((row) => row.channel === NotificationChannel.SMS);
  const push = switches.find((row) => row.channel === NotificationChannel.PUSH);
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

      {/* Push first: it is free, it reaches a closed tab, and it is the one a
          person should be offered. SMS is the fallback below it. The inbox
          itself is not optional — it is the record of what we told them. */}
      {pushConfigured ? (
        <PushSwitch
          vapidPublicKey={resolveVapidConfig().publicKey}
          enabledForAccount={push?.enabled ?? true}
        />
      ) : null}

      {/* Other browsers this account has subscribed. Only worth showing when
          there is more than the one being used right now. */}
      {devices.length > 1 ? (
        <section
          aria-labelledby="devices-heading"
          className="mx-4 mt-4 rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5"
        >
          <h2 id="devices-heading" className="text-[13px] font-semibold">
            Devices getting notifications
          </h2>
          <ul className="mt-2 divide-y divide-black/5">
            {devices.map((device) => (
              <li key={device.id} className="flex items-baseline gap-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">
                    {describeBrowser(device.userAgent)}
                  </span>
                  <span className="mt-0.5 block text-[11px] text-ink-faint">
                    {device.expiredAt
                      ? 'No longer reachable'
                      : `Last used ${device.lastSeenAt.toLocaleDateString('en-PH', {
                          day: 'numeric',
                          month: 'short',
                        })}`}
                  </span>
                </span>
                <form action={forgetPushDeviceAction}>
                  <input type="hidden" name="deviceId" value={device.id} />
                  <button type="submit" className="text-[12px] font-semibold text-brand-700">
                    Remove
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

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
              ? 'A text reaches you with no app open and no permission granted, so we use it for the ones that need an answer: a new order for your store, a new job, a cancellation.'
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
                        {channels.includes(NotificationChannel.PUSH) ? ' · pushed' : ''}
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
