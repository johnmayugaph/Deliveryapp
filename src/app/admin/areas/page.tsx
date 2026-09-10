import Link from 'next/link';
import { requireAdmin } from '@/lib/admin/access';
import { serviceAreaOverview } from '@/lib/admin/area-queries';
import { CITY_STANDING_COPY } from '@/lib/admin/service-areas';
import { formatCentavos } from '@/lib/money';
import { tileSource } from '@/lib/geo/tiles';
import {
  setDeliveryFeeRuleAction,
  updateCityAction,
} from '@/lib/actions/admin-actions';
import { ReasonForm } from '@/components/admin/ReasonForm';
import { CityCreateForm } from '@/components/admin/CityCreateForm';
import { FeeRuleFields } from '@/components/admin/FeeRuleFields';
import { Empty, Panel, Pill, Stat } from '@/components/admin/primitives';

export const dynamic = 'force-dynamic';

/**
 * Where TARA operates, and what delivery costs there.
 *
 * This screen exists because `City` and `DeliveryFeeRule` could only be
 * written by `prisma/seed.ts`. Five cities were seeded, and a sixth meant
 * editing a TypeScript file and redeploying — a developer task standing in
 * front of the most ordinary commercial decision this business makes.
 *
 * The organising idea is that **a city name is not the same as a city that
 * works.** Three things have to line up: the city exists and is switched on, a
 * service is launched in it (on the Services screen), and something prices
 * delivery to it. Miss the third and the city appears in the customer's
 * address form and every checkout from it fails — a failure the operator never
 * sees. So each row leads with `cityStanding()` rather than with a name, and
 * the "Not priced" state is the loudest thing on the page.
 */
