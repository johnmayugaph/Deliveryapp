import Link from 'next/link';
import { countUnread } from '@/lib/notifications/inbox';

/**
 * The unread count, wherever somebody is working.
 *
 * A server component that counts on render: the number is small, the query is
 * indexed on `(userId, readAt, createdAt)`, and a stale badge is worse than a
 * cheap one. The badge itself is absent when there is nothing unread, so the
 * three headers stay quiet in the normal case.
 */
export async function NotificationBell({
  userId,
  tone = 'light',
}: {
  userId: string;
  tone?: 'light' | 'dark';
}) {
  const unread = await countUnread(userId);

  return (
    <Link
      href="/notifications"
      aria-label={unread > 0 ? `${unread} bagong abiso` : 'Mga abiso'}
      className={`relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-base ${
        tone === 'dark' ? 'bg-white/15 text-white' : 'bg-surface-sunken text-ink'
      }`}
    >
      <span aria-hidden>🔔</span>
      {unread > 0 ? (
        <span className="absolute -right-0.5 -top-0.5 min-w-[1.15rem] rounded-full bg-rose-600 px-1 text-center text-[10px] font-bold leading-[1.15rem] text-white tabular-nums">
          {unread > 9 ? '9+' : unread}
        </span>
      ) : null}
    </Link>
  );
}
