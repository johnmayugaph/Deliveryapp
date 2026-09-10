import Link from 'next/link';

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
     * THE SUN BAND. The one place the brand yellow is allowed to fill a whole
     * area rather than accent one, and it is at the top of the screen for two
     * reasons: it is the first thing seen, and it is the region where nothing
     * has to be read against it except two lines the band is light enough to
     * carry. The rounded bottom edge and the search pill that overlaps it are
     * what turn a coloured strip into a masthead.
     */
    <header className="relative rounded-b-[2rem] bg-sun px-4 pb-11 pt-6">
      <div className="flex items-start gap-2">
        <Link
          href="/addresses"
          className="press group flex min-w-0 flex-1 items-center gap-2.5 rounded-full bg-surface/80 py-2 pl-3 pr-4 text-left ring-1 ring-ink/[0.06] backdrop-blur"
        >
          <span aria-hidden className="text-base leading-none">
            📍
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[10px] font-bold uppercase tracking-[0.14em] text-brand-800">
              Deliver to
            </span>
            <span className="flex items-center gap-1">
              <span className="truncate text-[13.5px] font-bold leading-tight text-ink">
                {addressLabel ?? `Set your address · ${cityName}`}
              </span>
              <span aria-hidden className="text-[10px] text-ink-muted">
                ▾
              </span>
            </span>
          </span>
          <span className="sr-only">Change delivery location</span>
        </Link>
        {bell}
      </div>
    </header>
  );
}
