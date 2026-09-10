'use client';

import { useState } from 'react';
import { LocationPicker } from '@/components/geo/LocationPicker';
import type { TileSource } from '@/lib/geo/tiles';
import { CITY_LIMITS, cityIdFor } from '@/lib/admin/service-areas';
import { createCityAction } from '@/lib/actions/admin-actions';
import { ReasonForm } from '@/components/admin/ReasonForm';

/**
 * Adding a city to the serving area.
 *
 * The one thing this does beyond collecting four fields: it shows the derived
 * identifier as you type the name. `City.id` is a readable slug rather than a
 * cuid and it cannot be changed afterwards, so seeing `city_arayat` appear
 * before submitting is the difference between a considered id and one somebody
 * discovers later in `NEXT_PUBLIC_DEFAULT_CITY_ID`.
 *
 * The map centre is where the address form opens for anybody adding an address
 * in this city. It is not used to price anything — the fee is measured between
 * a shop and an address — so it is a convenience rather than money, which is
 * why the copy asks for the town centre rather than a building.
 */

const FIELD =
  'mt-1 w-full rounded-lg bg-surface-sunken px-3 py-2 text-sm ring-1 ring-black/5';
const LABEL = 'text-[11px] font-semibold text-ink-muted';

export function CityCreateForm({ tiles }: { tiles: TileSource }) {
  const [name, setName] = useState('');
  const derivedId = cityIdFor(name);

  return (
    <ReasonForm
      action={createCityAction}
      hidden={{}}
      submitLabel="Add this city"
      extraFields={
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block">
              <span className={LABEL}>City or municipality</span>
              <input
                name="name"
                required
                minLength={CITY_LIMITS.name.min}
                maxLength={CITY_LIMITS.name.max}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Arayat"
                className={FIELD}
              />
              {/* Shown live, because the id is permanent and the name is not. */}
              <span className="mt-0.5 block text-[10px] text-ink-faint">
                {derivedId === null
                  ? 'The identifier is made from this name.'
                  : `Identifier: ${derivedId}`}
              </span>
            </label>
            <label className="block">
              <span className={LABEL}>Province</span>
              <input
                name="province"
                required
                minLength={CITY_LIMITS.province.min}
                maxLength={CITY_LIMITS.province.max}
                placeholder="Pampanga"
                className={FIELD}
              />
            </label>
            <label className="block">
              <span className={LABEL}>Region</span>
              <input
                name="region"
                required
                minLength={CITY_LIMITS.region.min}
                maxLength={CITY_LIMITS.region.max}
                placeholder="Central Luzon"
                className={FIELD}
              />
            </label>
          </div>

          <LocationPicker
            tiles={tiles}
            /* The address search is gated on requireAdmin and this form is
               admin-only, so unlike the customer's address form it can be
               offered here. */
            searchAvailable
            heading="Town centre"
            help="Tap the map, or drag the pin. This is only where the map opens for somebody adding an address here — the delivery fee is measured between a shop and an address, not from this pin."
          />
        </div>
      }
    >
      Adding a city does not open it for business: launch a service in it on the
      Services screen, and make sure that service has a delivery fee rule that
      reaches it.
    </ReasonForm>
  );
}
