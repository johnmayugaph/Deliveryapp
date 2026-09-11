'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ServiceKey } from '@prisma/client';
import type { AdminActionResult } from '@/lib/admin/access';
import { MIN_AUDIT_REASON_LENGTH } from '@/lib/admin/audit-reason';
import { updateStoreProfileAction } from '@/lib/actions/admin-actions';
import { LocationPicker } from '@/components/geo/LocationPicker';
import type { TileSource } from '@/lib/geo/tiles';

const FIELD =
  'mt-1 w-full rounded-lg border border-black/10 bg-surface px-2.5 py-1.5 text-[13px]';

/**
 * Everything about one shop, on one form, behind one button.
 *
 * WHAT THIS REPLACED. The shop's details were scattered: the commission had
 * its own panel, the logo had another, the prep time was only in the shop's
 * own back office, and the name, address, city, coordinates and services could
 * not be changed anywhere at all — onboarding a partner who gave you a wrong
 * address meant a psql prompt. Somebody managing a shop had to know which of
 * four screens held the field they wanted, and two of those screens did not
 * exist.
 *
 * The sections below are the same shape as the panels they replaced, so the
 * page still reads as a page rather than as one long column of inputs. They
 * are sections of a single form, not separate forms: a partner call where the
 * shop corrects three things across two sections should be one save.
 *
 * Two things stay OUT of this form, deliberately:
 *
 *  - The **logo and banner**, which are file pickers with their own controls.
 *    Folding them in would mean re-uploading two images to fix a phone number.
 *  - **Active / inactive**, which is one bit flipped far more often than
 *    anything here. Behind a Save button it is slower in the one case where
 *    speed matters.
 */
