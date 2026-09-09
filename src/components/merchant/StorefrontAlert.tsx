'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { shellAlert, type StorefrontState } from '@/lib/merchant/storefront-policy';

/**
 * The strip under the merchant header, when something is stopping orders.
 *
 * A link rather than an explanation: the words that matter are "this is not
 * working", and the reason and the fix are a tap away on the screen built for
 * them. Renders nothing at all in the two cases that need no interruption —
 * a shop that is fine, and one that simply closed for the night.
 *
 * A client component only so it can read the path. On the settings screen the
 * explanation is already immediately below, so the link would point at the
 * page you are standing on; the line still shows, because it is the one line
 * every merchant screen should agree on, but it stops offering a tap that
 * goes nowhere.
 */
export function StorefrontAlert({
  state,
  storeId,
}: {
  state: StorefrontState;
  storeId: string;
}) {
  const pathname = usePathname();
  const line = shellAlert(state);
  if (line === null) return null;

  const settings = `/merchant/${storeId}/settings`;
  const shell =
    'mt-2 flex items-center justify-between gap-2 rounded-lg bg-rose-50 px-3 py-2 text-[11px] font-semibold text-rose-800';

  if (pathname === settings) {
    return (
      <p role="status" className={shell}>
        {line}
      </p>
    );
  }

  return (
    <Link href={settings} className={shell}>
      <span>{line}</span>
      <span className="shrink-0 font-bold" aria-hidden>
        Bakit? →
      </span>
      <span className="sr-only">Open Settings to see why</span>
    </Link>
  );
}
