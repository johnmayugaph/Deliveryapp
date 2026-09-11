import Link from 'next/link';
import { Wordmark } from '@/components/brand/Wordmark';

/**
 * Current delivery location with a tap-to-change control.
 *
 * Reads from the shared address book, so whatever the customer picks here is
 * the same record a Parcel pickup will offer later.
 */
export function LocationHeader({
  addressLabel,
  cityName,
  bell,
}: {
  addressLabel: string | null;
  cityName: string;
  /** The unread badge, resolved by the page so this stays presentational. */
  bell?: React.ReactNode;
}) {
  return (
    /*
     * THE HEADER BLOCK. Solid brand blue, white type, and the wordmark on the
     * right — the shape every Philippine delivery app converges on, and the
     * one the search field and the panel below are positioned against. Nothing
     * is read against it except two short lines, which is what lets it be a
     * saturated colour rather than a tint.
     */
    <header className="flex items-center gap-3 px-4 pb-3 pt-5">
      <Link
        href="/addresses"
        className="group flex min-w-0 flex-1 items-center gap-2.5 text-left"
      >
        <span
          aria-hidden
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/15 text-base"
        >
          📍
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[10px] font-bold uppercase tracking-[0.14em] text-white/70">
            Deliver to
          </span>
          <span className="flex items-center gap-1">
            <span className="truncate text-[15px] font-bold leading-tight text-white">
              {addressLabel ?? `Set your address · ${cityName}`}
            </span>
            <span aria-hidden className="text-[10px] text-white/70">
              ▾
            </span>
          </span>
        </span>
        <span className="sr-only">Change delivery location</span>
      </Link>
      {bell}
      {/* Hidden from `lg`: the top bar already carries the wordmark, and two
          of them on one screen reads as a template nobody finished. */}
      <Wordmark size="sm" tone="light" className="shrink-0 lg:hidden" />
    </header>
  );
}
