import { requireAdmin, listAdminActions } from '@/lib/admin/access';
import { listCities, serviceHealth } from '@/lib/admin/queries';
import { getAllServices } from '@/lib/services/registry';
import { setServiceActiveAction, setServiceCityAction } from '@/lib/actions/admin-actions';
import { ReasonForm } from '@/components/admin/ReasonForm';
import {
  Empty,
  Panel,
  Pill,
  humaniseEnum,
  manilaTime,
} from '@/components/admin/primitives';

export const dynamic = 'force-dynamic';

/**
 * The launch switches.
 *
 * This page is the payoff for making the service registry data. Launching Mart
 * is two form posts — available in a city, then live — and no deploy, no
 * migration, no code change anywhere. If this page needed editing to add a
 * sixth vertical, the registry would have failed at the one thing it exists
 * for, so it reads every service and every city from the database and knows
 * the name of neither.
 *
 * The two switches are ordered the way the decision actually goes. A service
 * with no city cannot be switched on, because a tappable tile that fails at
 * checkout is worse than an honest "coming soon"; and withdrawing the last
 * city switches the service off, for the same reason.
 */
export default async function AdminServicesPage() {
  await requireAdmin();

  const [services, cities, health, auditTrail] = await Promise.all([
    getAllServices(),
    listCities(),
    serviceHealth(),
    listAdminActions({ subjectType: 'Service', limit: 20 }),
  ]);

  const healthByKey = new Map(health.map((row) => [row.key, row] as const));

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-bold">Services</h1>
        <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-ink-muted">
          Launching a vertical is a row change here, not a deploy. Nothing on
          this page names a service — it reads them from the registry, which is
          the reason the registry exists.
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {services.map((service) => {
          const stats = healthByKey.get(service.key);
          const availableCities = cities.filter((city) =>
            service.availableCityIds.includes(city.id),
          );
          const otherCities = cities.filter(
            (city) => !service.availableCityIds.includes(city.id),
          );

          return (
            <Panel
              key={service.key}
              title={service.displayName}
              description={`${service.tagline} · ${humaniseEnum(service.intentGroup)} · ${humaniseEnum(
                service.fulfilmentType,
              )}`}
              action={
                service.isActive ? (
                  <Pill tone="good">Live</Pill>
                ) : service.isComingSoon ? (
                  <Pill tone="warn">Coming soon</Pill>
                ) : (
                  <Pill>Off</Pill>
                )
              }
            >
              <div className="space-y-4 px-4 py-3">
                <dl className="flex flex-wrap gap-x-6 gap-y-1 text-[11px]">
                  <div>
                    <dt className="text-ink-muted">Needs a store</dt>
                    <dd className="font-semibold">{service.requiresMerchant ? 'Yes' : 'No'}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-muted">Needs a partner</dt>
                    <dd className="font-semibold">{service.requiresRider ? 'Yes' : 'No'}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-muted">In flight</dt>
                    <dd className="font-semibold tabular-nums">{stats?.liveOrders ?? 0}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-muted">Today</dt>
                    <dd className="font-semibold tabular-nums">{stats?.ordersToday ?? 0}</dd>
                  </div>
                </dl>

                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                    Available in
                  </p>
                  {availableCities.length === 0 ? (
                    <p className="mt-1 text-xs text-ink-muted">
                      Nowhere yet. Add a city before switching it on.
                    </p>
                  ) : (
                    /* Cities read as a plain list, with withdrawal folded
                       away. A destructive control per city, always open, made
                       this page look like it was mostly for switching things
                       off — which is the opposite of what it is for. */
                    <ul className="mt-1.5 space-y-1.5">
                      {availableCities.map((city) => (
                        <li key={city.id} className="rounded-lg bg-surface-sunken px-2.5 py-2">
                          <div className="flex flex-wrap items-baseline gap-x-2">
                            <span className="text-xs font-semibold">{city.name}</span>
                            <span className="text-[11px] text-ink-faint">{city.province}</span>
                            {!city.isActive ? <Pill tone="warn">City inactive</Pill> : null}
                          </div>
                          <details className="mt-1">
                            <summary className="cursor-pointer text-[11px] font-semibold text-ink-muted hover:text-red-700">
                              Withdraw
                            </summary>
                            <div className="mt-1.5">
                              <ReasonForm
                                action={setServiceCityAction}
                                hidden={{
                                  serviceKey: service.key,
                                  cityId: city.id,
                                  available: 'false',
                                }}
                                submitLabel={`Withdraw from ${city.name}`}
                                tone="danger"
                                placeholder="Why withdraw"
                              />
                            </div>
                          </details>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {otherCities.length > 0 ? (
                  <details className="rounded-lg bg-surface-sunken p-2.5">
                    <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                      Launch in another city
                    </summary>
                    <ul className="mt-2 space-y-2">
                      {otherCities.map((city) => (
                        <li key={city.id}>
                          <p className="text-xs font-semibold">
                            {city.name}
                            <span className="ml-1.5 font-normal text-ink-faint">
                              {city.province}
                            </span>
                          </p>
                          <div className="mt-1">
                            <ReasonForm
                              action={setServiceCityAction}
                              hidden={{
                                serviceKey: service.key,
                                cityId: city.id,
                                available: 'true',
                              }}
                              submitLabel={`Launch in ${city.name}`}
                              placeholder="Why now — the plan, the ticket"
                            />
                          </div>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}

                <div className="border-t border-black/5 pt-3">
                  {service.isActive ? (
                    <details>
                      <summary className="cursor-pointer text-[11px] font-semibold text-ink-muted hover:text-red-700">
                        Switch {service.displayName} off
                      </summary>
                      <div className="mt-2">
                        <ReasonForm
                          action={setServiceActiveAction}
                          hidden={{ serviceKey: service.key, isActive: 'false' }}
                          submitLabel={`Switch ${service.displayName} off`}
                          tone="danger"
                        >
                          The tile becomes &ldquo;coming soon&rdquo; again. Orders
                          already in flight are unaffected — they finish through
                          their own lifecycle.
                        </ReasonForm>
                      </div>
                    </details>
                  ) : (
                    <ReasonForm
                      action={setServiceActiveAction}
                      hidden={{ serviceKey: service.key, isActive: 'true' }}
                      submitLabel={`Make ${service.displayName} live`}
                    >
                      {availableCities.length === 0
                        ? 'It is available in no city, so this will be refused. Add a city first.'
                        : 'The tile becomes tappable for everyone in the cities above. Everywhere else it stays "coming soon".'}
                    </ReasonForm>
                  )}
                </div>
              </div>
            </Panel>
          );
        })}
      </div>

      <Panel
        title="Recent registry changes"
        description="Who launched what, where, and why."
      >
        {auditTrail.length === 0 ? (
          <Empty>Nothing has been changed through the console yet.</Empty>
        ) : (
          <ul className="divide-y divide-black/5">
            {auditTrail.map((event) => (
              <li key={event.id} className="px-4 py-2 text-xs">
                <span className="text-ink-faint">{manilaTime(event.createdAt)}</span>{' '}
                <span className="font-semibold">{event.subjectLabel}</span> —{' '}
                {humaniseEnum(event.action)} by {event.actor.fullName ?? event.actor.phone}
                <p className="mt-0.5 text-ink-muted">{event.reason}</p>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
