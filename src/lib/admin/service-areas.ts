import { centavosFromPesoInput } from '@/lib/money';
import { isInPhilippines } from '@/lib/geo/philippines';

/**
 * The serving area: which cities this deployment operates in, and what
 * delivery costs in each.
 *
 * ### Why this module exists
 *
 * `City` and `DeliveryFeeRule` rows could only be written by
 * `prisma/seed.ts`. Five cities were seeded, and a sixth — Arayat, Pampanga,
 * say — meant editing a TypeScript file, rebuilding and redeploying. That is a
 * developer task standing in front of the most ordinary commercial decision
 * this business makes: *we now deliver in the next town.*
 *
 * ### The two things that have to be created together
 *
 * A city with no delivery fee rule is worse than no city. `quoteDelivery`
 * needs a rule; without one the city appears in the address form and every
 * checkout from it fails. There is a fallback rule per service (`cityId:
 * null`) which covers this — but a deployment that has not set one has a hole
 * a customer discovers, not an operator. So `cityCoverage()` below answers
 * whether a city is actually orderable, and the console renders that answer
 * rather than a list of names.
 *
 * ### Money is pesos in, centavos out
 *
 * An operator thinks in pesos, so the form takes pesos and this module
 * converts. It refuses more than two decimal places rather than rounding —
 * `centavosFromPesoInput` explains why — and it refuses a ceiling below a
 * floor, which is the one combination that produces a fee no arithmetic can
 * satisfy.
 */

// -----------------------------------------------------------------------------
// The city
// -----------------------------------------------------------------------------

export const CITY_LIMITS = {
  name: { min: 2, max: 80 },
  province: { min: 2, max: 80 },
  region: { min: 2, max: 80 },
} as const;

export type CityFieldError =
  | 'NAME_TOO_SHORT'
  | 'NAME_TOO_LONG'
  | 'PROVINCE_MISSING'
  | 'REGION_MISSING'
  | 'CENTRE_MISSING'
  | 'CENTRE_OUTSIDE_PH'
  | 'ID_TAKEN'
  | 'ID_UNUSABLE';

export const CITY_ERROR_MESSAGES: Readonly<Record<CityFieldError, string>> = {
  NAME_TOO_SHORT: 'Write the name of the city or municipality.',
  NAME_TOO_LONG: `Keep the name under ${CITY_LIMITS.name.max} characters.`,
  PROVINCE_MISSING: 'Which province is it in?',
  REGION_MISSING: 'Which region is it in?',
  CENTRE_MISSING:
    'Put the pin on the town centre. It is where the map opens for anybody adding an address here.',
  CENTRE_OUTSIDE_PH: 'That pin is not in the Philippines.',
  ID_TAKEN: 'There is already a city with that name.',
  ID_UNUSABLE:
    'That name has no letters or digits in it, so no identifier can be made from it.',
};

export interface CityEntryInput {
  name?: string | undefined;
  province?: string | undefined;
  region?: string | undefined;
  centroidLat?: string | undefined;
  centroidLng?: string | undefined;
}

export interface CityEntry {
  id: string;
  name: string;
  province: string;
  region: string;
  centroidLat: number;
  centroidLng: number;
}

/**
 * The row id for a city name.
 *
 * `City.id` is a plain `String @id` rather than a cuid, and the seeded rows are
 * `city_manila`, `city_cebu` and so on. That was a deliberate choice — the ids
 * appear in `NEXT_PUBLIC_DEFAULT_CITY_ID`, in `Service.availableCityIds` and in
 * operators' notes, and `cmtum3w2m001h7dt0miq02ga8` is not something anybody
 * can check by eye. So a city added from the console follows the same shape.
 *
 * Returns null when nothing usable is left, which is a refusal rather than a
 * fallback: an id of `city_` would collide with the next such name.
 */
export function cityIdFor(name: string): string | null {
  const slug = name
    .normalize('NFD')
    // Strip combining marks, so "Biñan" becomes "binan" rather than "bian".
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug === '' ? null : `city_${slug}`;
}

export type CityEntryResult =
  | { ok: true; entry: CityEntry }
  | { ok: false; error: CityFieldError };

