import type { ServiceGroup } from '@/lib/services/registry';
import { ServiceTile } from '@/components/home/ServiceTile';

/**
 * Service tiles, grouped by intent, straight from the registry.
 *
 * There is no list of services in this file. It renders whatever
 * `getServicesByIntentGroup()` returns, in whatever grouping the data says —
 * which is what makes activating MART a one-row change.
 */

/**
 * How many columns a group gets.
 *
 * Two rather than three when a group holds one or two services, which is what
 * the registry actually returns today: a three-column grid holding two tiles
 * leaves a third of the row empty and reads as a tile that failed to load.
 * Returned as whole class names because Tailwind cannot build one from a
 * runtime value.
 */
const GRID_COLUMNS = (count: number): string =>
  count >= 3 ? 'grid-cols-3' : 'grid-cols-2';

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
    <div className="space-y-7 px-4 pb-2 pt-5">
      {groups.map(({ group, presentation, services }, index) => (
        <section
          key={group}
          aria-labelledby={`group-${group}`}
          className="animate-rise-in"
          /* Staggered by group, not by tile: five tiles arriving one after
             another is a flourish somebody sees once and then waits through
             every day. Three groups at 60ms apart is under a fifth of a
             second in total and reads as the page settling. */
          style={{ animationDelay: `${index * 60}ms` }}
        >
          <div className="flex items-baseline justify-between gap-3">
            <h2 id={`group-${group}`} className="eyebrow">
              {presentation.label}
            </h2>
            {/* A hairline that stops where the label starts. Cheap way to give
                a group a top edge without drawing a box around it. */}
            <span aria-hidden className="h-px flex-1 bg-ink/[0.08]" />
          </div>
          <p className="mt-1 text-[13px] leading-snug text-ink-muted">
            {presentation.tagline}
          </p>
          <div className={`mt-3 grid gap-3 ${GRID_COLUMNS(services.length)}`}>
            {services.map((service) => (
              <ServiceTile
                key={service.key}
                service={service}
                cityName={cityName}
                askedByMe={askedFor.includes(service.key)}
                signedIn={signedIn}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
