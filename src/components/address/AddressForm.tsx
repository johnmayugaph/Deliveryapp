'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LocationPicker } from '@/components/geo/LocationPicker';
import type { TileSource } from '@/lib/geo/tiles';
import type { Coordinate } from '@/lib/geo/philippines';
import { ADDRESS_LIMITS } from '@/lib/addresses/entry';
import {
  createAddressAction,
  type AddressActionResult,
} from '@/lib/actions/address-actions';

/**
 * Adding a delivery address.
 *
 * The pin is the part that matters and the part people skip, so it is not
 * optional and the copy says why: `DeliveryFeeRule` prices by distance from
 * the shop, and a pin on the wrong street is money rather than inconvenience.
 * `LocationPicker` is the same component the store form uses, with the address
 * SEARCH switched off — that search runs through an action gated on
 * `requireAdmin`, so offering it here would render a box that answers "that is
 * only available to an administrator". What is left are the three ways in that
 * work for a customer: tap the map, paste a Google Maps or Waze link, or type
 * the two numbers.
 *
 * The province is not asked for. It comes from the chosen city on the server,
 * because a city knows its province and a second field for it is a way for the
 * two to disagree.
 */

const FIELD =
  'mt-1 w-full rounded-lg bg-surface-sunken px-3 py-2 text-sm ring-1 ring-black/5';

export interface AddressCityOption {
  id: string;
  name: string;
  centroid: Coordinate | null;
}

export function AddressForm({
  cities,
  tiles,
  hasExisting,
}: {
  cities: AddressCityOption[];
  tiles: TileSource;
  /** False for a first address, which is made the default with no choice. */
  hasExisting: boolean;
}) {
  const router = useRouter();
  const [cityId, setCityId] = useState(cities[0]?.id ?? '');
  const [result, submit, pending] = useActionState<AddressActionResult | null, FormData>(
    async (_previous, formData) => createAddressAction(null, formData),
    null,
  );

  // Refresh on success so the list above this form shows the new row.
  useEffect(() => {
    if (result?.ok) router.refresh();
  }, [result, router]);

  const centre = cities.find((city) => city.id === cityId)?.centroid ?? undefined;

  return (
    <form action={submit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-[11px] font-semibold text-ink-muted">
            Name it
          </span>
          <input
            name="label"
            required
            maxLength={ADDRESS_LIMITS.label.max}
            placeholder="Home"
            className={FIELD}
          />
        </label>

        <label className="block">
          <span className="text-[11px] font-semibold text-ink-muted">City</span>
          {/* Controlled for the same reason the store form's is: choosing a
              city should move the map near it rather than leaving somebody to
              pan across the archipelago. */}
          <select
            name="cityId"
            required
            value={cityId}
            onChange={(event) => setCityId(event.target.value)}
            className={FIELD}
          >
            {cities.map((city) => (
              <option key={city.id} value={city.id}>
                {city.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block sm:col-span-2">
          <span className="text-[11px] font-semibold text-ink-muted">
            House or unit number and street
          </span>
          <input
            name="line1"
            required
            minLength={ADDRESS_LIMITS.line1.min}
            maxLength={ADDRESS_LIMITS.line1.max}
            placeholder="24 Kalayaan Ave"
            className={FIELD}
          />
        </label>

        <label className="block">
          <span className="text-[11px] font-semibold text-ink-muted">
            Barangay (optional)
          </span>
          <input
            name="barangay"
            maxLength={ADDRESS_LIMITS.barangay.max}
            placeholder="Barangay 501"
            className={FIELD}
          />
        </label>

        <label className="block">
          <span className="text-[11px] font-semibold text-ink-muted">
            Building or floor (optional)
          </span>
          <input name="line2" maxLength={ADDRESS_LIMITS.line2.max} className={FIELD} />
        </label>
      </div>

      <LocationPicker
        tiles={tiles}
        /* Off deliberately — see the note above. */
        searchAvailable={false}
        heading="Where the rider should come"
        help="Tap the map, or drag the pin. The delivery fee is measured from here, so put it on your building rather than the street."
        {...(centre === undefined ? {} : { centre })}
        centreKey={cityId}
      />

      <label className="block">
        <span className="text-[11px] font-semibold text-ink-muted">
          Landmark (optional)
        </span>
        <input
          name="landmark"
          maxLength={ADDRESS_LIMITS.landmark.max}
          placeholder="Green gate beside the sari-sari store"
          className={FIELD}
        />
      </label>

      <label className="block">
        <span className="text-[11px] font-semibold text-ink-muted">
          For the rider (optional)
        </span>
        <input
          name="deliveryNotes"
          maxLength={ADDRESS_LIMITS.deliveryNotes.max}
          placeholder="Ring twice, dog in the yard"
          className={FIELD}
        />
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-[11px] font-semibold text-ink-muted">
            Who receives it (optional)
          </span>
          <input
            name="contactName"
            maxLength={ADDRESS_LIMITS.contactName.max}
            className={FIELD}
          />
        </label>
        <label className="block">
          <span className="text-[11px] font-semibold text-ink-muted">
            Their number (optional)
          </span>
          <input
            name="contactPhone"
            type="tel"
            inputMode="numeric"
            placeholder="09XX XXX XXXX"
            className={`${FIELD} tabular-nums`}
          />
        </label>
      </div>

      <div className="space-y-1.5">
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" name="isPickupCapable" className="accent-brand-600" />
          Parcels can be collected from here
        </label>
        {hasExisting ? (
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" name="isDefault" className="accent-brand-600" />
            Use this one by default
          </label>
        ) : (
          /* No checkbox for the first address: it becomes the default whatever
             is ticked, so a control that cannot change the outcome would be a
             lie. Said out loud instead. */
          <p className="text-[11px] text-ink-faint">
            Your first address, so it will be the default.
          </p>
        )}
      </div>

      {result && !result.ok && result.message ? (
        <p role="alert" className="text-xs font-semibold text-red-700">
          {result.message}
        </p>
      ) : null}
      {result?.ok ? (
        <p role="status" className="text-xs font-semibold text-emerald-700">
          Saved.
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
      >
        {pending ? 'Saving…' : 'Save this address'}
      </button>
    </form>
  );
}