export function readCityEntry(
  input: CityEntryInput,
  takenIds: readonly string[],
): CityEntryResult {
  const name = (input.name ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < CITY_LIMITS.name.min) return { ok: false, error: 'NAME_TOO_SHORT' };
  if (name.length > CITY_LIMITS.name.max) return { ok: false, error: 'NAME_TOO_LONG' };

  const province = (input.province ?? '').trim().replace(/\s+/g, ' ');
  if (province.length < CITY_LIMITS.province.min) {
    return { ok: false, error: 'PROVINCE_MISSING' };
  }
  const region = (input.region ?? '').trim().replace(/\s+/g, ' ');
  if (region.length < CITY_LIMITS.region.min) {
    return { ok: false, error: 'REGION_MISSING' };
  }

  const id = cityIdFor(name);
  if (id === null) return { ok: false, error: 'ID_UNUSABLE' };
  if (takenIds.includes(id)) return { ok: false, error: 'ID_TAKEN' };

  const rawLat = (input.centroidLat ?? '').trim();
  const rawLng = (input.centroidLng ?? '').trim();
  const centroidLat = Number(rawLat);
  const centroidLng = Number(rawLng);
  if (
    rawLat === '' ||
    rawLng === '' ||
    !Number.isFinite(centroidLat) ||
    !Number.isFinite(centroidLng)
  ) {
    return { ok: false, error: 'CENTRE_MISSING' };
  }
  /* Same bounds check as a delivery address, for a related but distinct
     reason: a city centre off the coast of Somalia does not price anything
     wrongly, it just opens every address map in the wrong hemisphere. Cheap to
     refuse, annoying to discover. */
  if (!isInPhilippines({ latitude: centroidLat, longitude: centroidLng })) {
    return { ok: false, error: 'CENTRE_OUTSIDE_PH' };
  }

  return { ok: true, entry: { id, name, province, region, centroidLat, centroidLng } };
}

// -----------------------------------------------------------------------------
// The delivery fee rule
// -----------------------------------------------------------------------------

export type FeeRuleFieldError =
  | 'BASE_FEE_INVALID'
  | 'PER_KM_INVALID'
  | 'INCLUDED_METRES_INVALID'
  | 'MINIMUM_INVALID'
  | 'MAXIMUM_INVALID'
  | 'MAXIMUM_BELOW_MINIMUM'
  | 'FREE_ABOVE_INVALID'
  | 'SMALL_ORDER_INVALID'
  | 'SMALL_ORDER_FEE_WITHOUT_THRESHOLD'
  | 'SERVICE_FEE_INVALID';

export const FEE_RULE_ERROR_MESSAGES: Readonly<Record<FeeRuleFieldError, string>> = {
  BASE_FEE_INVALID: 'The base fee has to be an amount in pesos, like 39 or 39.50.',
  PER_KM_INVALID: 'The per-kilometre rate has to be an amount in pesos.',
  INCLUDED_METRES_INVALID:
    'Included distance has to be a whole number of metres, like 2000.',
  MINIMUM_INVALID: 'The minimum fee has to be an amount in pesos.',
  MAXIMUM_INVALID: 'The maximum fee has to be an amount in pesos, or blank for none.',
  MAXIMUM_BELOW_MINIMUM:
    'The maximum is below the minimum, so no fee could satisfy both.',
  FREE_ABOVE_INVALID:
    'Free-delivery-above has to be an amount in pesos, or blank to disable it.',
  SMALL_ORDER_INVALID:
    'The small-order threshold has to be an amount in pesos, or blank for none.',
  SMALL_ORDER_FEE_WITHOUT_THRESHOLD:
    'A small-order fee with no threshold would never be charged. Set a threshold, or clear the fee.',
  SERVICE_FEE_INVALID: 'The service fee has to be an amount in pesos.',
};

export interface FeeRuleInput {
  baseFee?: string | undefined;
  perKilometre?: string | undefined;
  includedMeters?: string | undefined;
  minimumFee?: string | undefined;
  maximumFee?: string | undefined;
  freeAboveSubtotal?: string | undefined;
  smallOrderThreshold?: string | undefined;
  smallOrderFee?: string | undefined;
  serviceFee?: string | undefined;
}

/** Ready for a Prisma `data` block. Nullable columns are `null`, not absent. */
export interface FeeRuleEntry {
  baseFeeCentavos: number;
  perKilometreCentavos: number;
  includedMeters: number;
  minimumFeeCentavos: number;
  maximumFeeCentavos: number | null;
  freeAboveSubtotalCentavos: number | null;
  smallOrderThresholdCentavos: number | null;
  smallOrderFeeCentavos: number;
  serviceFeeCentavos: number;
}

export type FeeRuleResult =
  | { ok: true; entry: FeeRuleEntry }
  | { ok: false; error: FeeRuleFieldError };

/** Required peso field. Blank is a refusal, not a zero. */
function required(raw: string | undefined): number | null {
  const value = (raw ?? '').trim();
  if (value === '') return null;
  return centavosFromPesoInput(value);
}

/** Optional peso field: blank means the feature is off. */
function optional(raw: string | undefined): number | null | 'INVALID' {
  const value = (raw ?? '').trim();
  if (value === '') return null;
  const centavos = centavosFromPesoInput(value);
  return centavos === null ? 'INVALID' : centavos;
}

/** Peso field that defaults to zero when blank. */
function zeroable(raw: string | undefined): number | null {
  const value = (raw ?? '').trim();
  if (value === '') return 0;
  return centavosFromPesoInput(value);
}

