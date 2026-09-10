import Link from 'next/link';
import type { ServiceAvailability } from '@/lib/services/registry';
import { accentClasses, serviceGlyph } from '@/lib/services/presentation';
import { AskForService } from '@/components/home/AskForService';

/**
 * One service tile.
 *
 * A service orderable HERE is a link. Anything else is a button that records
 * that somebody wanted it — the tile used to be an inert dimmed `<div>`, which
 * was right when there was nothing to activate and is wrong now that a tap is
 * the only demand signal the product collects. Every visual difference still
 * comes from the `Service` row.
 *
 * The condition is `orderableHere`, not `isActive`: a vertical live in Cebu is
 * still coming soon to somebody in Manila, and a tappable tile that fails at
 * checkout is the outcome that reads as broken.
 *
 * WHERE THE ACCENT SITS, AND WHY IT MOVED. A live tile is now a white card and
 * the service colour is a chip behind the glyph; it used to be a wash across
 * the whole tile. Five full-bleed pastels in one grid competed with each other
 * and with the page, and the label sitting on tinted paper was the weakest text
 * on the screen. White cards with one saturated chip each let the colour do the
 * one job it is for — telling Parcel from Errands at a glance — while the name
 * gets full contrast. A coming-soon tile keeps the wash, dimmed: it should read
 * as a different kind of object, not a darker version of the same one.
 */
export function ServiceTile({
  service,
  cityName,
  askedByMe = false,
  signedIn,
}: {
  service: ServiceAvailability;
  /** Where the visitor is standing, for the tile's own copy. */
  cityName: string;
  /** Whether this signed-in person has already asked for it here. */
  askedByMe?: boolean;
  /** Whether there is an account to reach, if this one launches. */
  signedIn: boolean;
}) {
  const accent = accentClasses(service.accentToken);
  const glyph = serviceGlyph(service.icon);

  /*
   * The chip's ground is passed in rather than fixed, because the two tiles
   * put the glyph on different paper: soft-on-white for a live card, and
   * white-on-soft for the dimmed coming-soon wash, which would otherwise
   * disappear into its own tile.
   */
  const inner = (chipBackground: string) => (
    <>
      <span
        aria-hidden
        className={`flex h-12 w-12 items-center justify-center rounded-2xl text-[22px] ring-1 ring-ink/5 ${chipBackground} ${accent.iconColor}`}
      >
        {glyph}
      </span>
      <span className="mt-3 block text-[15px] font-bold leading-tight">
        {service.displayName}
      </span>
      <span className="mt-0.5 block text-[11.5px] leading-snug text-ink-muted">
        {service.tagline}
      </span>
    </>
  );

  if (!service.orderableHere) {
    return (
      <AskForService
        serviceKey={service.key}
        displayName={service.displayName}
        cityName={cityName}
        askedByMe={askedByMe}
        signedIn={signedIn}
        tileBackground={accent.tileBackground}
      >
        {inner(accent.iconBackground)}
      </AskForService>
    );
  }

  return (
    <Link
      href={`/services/${service.key.toLowerCase()}`}
      className="card-warm press group relative flex flex-col p-3.5"
    >
      {inner(accent.tileBackground)}
      {/* Quiet affordance rather than a chevron on every row: it says the tile
          goes somewhere without adding a fifth thing to look at. */}
      <span
        aria-hidden
        className="absolute right-3 top-3 text-sm font-bold text-brand-700 opacity-0 transition-opacity group-hover:opacity-100"
      >
        →
      </span>
    </Link>
  );
}
