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
 * ONE SHAPE, TWO STATES. A rounded square in the service's own colour with the
 * name under it, in a four-across grid. A service that is not orderable here
 * is the same tile dimmed, with a "Soon" badge and its interest tally beneath
 * — it keeps the tap that means "count me". Both states are the same size, so
 * the grid stays a grid whatever the registry says is live; a launch, when
 * most verticals are still coming, is exactly the state that has to look
 * deliberate.
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

  const chip = (
    <span
      aria-hidden
      className={`flex h-14 w-14 items-center justify-center rounded-2xl text-[26px] ring-1 ring-ink/[0.06] ${accent.tileBackground} ${accent.iconColor}`}
    >
      {glyph}
    </span>
  );

  const label = (
    <span className="block text-center text-[11.5px] font-bold leading-tight text-ink">
      {service.displayName}
    </span>
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
        compact
      >
        {chip}
        {label}
      </AskForService>
    );
  }

  return (
    <Link
      href={`/services/${service.key.toLowerCase()}`}
      className="press flex flex-col items-center gap-2"
    >
      {chip}
      {label}
    </Link>
  );
}