export function StoreProfileForm({
  store,
  cities,
  services,
  tiles,
  searchAvailable,
}: {
  store: {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    contactPhone: string | null;
    cityId: string;
    addressLine: string;
    latitude: number;
    longitude: number;
    serviceKeys: ServiceKey[];
    preparationMinutes: number;
    commissionBasisPoints: number;
  };
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
  const router = useRouter();
  const [cityId, setCityId] = useState(store.cityId);
  const [commission, setCommission] = useState(String(store.commissionBasisPoints));

  const chosen = cities.find((city) => city.id === cityId);
  const centre =
    chosen && chosen.centroidLat !== null && chosen.centroidLng !== null
      ? { latitude: chosen.centroidLat, longitude: chosen.centroidLng }
      : undefined;

  const [result, submit, pending] = useActionState<AdminActionResult | null, FormData>(
    updateStoreProfileAction,
    null,
  );

  // The server revalidated its copy; the page on screen was rendered before
  // the change and nothing else tells it.
  useEffect(() => {
    if (result?.ok) router.refresh();
  }, [result, router]);

  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  const points = Number(commission);
  const percent = Number.isFinite(points) ? (points / 100).toFixed(2) : '—';

  // The hidden field sits OUTSIDE the spaced stack below. As the first child
  // of `space-y-*` it took the un-margined slot for itself, which pushed the
  // first section down by a row of whitespace nobody asked for.
  return (
    <form action={submit}>
      <input type="hidden" name="storeId" value={store.id} />
      <div className="space-y-5">
        <Section
        title="Shop"
        note="Name, description and the number to ring. What customers see at the top of the shop's page."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="text-[11px] font-semibold text-ink-muted">Shop name</span>
            <input
              name="name"
              defaultValue={store.name}
              required
              minLength={2}
              maxLength={120}
              className={FIELD}
            />
          </label>

          <label className="block">
            <span className="text-[11px] font-semibold text-ink-muted">
              Contact number <span className="font-normal text-ink-faint">(optional)</span>
            </span>
            <input
              name="contactPhone"
              defaultValue={store.contactPhone ?? ''}
              type="tel"
              inputMode="numeric"
              placeholder="09XX XXX XXXX"
              className={`${FIELD} tabular-nums`}
            />
          </label>

          <label className="block sm:col-span-2">
            <span className="text-[11px] font-semibold text-ink-muted">
              Description <span className="font-normal text-ink-faint">(optional)</span>
            </span>
            <textarea
              name="description"
              defaultValue={store.description ?? ''}
              rows={2}
              maxLength={500}
              className={FIELD}
            />
          </label>

          {/*
            * READ ONLY, and this is the one field on the page that is.
            *
            * The slug is the shop's public address. Changing it turns every
            * link a customer saved, every link the shop posted, and every
            * search result into a 404 — silently, with nothing here to say so.
            * Shown because an operator needs to copy it; changed by somebody
            * who can also put a redirect in front of it.
            */}
          <div className="sm:col-span-2">
            <span className="text-[11px] font-semibold text-ink-muted">
              Storefront address
            </span>
            <p className="mt-1 rounded-lg bg-surface-sunken px-2.5 py-1.5 font-mono text-[12px] text-ink-muted ring-1 ring-black/5">
              /stores/{store.slug}
            </p>
            <p className="mt-1 text-[11px] text-ink-faint">
              Fixed on purpose — changing it would break every link customers
              and search engines already have.
            </p>
          </div>
        </div>
      </Section>

      <Section
        title="Where it is"
        note="The pin is what every delivery fee from this shop is measured from."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="text-[11px] font-semibold text-ink-muted">City</span>
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

          <label className="block">
            <span className="text-[11px] font-semibold text-ink-muted">Address</span>
            <input
              name="addressLine"
              defaultValue={store.addressLine}
              required
              minLength={4}
              maxLength={300}
              className={FIELD}
            />
          </label>
        </div>

        <div className="mt-3">
          <LocationPicker
            tiles={tiles}
            searchAvailable={searchAvailable}
            initial={{ latitude: store.latitude, longitude: store.longitude }}
            {...(centre === undefined ? {} : { centre })}
            centreKey={cityId}
          />
        </div>
      </Section>

      <Section
        title="Services and timing"
        note="Which verticals this shop is orderable in, and how long it says it needs."
      >
        <fieldset>
          <legend className="text-[11px] font-semibold text-ink-muted">
            Services this shop is for
          </legend>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
            {services.map((service) => (
              <label key={service.key} className="flex items-center gap-1.5 text-[13px]">
                <input
                  type="checkbox"
                  name="serviceKeys"
                  value={service.key}
                  defaultChecked={store.serviceKeys.includes(service.key)}
                />
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

        <label className="mt-3 block max-w-xs">
          <span className="text-[11px] font-semibold text-ink-muted">
            Prep time, in minutes
          </span>
          <input
            name="preparationMinutes"
            type="number"
            min={1}
            max={180}
            defaultValue={store.preparationMinutes}
            required
            className={`${FIELD} tabular-nums`}
          />
          <span className="mt-1 block text-[11px] text-ink-faint">
            The shop can change this too, from its own back office. Whatever is
            set here is snapshotted onto an order at checkout, so a later edit
            never rewrites history.
          </span>
        </label>
      </Section>

      <Section
        title="Commission"
        note="What TARA keeps from this shop's food, on the subtotal only."
      >
        <label className="block max-w-xs">
          <span className="text-[11px] font-semibold text-ink-muted">
            Basis points
          </span>
          <input
            name="commissionBasisPoints"
            type="number"
            min={0}
            step={1}
            value={commission}
            onChange={(event) => setCommission(event.target.value)}
            required
            className={`${FIELD} tabular-nums`}
          />
          {/* Shown because "250" is not a number anybody reasons about, and a
              mistyped zero is the difference between 2.5% and 25%. */}
          <span className="mt-1 block text-[11px] font-semibold text-ink-muted">
            = {percent}% of the subtotal
          </span>
        </label>
        <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
          Never taken from the tip, which is the rider&apos;s entirely, and never
          from the delivery fee, which is what the rider is paid for the ride.
          Orders already settled keep the rate they settled at.
        </p>
        {/* The settlement screen also sets this, for every shop at once. Not a
            duplicate by accident: setting one shop's rate during a partner call
            and reviewing the whole estate's rates are different jobs. Same
            column, so the two cannot drift apart. */}
      </Section>

      <div className="rounded-xl bg-surface-sunken p-3 ring-1 ring-black/5">
        <label className="block">
          <span className="text-[11px] font-semibold text-ink-muted">
            Why (recorded against your name)
          </span>
          <input
            name="reason"
            required
            minLength={MIN_AUDIT_REASON_LENGTH}
            maxLength={500}
            placeholder="Shop called — moved to the corner unit"
            className={FIELD}
          />
        </label>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={pending || !hydrated}
            className="rounded-lg bg-brand-600 px-4 py-2 text-[13px] font-bold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-ink-faint"
          >
            {pending ? 'Saving…' : 'Save changes'}
          </button>

          {result ? (
            <p
              role={result.ok ? 'status' : 'alert'}
              className={`text-[12px] leading-relaxed ${
                result.ok ? 'text-emerald-800' : 'text-rose-700'
              }`}
            >
              {result.message}
            </p>
          ) : null}
        </div>
        </div>
      </div>
    </form>
  );
}

/** A titled block inside the one form. Not a Panel: a Panel is a card, and a
 *  stack of cards inside a single form reads as a stack of separate forms —
 *  which is exactly the impression this page was rebuilt to get rid of. */
function Section({
  title,
  note,
  children,
}: {
  title: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    // `first-of-type`, not `first-child`: the form's first child is a hidden
    // input, so `first-child` never matched and the top section drew a divider
    // above itself with nothing on the other side of it.
    <section className="border-t border-black/5 pt-4 first-of-type:border-0 first-of-type:pt-0">
      <h3 className="text-[13px] font-bold">{title}</h3>
      <p className="mt-0.5 mb-3 text-[11px] text-ink-muted">{note}</p>
      {children}
    </section>
  );
}
