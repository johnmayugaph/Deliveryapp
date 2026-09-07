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
 */
export function ServiceTile({
  service,
  cityName,
  askedByMe = false,
}: {
  service: ServiceAvailability;
  /** Where the visitor is standing, for the tile's own copy. */
  cityName: string;
  /** Whether this signed-in person has already asked for it here. */
  askedByMe?: boolean;
}) {
  const accent = accentClasses(service.accentToken);
  const glyph = serviceGlyph(service.icon);

  const inner = (
    <>
      <span
        aria-hidden
        className={`flex h-11 w-11 items-center justify-center rounded-full text-xl shadow-sm ${accent.iconBackground} ${accent.iconColor}`}
      >
        {glyph}
      </span>
      <span className="mt-2.5 block text-sm font-semibold leading-tight">
        {service.displayName}
      </span>
      <span className="mt-0.5 block text-[11px] leading-tight text-ink-muted">
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
        tileBackground={accent.tileBackground}
      >
        {inner}
      </AskForService>
    );
  }

  return (
    <Link
      href={`/services/${service.key.toLowerCase()}`}
      className={`flex flex-col rounded-tile p-3 transition-transform hover:scale-[1.02] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 ${accent.tileBackground}`}
    >
      {inner}
    </Link>
  );
}
