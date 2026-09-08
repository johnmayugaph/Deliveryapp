import { ServiceKey } from '@prisma/client';
import { requireAdmin } from '@/lib/admin/access';
import {
  allSurgeBands,
  cityMarkets,
  lastMeasuredAt,
  recentSnapshots,
} from '@/lib/admin/surge';
import {
  SNAPSHOT_MAX_AGE_SECONDS,
  SURGE_CEILING_CENTAVOS,
  SURGE_REASON_TEXT,
} from '@/lib/pricing/surge-policy';
import { formatCentavos } from '@/lib/money';
import { ReasonForm } from '@/components/admin/ReasonForm';
import {
  createSurgeBandAction,
  setSurgeBandActiveAction,
  updateSurgeBandAction,
} from '@/lib/actions/admin-actions';
import {
  Empty,
  Panel,
  Pill,
  Stat,
  TableScroll,
  Td,
  Th,
  humaniseEnum,
  manilaTime,
} from '@/components/admin/primitives';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

/**
 * Surge.
 *
 * The screen answers two questions that look like one. "How busy is it?" is
 * measured live, here, on load — a screen may move, since nobody is billed
 * from it. "What is a customer being charged?" comes from the newest snapshot,
 * which is the identical read a quote does.
 *
 * Showing them side by side is the point. When the live ratio has earned ₱40
 * and the charge says ₱0, exactly two things can be true: the market moved in
 * the last few seconds, or the cron has stopped and surge has quietly switched
 * itself off. The second is invisible from anywhere else in the app — every
 * uncertainty in this feature resolves to charging nothing, which is the right
 * default and also a silent one. Hence the "last measured" line at the top.
 *
 * Nothing on this page prices anything. It edits the LADDER; the money is
 * decided a minute later by the cron, from the rows this page writes.
 */

/** The peso amount and the threshold — the fields both band forms share. */
function BandFields({
  defaultThreshold,
  defaultPesos,
  defaultLabel,
}: {
  defaultThreshold?: string;
  defaultPesos?: string;
  defaultLabel?: string;
}) {
  return (
    <div className="grid grid-cols-3 gap-2">
      <label className="block">
        <span className="text-[11px] font-semibold text-ink-muted">
          Orders per rider
        </span>
        <input
          name="minOrdersPerRider"
          inputMode="decimal"
          defaultValue={defaultThreshold}
          placeholder="1.5"
          className="mt-0.5 w-full rounded-lg bg-surface px-2.5 py-1.5 text-[13px] tabular-nums ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
      </label>
      <label className="block">
        <span className="text-[11px] font-semibold text-ink-muted">Adds (₱)</span>
        <input
          name="surgePesos"
          inputMode="decimal"
          defaultValue={defaultPesos}
          placeholder="20"
          className="mt-0.5 w-full rounded-lg bg-surface px-2.5 py-1.5 text-[13px] tabular-nums ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
      </label>
      <label className="block">
        <span className="text-[11px] font-semibold text-ink-muted">
          Name the customer sees
        </span>
        <input
          name="label"
          defaultValue={defaultLabel}
          placeholder="Busy"
          maxLength={40}
          className="mt-0.5 w-full rounded-lg bg-surface px-2.5 py-1.5 text-[13px] ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
      </label>
    </div>
  );
}

