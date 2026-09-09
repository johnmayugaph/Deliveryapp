import { isInPhilippines } from '@/lib/geo/philippines';
import { tryNormalisePhilippineMobile } from '@/lib/auth/phone';

/**
 * Saving a new delivery address.
 *
 * Pure, so every rule below is testable without a database — and there are
 * more rules here than the shape of the form suggests, because of what an
 * address is used for in this application. The coordinates are not decoration:
 * `DeliveryFeeRule` prices by distance from the shop, so a transposed pair
 * does not fail, it quietly charges the wrong money. And the same row is the
 * pickup point for a parcel later on, which is why `isPickupCapable` belongs
 * to the address rather than to a flow.
 *
 * ### Why this module exists at all
 *
 * It did not, until a rehearsal on a purged database found there was no way to
 * add an address from the app. `/checkout` said *"You need an address before
 * ordering — Add an address"* and linked to `/addresses`, which answered *"No
 * saved addresses yet."* and offered nothing. The seed writes addresses for
 * the demo accounts, so the gap was invisible until the demo data was purged —
 * which is the first thing a real deployment does.
 *
 * The province is NOT asked for. It is read off the chosen city, because a
 * city already knows its province and a free-text field for it is a way for
 * the two to disagree.
 */

/** Practical field limits, matched to what the columns and a phone screen hold. */
export const ADDRESS_LIMITS = {
  label: { min: 1, max: 40 },
  line1: { min: 4, max: 200 },
  line2: { max: 200 },
  barangay: { max: 120 },
  landmark: { max: 200 },
  deliveryNotes: { max: 300 },
  contactName: { max: 120 },
} as const;

export type AddressFieldError =
  | 'LABEL_MISSING'
  | 'LABEL_TOO_LONG'
  | 'LINE1_TOO_SHORT'
  | 'LINE1_TOO_LONG'
  | 'CITY_UNKNOWN'
  | 'COORDINATES_MISSING'
  | 'COORDINATES_OUTSIDE_PH'
  | 'CONTACT_PHONE_INVALID'
  | 'TOO_LONG';

/**
 * What the person is told.
 *
 * Every message names the field and what to do about it. `TOO_LONG` is the
 * catch-all for the optional fields, where saying which one is worth less than
 * one sentence that fits on a phone.
 */
export const ADDRESS_ERROR_MESSAGES: Readonly<Record<AddressFieldError, string>> = {
  LABEL_MISSING: 'Give this address a name, like Home or Office.',
  LABEL_TOO_LONG: `Keep the name under ${ADDRESS_LIMITS.label.max} characters.`,
  LINE1_TOO_SHORT: 'Write the house or unit number and the street.',
  LINE1_TOO_LONG: `Keep the street address under ${ADDRESS_LIMITS.line1.max} characters.`,
  CITY_UNKNOWN: 'Choose a city we deliver in.',
  COORDINATES_MISSING:
    'Put the pin on the building. The delivery fee is measured from it.',
  COORDINATES_OUTSIDE_PH: 'That pin is not in the Philippines.',
  CONTACT_PHONE_INVALID: 'That is not a Philippine mobile number.',
  TOO_LONG: 'One of the notes is too long. Shorten it and try again.',
};

/** Raw strings, exactly as a form hands them over. */
export interface AddressEntryInput {
  label?: string | undefined;
  line1?: string | undefined;
  line2?: string | undefined;
  barangay?: string | undefined;
  cityId?: string | undefined;
  landmark?: string | undefined;
  deliveryNotes?: string | undefined;
  contactName?: string | undefined;
  contactPhone?: string | undefined;
  latitude?: string | undefined;
  longitude?: string | undefined;
  isPickupCapable?: boolean | undefined;
}

/** A city the deployment actually operates in, with its province. */
export interface CityOption {
  id: string;
  province: string;
}

/**
 * Ready to write. Optional columns are `null` rather than absent, because in a
 * Prisma `data` block `undefined` means "do not change this column" and `null`
 * means "clear it" — and a create that leaves them undefined is one edit away
 * from an update that silently keeps stale text.
 */
export interface AddressEntry {
  label: string;
  line1: string;
  line2: string | null;
  barangay: string | null;
  cityId: string;
  province: string;
  landmark: string | null;
  deliveryNotes: string | null;
  contactName: string | null;
  contactPhone: string | null;
  latitude: number;
  longitude: number;
  isPickupCapable: boolean;
}

