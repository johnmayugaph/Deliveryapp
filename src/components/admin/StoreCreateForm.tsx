'use client';

import { useActionState, useEffect, useState } from 'react';
import type { ServiceKey } from '@prisma/client';
import type { AdminActionResult } from '@/lib/admin/access';
import { createStoreAction } from '@/lib/actions/admin-actions';
import { LocationPicker } from '@/components/admin/LocationPicker';
import type { TileSource } from '@/lib/geo/tiles';

/**
 * Adding a partner shop.
 *
 * A dedicated form rather than `ReasonForm` with eight extra fields, but the
 * same rule applies and the reason field is at the bottom for the same reason:
 * this hands somebody control of a real business, and the audit row is worth
 * nothing without a sentence saying who asked.
 *
 * The services list comes from the registry, including the verticals that have
 * not launched. A shop can be marked for MART today and starts appearing the
 * day MART is switched on, with no second visit to this screen.
 *
 * The coordinates are a map rather than two number fields, and that is not
 * cosmetic: every delivery fee from this shop is measured from them, so a
 * transposed pair does not fail — it charges the wrong money forever. See
 * `LocationPicker`.
 */

const FIELD =
  'mt-1 w-full rounded-lg border border-black/10 bg-surface px-2.5 py-1.5 text-[13px]';

export function StoreCreateForm({
  cities,
  services,
  tiles,
  searchAvailable,
}: {
  cities: {
    id: string;
    name: string;
    centroidLat: number | null;
    centroidLng: number | null;
  }[];
  services: { key: ServiceKey; displayName: string; isActive: boolean }[];
  tiles: TileSource;
  searchAvailable: boolean;
}) {
  const [cityId, setCityId] = useState('');

  const chosen = cities.find((city) => city.id === cityId);
  const centre =
    chosen && chosen.centroidLat !== null && chosen.centroidLng !== null
      ? { latitude: chosen.centroidLat, longitude: chosen.centroidLng }
      : undefined;

  const [result, submit, pending] = useActionState<AdminActionResult | null, FormData>(
    async (_previous, formData) => createStoreAction(formData),
    null,
  );

  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  return (
    <form action={submit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-[11px] font-semibold text-ink-muted">Shop name</span>
          <input name="name" required minLength={2} maxLength={120} className={FIELD} />
        </label>

        <label className="block">
          <span className="text-[11px] font-semibold text-ink-muted">City</span>
          {/* Controlled, and the one reason is the map: choosing a city should
              move it near the shop rather than leaving somebody to pan across
              the archipelago. */}
          <select
            name="cityId"
            required
            value={cityId}
            onChange={(event) => setCityId(event.target.value)}
            className={FIELD}
          >
            <option value="" disabled>
              Choose…
            </option>
            {cities.map((city) => (
              <option key={city.id} value={city.id}>
                {city.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block sm:col-span-2">
          <span className="text-[11px] font-semibold text-ink-muted">Address</span>
          <input
            name="addressLine"
            required
            minLength={4}
            maxLength={300}
            placeholder="24 Kalayaan Ave, Barangay 501"
            className={FIELD}
          />
        </label>

        <label className="block sm:col-span-2">
          <span className="text-[11px] font-semibold text-ink-muted">
            Owner&apos;s mobile number
          </span>
          <input
            name="ownerPhone"
            required
            type="tel"
            inputMode="numeric"
            placeholder="09XX XXX XXXX"
            className={`${FIELD} tabular-nums`}
          />
        </label>
      </div>

      {/* Its own block below the text fields rather than a cell in the grid:
          it is a map, and squeezing it into half a row makes it useless for
          the one thing it is for. */}
      <LocationPicker
        tiles={tiles}
        searchAvailable={searchAvailable}
        {...(centre === undefined ? {} : { centre })}
        centreKey={cityId}
      />

      <fieldset>
        <legend className="text-[11px] font-semibold text-ink-muted">
          Services this shop is for
        </legend>
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
          {services.map((service) => (
            <label key={service.key} className="flex items-center gap-1.5 text-[13px]">
              <input type="checkbox" name="serviceKeys" value={service.key} />
              {service.displayName}
              {service.isActive ? null : (
                <span className="text-[10px] uppercase tracking-wide text-ink-faint">
                  soon
                </span>
              )}
            </label>
          ))}
        </div>
      </fieldset>

      <label className="block">
        <span className="text-[11px] font-semibold text-ink-muted">
          Reason, for the audit log
        </span>
        <input
          name="reason"
          required
          minLength={8}
          maxLength={500}
          placeholder="Signed partner agreement, onboarding call 7 Sep"
          className={FIELD}
        />
      </label>

      <p className="text-[11px] leading-relaxed text-ink-faint">
        Created hidden from customers. Make it visible once the owner has entered
        a menu — a shop somebody can find and open but not order from reads as a
        broken app.
      </p>

      <button
        type="submit"
        disabled={pending || !hydrated}
        className="rounded-lg bg-brand-700 px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:bg-ink-faint"
      >
        {pending ? 'Creating…' : 'Create store'}
      </button>

      {result ? (
        <p
          role="status"
          className={`text-xs leading-relaxed ${
            result.ok ? 'text-emerald-700' : 'text-red-700'
          }`}
        >
          {result.message}
        </p>
      ) : null}
    </form>
  );
}
