import type { ServiceGroup } from '@/lib/services/registry';
import { ServiceTile } from '@/components/home/ServiceTile';

/**
 * Service tiles, grouped by intent, straight from the registry.
 *
 * There is no list of services in this file. It renders whatever
 * `getServicesByIntentGroup()` returns, in whatever grouping the data says —
 * which is what makes activating MART a one-row change.
 *
 * WHY ROWS AND NOT A GRID. A grid of five large cards was the whole first
 * screen, and it pushed the shops — the thing somebody opened the app to
 * reach — below the fold. Each group is now a horizontally scrollable row of
 * chips, which is the pattern every delivery app converges on for the same
 * reason: picking a vertical is a one-tap decision that does not deserve half
 * a phone screen. The grouping survives because it is data; only the shape of
 * the row changed.
 *
 * The row scrolls rather than wraps. Wrapping would make the home screen's
 * height depend on how many verticals are live, so activating a sixth would
 * quietly push everything below it down.
 */
export function ServiceTileGrid({
  groups,
  cityName,
  askedFor,
  signedIn,
}: {
  groups: ServiceGroup[];
  /** Where the visitor is standing. The coming-soon tiles say it out loud. */
  cityName: string;
  /** Service keys this signed-in person has already asked for, in this city. */
  askedFor: readonly string[];
  /** Whether this visitor has an account. The screen is public. */
  signedIn: boolean;
}) {
  if (groups.length === 0) {
    return (
      <p className="px-4 py-6 text-sm text-ink-muted">
        No service is available in your area yet. We will come back to you.
      </p>
    );
  }

  return (
    <div className="space-y-5 pb-1 pt-5">
      {groups.map(({ group, presentation, services }, index) => (
        <section
          key={group}
          aria-labelledby={`group-${group}`}
          className="animate-rise-in"
          /* Staggered by group, not by tile: five chips arriving one after
             another is a flourish somebody sees once and then waits through
             every day. Three groups at 60ms apart is under a fifth of a
             second in total and reads as the page settling. */
          style={{ animationDelay: `${index * 60}ms` }}
        >
          <div className="flex items-baseline gap-3 px-4">
            <h2 id={`group-${group}`} className="eyebrow">
              {presentation.label}
            </h2>
            {/* A hairline that starts where the label ends. Cheap way to give
                a group a top edge without drawing a box around it. */}
            <span aria-hidden className="h-px flex-1 bg-ink/[0.08]" />
          </div>
          {/*
            * `overflow-x-auto` with padding rather than margin on the sides,
            * so the first chip starts on the page's gutter and the last one
            * can scroll clear of the edge instead of being clipped by it.
            * `scrollbar-width: none` because a visible scrollbar under five
            * chips reads as a rendering fault on a phone.
            */}
          <ul
            className="mt-2.5 flex snap-x snap-mandatory items-start gap-3.5 overflow-x-auto px-4 pb-1"
            style={{ scrollbarWidth: 'none' }}
          >
            {services.map((service) => (
              <li key={service.key} className="contents">
                <ServiceTile
                  service={service}
                  cityName={cityName}
                  askedByMe={askedFor.includes(service.key)}
                  signedIn={signedIn}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
