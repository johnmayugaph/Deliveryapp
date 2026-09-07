import Link from 'next/link';
import type { ServiceAvailability } from '@/lib/services/registry';
import { accentClasses, serviceGlyph } from '@/lib/services/presentation';

/**
 * One service tile.
 *
 * A service orderable HERE is a link. Anything else renders DIMMED with a
 * "Coming soon" label and is NOT tappable — not a disabled link, but no link at
 * all, so keyboard and screen-reader users are not offered a dead target
 * either. Every visual difference comes from the `Service` row.
 *
 * The condition is `orderableHere`, not `isActive`: a vertical live in Cebu is
 * still coming soon to somebody in Manila, and a tappable tile that fails at
 * checkout is the outcome that reads as broken.
 */
export function ServiceTile({ service }: { service: ServiceAvailability }) {
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
      <div
        // Presentational, not interactive: there is nothing to activate.
        className={`relative flex flex-col rounded-tile p-3 opacity-55 ${accent.tileBackground}`}
      >
        <span className="absolute right-2 top-2 rounded-full bg-white/85 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-ink-muted">
          Coming soon
        </span>
        {inner}
      </div>
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
