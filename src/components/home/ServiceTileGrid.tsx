import Link from 'next/link';
import type { ServiceGroup } from '@/lib/services/registry';
import { ServiceTile } from '@/components/home/ServiceTile';

/**
 * The service picker: one white panel, four tiles across.
 *
 * There is no list of services in this file. It renders whatever
 * `getServicesByIntentGroup()` returns — which is what makes activating MART a
 * one-row change.
 *
 * WHY THE INTENT GROUPING IS FLATTENED HERE, and only here. The registry still
 * groups services by intent, and the group pages still use it. On this screen
 * it cost a heading, a rule and a row of its own per group — three groups for
 * five services, so most of the panel was labels. A four-across grid holds all
 * five in two rows and has room for the sixth without moving anything. The
 * data is untouched; this screen just stopped rendering the seams.
 *
 * The panel overlaps the header block above it by design: it is what makes the
 * blue a masthead rather than a stripe, and it puts the first tile within a
 * thumb's reach of the bottom of the screen.
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
      <div className="relative -mt-6 px-4">
        <div className="card-warm p-5">
          <p className="text-sm text-ink-muted">
            No service is available in your area yet. We will come back to you.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative -mt-6 px-4">
      <section aria-labelledby="services-heading" className="card-warm animate-rise-in p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 id="services-heading" className="text-[17px] font-extrabold tracking-tight">
            What can we bring you?
          </h2>
          {/* Only where there is somewhere to go: with every vertical on this
              panel already, "view all" would be a link back to itself. */}
          {services.length > 8 ? (
            <Link
              href="/services"
              className="text-[12.5px] font-bold text-brand-700 hover:text-brand-800"
            >
              View all <span aria-hidden>›</span>
            </Link>
          ) : null}
        </div>

        <div className="mt-4 grid grid-cols-4 gap-x-2 gap-y-5">
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
    </div>
  );
}