export default async function AdminSurgePage() {
  await requireAdmin();

  const now = new Date();
  const [markets, bands, measuredAt, cities, services] = await Promise.all([
    cityMarkets(now),
    allSurgeBands(),
    lastMeasuredAt(),
    prisma.city.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    prisma.service.findMany({
      where: { requiresRider: true },
      select: { key: true, displayName: true },
      orderBy: { sortOrder: 'asc' },
    }),
  ]);

  const surging = markets.filter((market) => market.charging.surgeCentavos > 0);
  const ageSeconds =
    measuredAt === null ? null : (now.getTime() - measuredAt.getTime()) / 1_000;
  const cronLooksStopped = ageSeconds === null || ageSeconds > SNAPSHOT_MAX_AGE_SECONDS;

  // The busiest market gets its recent history shown, because a spike is the
  // thing somebody comes to this screen to look into and it is over by the
  // time they arrive.
  const busiest = [...markets].sort((a, b) => b.ratio - a.ratio)[0];
  const history = busiest
    ? await recentSnapshots(busiest.serviceType, busiest.cityId)
    : [];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-bold">Surge</h1>
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-ink-muted">
          Surge is a flat peso step added to the delivery fee when orders
          outnumber available riders, and every centavo of it goes to the rider.
          It is off wherever no step is configured. Steps take effect at the next
          measurement — within a minute or two — and never change an order
          already placed.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Markets surging"
          value={`${surging.length} of ${markets.length}`}
          note="Live service and city pairs charging above the plain fee"
        />
        <Stat
          label="Steps configured"
          value={String(bands.filter((band) => band.isActive).length)}
          note={
            bands.length === 0
              ? 'None — surge is off everywhere'
              : `${bands.length - bands.filter((b) => b.isActive).length} switched off`
          }
        />
        <Stat
          label="Last measured"
          value={measuredAt ? manilaTime(measuredAt) : 'Never'}
          note={
            cronLooksStopped
              ? 'Older than the freshness window — quotes are charging nothing'
              : 'The sweep is running'
          }
        />
      </div>

      {cronLooksStopped && bands.length > 0 ? (
        <p
          role="alert"
          className="rounded-xl bg-rose-50 px-4 py-3 text-xs leading-relaxed text-rose-800 ring-1 ring-rose-200"
        >
          <span className="font-semibold">Nothing has been measured recently.</span>{' '}
          A snapshot older than {SNAPSHOT_MAX_AGE_SECONDS / 60} minutes is not
          priced from, so surge is currently adding nothing anywhere no matter
          what the steps below say. That is the safe direction, but it means the
          maintenance sweep (<code>npm run jobs:orders</code>) is not running.
        </p>
      ) : null}

      <Panel
        title="The market right now"
        description="Measured on load. The charge column is the snapshot a quote would read, so the two disagreeing means the market has just moved — or the sweep has stopped."
      >
        {markets.length === 0 ? (
          <Empty>
            No service is live in any city yet, so there is no market to measure.
          </Empty>
        ) : (
          <TableScroll>
            <thead>
              <tr>
                <Th>Service</Th>
                <Th>City</Th>
                <Th numeric>Waiting</Th>
                <Th numeric>Riders free</Th>
                <Th numeric>Per rider</Th>
                <Th numeric>Charging</Th>
                <Th>Why</Th>
              </tr>
            </thead>
            <tbody>
              {markets.map((market) => (
                <tr key={`${market.serviceType}:${market.cityId}`}>
                  <Td>{humaniseEnum(market.serviceType)}</Td>
                  <Td>{market.cityName}</Td>
                  <Td numeric>{market.ordersWaiting}</Td>
                  <Td numeric>{market.ridersAvailable}</Td>
                  <Td numeric>{market.ratio.toFixed(2)}</Td>
                  <Td numeric>
                    {market.charging.surgeCentavos > 0 ? (
                      <span className="font-semibold">
                        {formatCentavos(market.charging.surgeCentavos)}
                      </span>
                    ) : (
                      <span className="text-ink-faint">—</span>
                    )}
                  </Td>
                  <Td muted>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Pill
                        tone={
                          market.charging.reason === 'BUSY'
                            ? 'warn'
                            : market.charging.reason === 'STALE'
                              ? 'bad'
                              : 'neutral'
                        }
                      >
                        {market.charging.label ??
                          humaniseEnum(market.charging.reason)}
                      </Pill>
                      <span className="text-[11px] leading-relaxed">
                        {SURGE_REASON_TEXT[market.charging.reason]}
                      </span>
                      {market.wouldCharge !== market.charging.surgeCentavos ? (
                        <span className="text-[11px] font-semibold text-amber-800">
                          The live ratio has earned{' '}
                          {market.wouldCharge > 0
                            ? formatCentavos(market.wouldCharge)
                            : 'nothing'}
                          .
                        </span>
                      ) : null}
                      {market.misorderedStep ? (
                        <span className="text-[11px] font-semibold text-rose-700">
                          “{market.misorderedStep.label}” adds less than the step
                          below it and will never be reached.
                        </span>
                      ) : null}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        )}
      </Panel>

      <Panel
        title="Steps"
        description={`A step applies at or above its threshold, and the largest amount the market has earned is the one charged. One step may add at most ${formatCentavos(SURGE_CEILING_CENTAVOS)}.`}
      >
        {bands.length === 0 ? (
          <Empty>
            No steps anywhere, so surge adds nothing to any order. Add one below
            to switch it on for a service and city.
          </Empty>
        ) : (
          <TableScroll>
            <thead>
              <tr>
                <Th>Service</Th>
                <Th>City</Th>
                <Th numeric>At orders/rider</Th>
                <Th numeric>Adds</Th>
                <Th>Name shown</Th>
                <Th>Edit</Th>
                <Th>On</Th>
              </tr>
            </thead>
            <tbody>
              {bands.map((band) => (
                <tr key={band.id} className={band.isActive ? '' : 'opacity-60'}>
                  <Td>{humaniseEnum(band.serviceType)}</Td>
                  <Td>
                    {band.city?.name ?? (
                      <span className="text-ink-muted">All cities</span>
                    )}
                  </Td>
                  <Td numeric>{band.minOrdersPerRider}</Td>
                  <Td numeric>{formatCentavos(band.surgeCentavos)}</Td>
                  <Td>
                    <Pill tone={band.isActive ? 'warn' : 'neutral'}>{band.label}</Pill>
                  </Td>
                  <Td>
                    <ReasonForm
                      action={updateSurgeBandAction}
                      hidden={{ bandId: band.id }}
                      submitLabel="Save"
                      extraFields={
                        <BandFields
                          defaultThreshold={String(band.minOrdersPerRider)}
                          defaultPesos={(band.surgeCentavos / 100).toFixed(2)}
                          defaultLabel={band.label}
                        />
                      }
                    />
                  </Td>
                  <Td>
                    <ReasonForm
                      action={setSurgeBandActiveAction}
                      hidden={{ bandId: band.id, isActive: String(!band.isActive) }}
                      submitLabel={band.isActive ? 'Switch off' : 'Switch on'}
                      tone={band.isActive ? 'danger' : 'default'}
                    />
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        )}
      </Panel>

      <Panel
        title="Add a step"
        description="Leave the city blank for a fallback that applies wherever the service is live. A city's own steps replace the fallback entirely rather than adding to it."
      >
        <div className="px-4 py-3">
          <ReasonForm
            action={createSurgeBandAction}
            hidden={{}}
            submitLabel="Add the step"
            extraFields={
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="text-[11px] font-semibold text-ink-muted">
                      Service
                    </span>
                    <select
                      name="serviceType"
                      defaultValue={ServiceKey.FOOD}
                      className="mt-0.5 w-full rounded-lg bg-surface px-2.5 py-1.5 text-[13px] ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
                    >
                      {services.map((service) => (
                        <option key={service.key} value={service.key}>
                          {service.displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-[11px] font-semibold text-ink-muted">
                      City
                    </span>
                    <select
                      name="cityId"
                      defaultValue=""
                      className="mt-0.5 w-full rounded-lg bg-surface px-2.5 py-1.5 text-[13px] ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
                    >
                      <option value="">All cities (fallback)</option>
                      {cities.map((city) => (
                        <option key={city.id} value={city.id}>
                          {city.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <BandFields />
              </div>
            }
          >
            Every centavo of this goes to the rider who takes the job. It is
            added to the delivery fee as its own named line, so the customer sees
            what it is.
          </ReasonForm>
        </div>
      </Panel>

      {busiest && history.length > 0 ? (
        <Panel
          title={`Recent measurements — ${humaniseEnum(busiest.serviceType)} in ${busiest.cityName}`}
          description="How the busiest market has moved. A complaint about a charge an hour ago is answered from these rows, not from the numbers above."
        >
          <TableScroll>
            <thead>
              <tr>
                <Th>Measured</Th>
                <Th numeric>Waiting</Th>
                <Th numeric>Riders free</Th>
                <Th numeric>Per rider</Th>
                <Th numeric>Added</Th>
                <Th>Step</Th>
              </tr>
            </thead>
            <tbody>
              {history.map((row) => (
                <tr key={row.id}>
                  <Td>{manilaTime(row.createdAt)}</Td>
                  <Td numeric>{row.ordersWaiting}</Td>
                  <Td numeric>{row.ridersAvailable}</Td>
                  <Td numeric>{row.ratio.toFixed(2)}</Td>
                  <Td numeric>
                    {row.surgeCentavos > 0 ? formatCentavos(row.surgeCentavos) : '—'}
                  </Td>
                  <Td muted>{row.bandLabel ?? 'Calm'}</Td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        </Panel>
      ) : null}
    </div>
  );
}