export type AddressEntryResult =
  | { ok: true; entry: AddressEntry }
  | { ok: false; error: AddressFieldError };

/** Trimmed, or null when there was nothing but whitespace. */
function optional(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

function withinLimit(value: string | null, max: number): boolean {
  return value === null || value.length <= max;
}

/**
 * Validates and normalises one address.
 *
 * The order of the checks is the order somebody fills the form in, so the
 * first thing they are told about is the first thing they can see.
 */
export function readAddressEntry(
  input: AddressEntryInput,
  cities: readonly CityOption[],
): AddressEntryResult {
  const label = (input.label ?? '').trim();
  if (label.length < ADDRESS_LIMITS.label.min) {
    return { ok: false, error: 'LABEL_MISSING' };
  }
  if (label.length > ADDRESS_LIMITS.label.max) {
    return { ok: false, error: 'LABEL_TOO_LONG' };
  }

  const line1 = (input.line1 ?? '').trim();
  if (line1.length < ADDRESS_LIMITS.line1.min) {
    return { ok: false, error: 'LINE1_TOO_SHORT' };
  }
  if (line1.length > ADDRESS_LIMITS.line1.max) {
    return { ok: false, error: 'LINE1_TOO_LONG' };
  }

  /* Checked against the cities this deployment offers rather than merely being
     non-empty. `City` rows are seed-only, so an id from a hand-edited form is
     either a typo or somebody probing, and both deserve the same answer. */
  const city = cities.find((candidate) => candidate.id === (input.cityId ?? '').trim());
  if (!city) {
    return { ok: false, error: 'CITY_UNKNOWN' };
  }

  const latitude = Number((input.latitude ?? '').trim());
  const longitude = Number((input.longitude ?? '').trim());
  if (
    (input.latitude ?? '').trim() === '' ||
    (input.longitude ?? '').trim() === '' ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude)
  ) {
    return { ok: false, error: 'COORDINATES_MISSING' };
  }
  /* The bounds check is the one that earns its keep: a transposed pair reads as
     a valid number and lands in the sea off Somalia, where the distance-based
     fee is enormous rather than wrong-looking. */
  if (!isInPhilippines({ latitude, longitude })) {
    return { ok: false, error: 'COORDINATES_OUTSIDE_PH' };
  }

  const line2 = optional(input.line2);
  const barangay = optional(input.barangay);
  const landmark = optional(input.landmark);
  const deliveryNotes = optional(input.deliveryNotes);
  const contactName = optional(input.contactName);
  if (
    !withinLimit(line2, ADDRESS_LIMITS.line2.max) ||
    !withinLimit(barangay, ADDRESS_LIMITS.barangay.max) ||
    !withinLimit(landmark, ADDRESS_LIMITS.landmark.max) ||
    !withinLimit(deliveryNotes, ADDRESS_LIMITS.deliveryNotes.max) ||
    !withinLimit(contactName, ADDRESS_LIMITS.contactName.max)
  ) {
    return { ok: false, error: 'TOO_LONG' };
  }

  /* Normalised to E.164 like every other number in the system, so a rider
     tapping it dials the same thing whatever was typed. Blank is fine — the
     contact is the account holder unless somebody says otherwise. */
  const rawContactPhone = optional(input.contactPhone);
  let contactPhone: string | null = null;
  if (rawContactPhone !== null) {
    contactPhone = tryNormalisePhilippineMobile(rawContactPhone);
    if (contactPhone === null) {
      return { ok: false, error: 'CONTACT_PHONE_INVALID' };
    }
  }

  return {
    ok: true,
    entry: {
      label,
      line1,
      line2,
      barangay,
      cityId: city.id,
      province: city.province,
      landmark,
      deliveryNotes,
      contactName,
      contactPhone,
      latitude,
      longitude,
      isPickupCapable: input.isPickupCapable === true,
    },
  };
}

/**
 * Should this new address become the default?
 *
 * The first one always does, and that is not a convenience: `/checkout`
 * pre-selects the default, and an address book whose every entry is
 * non-default makes the first order one extra decision for no reason.
 * Afterwards it is only what the person asked for.
 */
export function shouldBeDefault(input: {
  existingCount: number;
  asked: boolean;
}): boolean {
  return input.existingCount === 0 || input.asked;
}