export function readFeeRule(input: FeeRuleInput): FeeRuleResult {
  const baseFeeCentavos = required(input.baseFee);
  if (baseFeeCentavos === null) return { ok: false, error: 'BASE_FEE_INVALID' };

  const perKilometreCentavos = required(input.perKilometre);
  if (perKilometreCentavos === null) return { ok: false, error: 'PER_KM_INVALID' };

  const rawIncluded = (input.includedMeters ?? '').trim();
  const includedMeters = rawIncluded === '' ? 0 : Number(rawIncluded);
  if (!Number.isInteger(includedMeters) || includedMeters < 0) {
    return { ok: false, error: 'INCLUDED_METRES_INVALID' };
  }

  const minimumFeeCentavos = zeroable(input.minimumFee);
  if (minimumFeeCentavos === null) return { ok: false, error: 'MINIMUM_INVALID' };

  const maximum = optional(input.maximumFee);
  if (maximum === 'INVALID') return { ok: false, error: 'MAXIMUM_INVALID' };
  /* The one combination that cannot be satisfied. `quoteDelivery` clamps to the
     minimum and then to the maximum, so a maximum below the minimum silently
     produces the maximum — a fee below the floor somebody set on purpose. */
  if (maximum !== null && maximum < minimumFeeCentavos) {
    return { ok: false, error: 'MAXIMUM_BELOW_MINIMUM' };
  }

  const freeAbove = optional(input.freeAboveSubtotal);
  if (freeAbove === 'INVALID') return { ok: false, error: 'FREE_ABOVE_INVALID' };

  const smallOrderThreshold = optional(input.smallOrderThreshold);
  if (smallOrderThreshold === 'INVALID') {
    return { ok: false, error: 'SMALL_ORDER_INVALID' };
  }

  const smallOrderFeeCentavos = zeroable(input.smallOrderFee);
  if (smallOrderFeeCentavos === null) return { ok: false, error: 'SMALL_ORDER_INVALID' };
  /* A fee with no threshold is a control that can never fire. Refused rather
     than accepted-and-ignored, because the operator who typed it believes
     small orders are being charged. */
  if (smallOrderFeeCentavos > 0 && smallOrderThreshold === null) {
    return { ok: false, error: 'SMALL_ORDER_FEE_WITHOUT_THRESHOLD' };
  }

  const serviceFeeCentavos = zeroable(input.serviceFee);
  if (serviceFeeCentavos === null) return { ok: false, error: 'SERVICE_FEE_INVALID' };

  return {
    ok: true,
    entry: {
      baseFeeCentavos,
      perKilometreCentavos,
      includedMeters,
      minimumFeeCentavos,
      maximumFeeCentavos: maximum,
      freeAboveSubtotalCentavos: freeAbove,
      smallOrderThresholdCentavos: smallOrderThreshold,
      smallOrderFeeCentavos,
      serviceFeeCentavos,
    },
  };
}

// -----------------------------------------------------------------------------
// Whether a city can actually be ordered from
// -----------------------------------------------------------------------------

/**
 * What is true of one city, for the console.
 *
 * `ORDERABLE` is the only state a customer can transact in. The other three
 * are the ways a city can exist and not work, and each needs different words
 * because each has a different fix — which is the whole reason this is an
 * enum and not a boolean.
 */
export type CityStanding =
  | 'ORDERABLE'
  | 'NO_SERVICE_LAUNCHED'
  | 'NO_FEE_RULE'
  | 'SWITCHED_OFF';

export interface CityFacts {
  isActive: boolean;
  /** Services whose `availableCityIds` name this city AND which are active. */
  launchedServiceKeys: readonly string[];
  /**
   * Service keys with a fee rule that applies here — the city's own rule, or
   * the service's fallback rule. Both count: `quoteDelivery` reads either.
   */
  pricedServiceKeys: readonly string[];
}

export function cityStanding(facts: CityFacts): CityStanding {
  // Switched off first: it makes every other question moot.
  if (!facts.isActive) return 'SWITCHED_OFF';
  if (facts.launchedServiceKeys.length === 0) return 'NO_SERVICE_LAUNCHED';
  /* A launched service with no rule that reaches this city is the trap this
     type exists for: the city shows up in the address form and checkout then
     fails. Only one priced service is needed to be orderable, but the console
     names the ones that are not. */
  const priced = facts.launchedServiceKeys.filter((key) =>
    facts.pricedServiceKeys.includes(key),
  );
  if (priced.length === 0) return 'NO_FEE_RULE';
  return 'ORDERABLE';
}

export interface CityStandingCopy {
  label: string;
  tone: 'good' | 'warn' | 'bad' | 'neutral';
  detail: string;
}

export const CITY_STANDING_COPY: Readonly<Record<CityStanding, CityStandingCopy>> = {
  ORDERABLE: {
    label: 'Taking orders',
    tone: 'good',
    detail: 'A service is live here and delivery is priced.',
  },
  NO_SERVICE_LAUNCHED: {
    label: 'No service yet',
    tone: 'warn',
    detail:
      'Customers here see "no service is available in your area yet". Launch a service in this city on the Services screen.',
  },
  NO_FEE_RULE: {
    label: 'Not priced',
    tone: 'bad',
    detail:
      'A service is live here but nothing prices delivery, so checkout will fail rather than refuse politely. Add a fee rule below, or a fallback rule for the service.',
  },
  SWITCHED_OFF: {
    label: 'Switched off',
    tone: 'neutral',
    detail:
      'Hidden from the address form and from every service. Existing addresses and orders here are untouched.',
  },
};
