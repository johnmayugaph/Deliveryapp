import type { ServiceGroup } from '@/lib/services/registry';
import { ServiceTile } from '@/components/home/ServiceTile';

/**
 * The service picker: one white panel, a row of tiles that scrolls.
 *
 * There is no list of services in this file. It renders whatever
 * `getServicesByIntentGroup()` returns — which is what makes activating MART a
 * one-row change.
 *
 * WHY A ROW RATHER THAN A GRID. A four-across grid wrapped to two rows at five
 * services and would take a third at six, and every row it takes is a row of
 * shops pushed off the screen. A scrolling row is fixed height whatever the
 * registry says is live: four and a half tiles visible, the half-tile doing
 * the work of telling you the row moves. This is the shape the category rails
 * in every delivery app have settled on, for that reason.
 *
 * The intent grouping is flattened HERE ONLY. The registry still groups and
 * the group pages still use it; on this screen three headings for five
 * services meant most of the panel was labels.
 *
 * The panel overlaps the header block above it: that overlap is what makes the
 * colour above read as a masthead rather than a stripe.
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
  const services = groups.flatMap((group) => group.services);

  if (services.length === 0) {
    return (
      <div className="relative -mt-5 px-4">
        <div className="card-warm p-5">
          <p className="text-sm text-ink-muted">
            No service is available in your area yet. We will come back to you.
          </p>
        </div>
      </div>
    );
  }

  return (
    <section
      aria-labelledby="services-heading"
      className="animate-rise-in relative -mt-5 rounded-t-3xl bg-surface pb-5 pt-5 shadow-tile lg:rounded-3xl"
    >
      <h2 id="services-heading" className="sr-only">
        What can we bring you?
      </h2>
      {/* Padding rather than margin on the sides, so the first tile lines up
          with the page gutter and the last can scroll clear of the edge. */}
      {/* A scrolling row on a phone because five tiles do not fit; from `lg`
          there is room for all of them, so they centre and the scroll goes
          away. A rail that never moves is a rail that looks broken. */}
      <ul
        className="flex snap-x snap-mandatory items-start gap-4 overflow-x-auto px-4 lg:justify-center lg:gap-10 lg:overflow-visible"
        style={{ scrollbarWidth: 'none' }}
      >
        {services.map((service) => (
          <li key={service.key} className="w-[4.5rem] shrink-0 snap-start">
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
  );
}
