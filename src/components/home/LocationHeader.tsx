import Link from 'next/link';

/**
 * Current delivery location with a tap-to-change control.
 *
 * Reads from the shared address book, so whatever the customer picks here is
 * the same record a Padala pickup will offer later.
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
    <header className="flex items-start gap-2 bg-surface px-4 pb-3 pt-5">
      <Link
        href="/addresses"
        className="group flex min-w-0 flex-1 items-start gap-2 text-left"
      >
        <span aria-hidden className="mt-0.5 text-base leading-none">
          📍
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] font-medium uppercase tracking-wide text-ink-faint">
            Deliver to
          </span>
          <span className="flex items-center gap-1">
            <span className="truncate text-sm font-semibold text-ink group-hover:text-brand-700">
              {addressLabel ?? `Set your address · ${cityName}`}
            </span>
            <span aria-hidden className="text-xs text-ink-faint">
              ▾
            </span>
          </span>
        </span>
        <span className="sr-only">Change delivery location</span>
      </Link>
      {bell}
    </header>
  );
}
