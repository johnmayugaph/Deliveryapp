import type { ServiceGroup } from '@/lib/services/registry';
import { ServiceTile } from '@/components/home/ServiceTile';

/**
 * Service tiles, grouped by intent, straight from the registry.
 *
 * There is no list of services in this file. It renders whatever
 * `getServicesByIntentGroup()` returns, in whatever grouping the data says —
 * which is what makes activating MART a one-row change.
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
    <div className="space-y-5 px-4 py-4">
      {groups.map(({ group, presentation, services }) => (
        <section key={group} aria-labelledby={`group-${group}`}>
          <h2
            id={`group-${group}`}
            className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted"
          >
            {presentation.label}
          </h2>
          <p className="mt-0.5 text-[11px] text-ink-faint">{presentation.tagline}</p>
          <div className="mt-2.5 grid grid-cols-3 gap-2.5">
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
