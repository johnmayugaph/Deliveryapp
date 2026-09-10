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
 * ONE SHAPE, TWO STATES. Both are chips: a round accent disc with the name
 * under it, sized so five sit in one scrollable row and the shops below them
 * are the first thing on the screen with real weight. A service that is not
 * orderable here is the same chip dimmed, with a "Soon" badge and the interest
 * tally under it — it keeps the tap that means "count me", which is the only
 * demand signal the product collects.
 *
 * The first attempt kept the old wide tile for the coming-soon case, and it
 * made the row twice as tall as its tallest chip. It looked correct only on a
 * deployment where every vertical happened to be live, which is the one state
 * a launch is never in.
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

  if (!service.orderableHere) {
    return (
      <AskForService
        serviceKey={service.key}
        displayName={service.displayName}
        cityName={cityName}
        askedByMe={askedByMe}
        signedIn={signedIn}
        tileBackground={accent.tileBackground}
        compact
      >
        <span
          aria-hidden
          className={`flex h-[3.75rem] w-[3.75rem] items-center justify-center rounded-full text-[26px] ring-1 ring-ink/[0.06] ${accent.tileBackground} ${accent.iconColor}`}
        >
          {glyph}
        </span>
        <span className="block text-[12px] font-bold leading-tight text-ink">
          {service.displayName}
        </span>
      </AskForService>
    );
  }

  return (
    <Link
      href={`/services/${service.key.toLowerCase()}`}
      className="press group flex w-[4.75rem] shrink-0 snap-start flex-col items-center gap-1.5 text-center"
    >
      <span
        aria-hidden
        className={`flex h-[3.75rem] w-[3.75rem] items-center justify-center rounded-full text-[26px] shadow-tile ring-1 ring-ink/[0.06] ${accent.tileBackground} ${accent.iconColor}`}
      >
        {glyph}
      </span>
      <span className="block text-[12px] font-bold leading-tight text-ink">
        {service.displayName}
      </span>
    </Link>
  );
}