export default async function AdminAreasPage() {
  await requireAdmin();
  const { cities, rules, services, servicesWithoutFallback } =
    await serviceAreaOverview();

  const orderable = cities.filter((city) => city.standing === 'ORDERABLE');
  const unpriced = cities.filter((city) => city.standing === 'NO_FEE_RULE');
  const activeServices = services.filter((service) => service.isActive);
  const missingFallback = services.filter((service) =>
    servicesWithoutFallback.includes(service.key),
  );

  const metres = (value: number) =>
    value === 0 ? 'from the first metre' : `after ${(value / 1000).toFixed(1)} km`;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold">Serving area</h1>
        <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-ink-muted">
          Which cities TARA operates in, and what delivery costs in each. A city
          here is not orderable until a service is launched in it on the{' '}
          <Link href="/admin/services" className="font-semibold underline">
            Services
          </Link>{' '}
          screen and something prices delivery to it.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Cities" value={String(cities.length)} />
        <Stat
          label="Taking orders"
          value={String(orderable.length)}
          note={orderable.length === 0 ? 'nobody can order anywhere' : undefined}
        />
        <Stat label="Delivery fee rules" value={String(rules.length)} />
        <Stat
          label="Not priced"
          value={String(unpriced.length)}
          note={unpriced.length > 0 ? 'checkout fails there' : undefined}
        />
      </div>

      {/* The two failures worth interrupting for, both invisible to an
          operator otherwise and both discovered by a customer at checkout. */}
      {unpriced.length > 0 ? (
        <div className="rounded-xl bg-red-50 px-4 py-3 text-xs leading-relaxed text-red-900 ring-1 ring-red-200">
          <p className="font-semibold">
            {unpriced.length === 1
              ? '1 city has a live service that nothing prices.'
              : `${unpriced.length} cities have a live service that nothing prices.`}
          </p>
          <p className="mt-1">
            A customer there can save an address and fill a cart, and checkout
            then fails rather than politely refusing. Give the service a fee
            rule for the city below, or a fallback rule that covers every city.
          </p>
          <ul className="mt-2 space-y-1">
            {unpriced.map((city) => (
              <li key={city.id} className="rounded-lg bg-black/5 px-2.5 py-2">
                <span className="font-semibold">{city.name}</span> —{' '}
                {city.unpricedServices.join(', ')}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {missingFallback.length > 0 ? (
        <div className="rounded-xl bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200">
          <p className="font-semibold">
            {missingFallback.map((service) => service.displayName).join(', ')} has
            no fallback delivery fee rule.
          </p>
          <p className="mt-1">
            Without one, every city needs its own rule and the next city you add
            starts unpriced. Setting a fallback once is the thing that stops that
            happening again — choose <em>Every city (fallback)</em> below.
          </p>
        </div>
      ) : null}

      <Panel
        title="Cities"
        description="Switching one off hides it from the address form and from service availability. Addresses, stores and orders already there are untouched — nothing in flight is cancelled."
      >
        {cities.length === 0 ? (
          <Empty>No cities yet. Add the first one below.</Empty>
        ) : (
          <ul className="divide-y divide-black/5">
            {cities.map((city) => {
              const copy = CITY_STANDING_COPY[city.standing];
              return (
                <li key={city.id} className="px-4 py-3.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">{city.name}</span>
                    <Pill tone={copy.tone}>{copy.label}</Pill>
                    <code className="text-[10px] text-ink-faint">{city.id}</code>
                  </div>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    {city.province} · {city.region}
                    {city.centroidLat !== null && city.centroidLng !== null
                      ? ` · ${city.centroidLat.toFixed(4)}, ${city.centroidLng.toFixed(4)}`
                      : ' · no map centre'}
                  </p>
                  <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">
                    {copy.detail}
                  </p>
                  <p className="mt-1 text-[11px] text-ink-faint">
                    {city.launchedServices.length > 0
                      ? `Live: ${city.launchedServices.join(', ')}`
                      : 'No service live here'}
                    {' · '}
                    {city.storeCount} store(s) · {city.addressCount} saved address(es)
                  </p>

                  <div className="mt-2">
                    <ReasonForm
                      action={updateCityAction}
                      hidden={{
                        cityId: city.id,
                        isActive: city.isActive ? 'false' : 'true',
                      }}
                      submitLabel={
                        city.isActive ? `Take ${city.name} off the map` : `Put ${city.name} back`
                      }
                      tone={city.isActive ? 'danger' : 'default'}
                    >
                      {city.isActive
                        ? 'Customers here stop seeing service and cannot save new addresses. Existing ones keep working if you switch it back.'
                        : 'Customers here can order again, subject to a service being live and priced.'}
                    </ReasonForm>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel
        title="Add a city"
        description="The identifier is made from the name — Arayat becomes city_arayat — because these ids appear in NEXT_PUBLIC_DEFAULT_CITY_ID and in service availability, where a random string would be unreadable. It cannot be changed afterwards; the name can."
      >
        <div className="px-4 py-4">
          <CityCreateForm tiles={tileSource()} />
        </div>
      </Panel>

      <Panel
        title="Delivery pricing"
        description="Pesos, not centavos. A city's own rule beats the fallback. Changing a rule applies to orders placed from now on — orders already quoted keep the fee they were quoted."
      >
        {rules.length === 0 ? (
          <Empty>
            No delivery fee rules at all, so nothing can be ordered anywhere. Add a
            fallback rule below for each live service.
          </Empty>
        ) : (
          <ul className="divide-y divide-black/5">
            {rules.map((rule) => (
              <li key={rule.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold">{rule.serviceName}</span>
                  <Pill tone={rule.cityName ? 'neutral' : 'good'}>
                    {rule.cityName ?? 'every city (fallback)'}
                  </Pill>
                  {rule.isActive ? null : <Pill tone="bad">off</Pill>}
                </div>
                <p className="mt-1 text-xs tabular-nums text-ink-muted">
                  {formatCentavos(rule.baseFeeCentavos)} base ·{' '}
                  {formatCentavos(rule.perKilometreCentavos)}/km {metres(rule.includedMeters)}{' '}
                  · min {formatCentavos(rule.minimumFeeCentavos)}
                  {rule.maximumFeeCentavos !== null
                    ? ` · max ${formatCentavos(rule.maximumFeeCentavos)}`
                    : ' · no maximum'}
                </p>
                <p className="mt-0.5 text-[11px] tabular-nums text-ink-faint">
                  service fee {formatCentavos(rule.serviceFeeCentavos)}
                  {rule.smallOrderThresholdCentavos !== null
                    ? ` · ${formatCentavos(rule.smallOrderFeeCentavos)} on orders under ${formatCentavos(rule.smallOrderThresholdCentavos)}`
                    : ' · no small-order fee'}
                  {rule.freeAboveSubtotalCentavos !== null
                    ? ` · free above ${formatCentavos(rule.freeAboveSubtotalCentavos)}`
                    : ''}
                </p>
              </li>
            ))}
          </ul>
        )}

        <div className="border-t border-black/5 px-4 py-4">
          <h3 className="text-[13px] font-semibold">Set a rule</h3>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">
            Setting a rule for a service and city that already has one replaces
            it. Leaving the city as <em>Every city</em> sets the fallback.
          </p>
          {activeServices.length === 0 ? (
            <p className="mt-3 text-xs text-ink-muted">
              No service is switched on, so there is nothing to price yet.
            </p>
          ) : (
            <div className="mt-3">
              <ReasonForm
                action={setDeliveryFeeRuleAction}
                hidden={{}}
                submitLabel="Save this pricing"
                extraFields={
                  <FeeRuleFields
                    services={activeServices}
                    cities={cities.map((city) => ({ id: city.id, name: city.name }))}
                  />
                }
              >
                This decides what every future order in that city pays to be
                delivered, so it is audited with your name against it.
              </ReasonForm>
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}
