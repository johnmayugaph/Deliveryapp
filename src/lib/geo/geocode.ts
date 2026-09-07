import { isInPhilippines, type Coordinate } from './philippines';

/**
 * Turning "Aling Nena, Tondo" into a place on the map.
 *
 * Goes through the SERVER, and that is the decision worth explaining. Calling
 * a geocoder from the browser would be simpler, and it is what most tutorials
 * do — but:
 *
 *  - **Nominatim's usage policy asks for a `User-Agent` identifying the
 *    application.** A browser cannot set one. Server-side, TARA can say who it
 *    is, which is the difference between being a good citizen of a free
 *    service and being an anonymous source of traffic somebody eventually
 *    blocks.
 *  - **The policy caps requests at one a second.** A throttle in one place is
 *    a throttle; a throttle in every operator's browser tab is a hope.
 *  - **It keeps the third party at arm's length**, exactly like the SMS
 *    gateway, the push service and the CAPTCHA verifier. Nothing in this
 *    application lets a browser talk to somebody else's API directly.
 *
 * The action that calls this requires an administrator, so this is not an open
 * geocoding proxy for anybody who finds the endpoint.
 *
 * NONE OF IT IS LOAD-BEARING. Address search is a convenience on top of three
 * ways of setting a coordinate that already work — tapping the map, pasting a
 * link, typing the numbers. When the geocoder is unreachable or switched off,
 * the box says so and the rest of the form is unaffected.
 */

/**
 * Nominatim, which is OpenStreetMap's own and free.
 *
 * `GEOCODER_URL` exists for the same reason `MAP_TILE_URL` does: the policy
 * permits light use, an operator console is light, and the day that stops
 * being true the answer is a paid provider or a self-hosted instance rather
 * than a policy email.
 */
export const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

/** Nominatim's policy: at most one request a second, from the whole application. */
export const MIN_REQUEST_GAP_MS = 1_100;

/** Below this, a search is a waste of somebody else's server. */
export const MIN_QUERY_LENGTH = 3;
export const MAX_QUERY_LENGTH = 160;
/** More than a handful of candidates is a list nobody reads. */
export const MAX_CANDIDATES = 5;

export interface GeocodeCandidate {
  /** What the person reads: "Aling Nena Carinderia, Tondo, Manila". */
  label: string;
  point: Coordinate;
}

export type GeocodeFailure =
  | 'NOT_CONFIGURED'
  | 'TOO_SHORT'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'NOTHING_FOUND';

export type GeocodeOutcome =
  | { ok: true; candidates: GeocodeCandidate[] }
  | { ok: false; reason: GeocodeFailure };

/** One sentence each, for the form. */
export const GEOCODE_FAILURE_MESSAGE: Readonly<Record<GeocodeFailure, string>> = {
  NOT_CONFIGURED:
    'Address search is switched off on this deployment. Tap the map, paste a ' +
    'link, or type the coordinates.',
  TOO_SHORT: 'Type a bit more of the address.',
  RATE_LIMITED: 'One search a second, please — try again in a moment.',
  UNAVAILABLE:
    'The address search could not be reached. Tap the map, paste a link, or ' +
    'type the coordinates instead.',
  NOTHING_FOUND:
    'Nothing found. Try the street and the barangay, or drop the pin by hand.',
};

export interface GeocoderConfig {
  endpoint: string;
  /**
   * A contact address, sent as Nominatim's `email` parameter and folded into
   * the `User-Agent`. Their policy asks for a way to reach whoever is making
   * the requests before they resort to blocking.
   */
  contact: string | null;
}

export function geocoderConfig(
  env: Record<string, string | undefined> = process.env,
): GeocoderConfig | null {
  const disabled = (env.GEOCODER_URL ?? '').trim().toLowerCase();
  // An explicit off switch. Somebody running in a jurisdiction or on a network
  // where calling out is not acceptable should be able to say so, rather than
  // having every search time out.
  if (disabled === 'off' || disabled === 'none' || disabled === 'disabled') {
    return null;
  }
  const endpoint = (env.GEOCODER_URL ?? '').trim() || NOMINATIM;
  if (!/^https?:\/\//.test(endpoint)) return null;
  const contact = (env.GEOCODER_CONTACT ?? '').trim();
  return { endpoint, contact: contact.length > 0 ? contact : null };
}

/** What Nominatim is told about us. Policy asks for this to be identifiable. */
export function userAgent(config: GeocoderConfig): string {
  return config.contact === null
    ? 'TARA-delivery/1.0'
    : `TARA-delivery/1.0 (${config.contact})`;
}

/**
 * The request.
 *
 * `countrycodes=ph` is the single biggest improvement to relevance: without it
 * "Mabini Street" matches a dozen countries. `viewbox` around the city already
 * chosen on the form nudges the rest, without `bounded=1` — a shop just over a
 * city line should still be findable.
 */
export function buildGeocodeUrl(input: {
  config: GeocoderConfig;
  query: string;
  /** The city centre already picked on the form, if any. */
  near?: Coordinate | undefined;
}): string {
  const url = new URL(input.config.endpoint);
  url.searchParams.set('q', input.query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('addressdetails', '0');
  url.searchParams.set('countrycodes', 'ph');
  url.searchParams.set('limit', String(MAX_CANDIDATES));
  if (input.near) {
    // Roughly a 60 km box, which covers a city and its neighbours.
    const pad = 0.3;
    url.searchParams.set(
      'viewbox',
      [
        input.near.longitude - pad,
        input.near.latitude + pad,
        input.near.longitude + pad,
        input.near.latitude - pad,
      ].join(','),
    );
  }
  if (input.config.contact !== null) {
    url.searchParams.set('email', input.config.contact);
  }
  return url.toString();
}

/**
 * Reads candidates out of a Nominatim response.
 *
 * Defensive throughout, and deliberately: this is somebody else's JSON, it is
 * free, and it is under no obligation to keep its shape. Anything unreadable
 * is dropped rather than throwing — a malformed row should cost one result,
 * not the search.
 *
 * Results outside the Philippines are dropped even though `countrycodes=ph`
 * asked for none: the same bounds the picker and the server action use, so a
 * candidate can never place a pin the form would then refuse.
 */
export function parseGeocodeResponse(payload: unknown): GeocodeCandidate[] {
  if (!Array.isArray(payload)) return [];
  const candidates: GeocodeCandidate[] = [];

  for (const row of payload) {
    if (row === null || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    // Nominatim sends them as STRINGS, which is the detail that quietly turns
    // a coordinate into NaN if you trust the field names and not the types.
    const latitude = Number(record.lat);
    const longitude = Number(record.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    if (!isInPhilippines({ latitude, longitude })) continue;

    const rawLabel =
      typeof record.display_name === 'string' && record.display_name.length > 0
        ? record.display_name
        : typeof record.name === 'string'
          ? record.name
          : null;
    if (rawLabel === null) continue;

    candidates.push({
      // Long enough to distinguish two branches on the same road, short
      // enough to read in a list.
      label: rawLabel.length > 120 ? `${rawLabel.slice(0, 119)}…` : rawLabel,
      point: { latitude, longitude },
    });
    if (candidates.length >= MAX_CANDIDATES) break;
  }

  return candidates;
}

export function normaliseQuery(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_QUERY_LENGTH);
}

// --- The throttle ------------------------------------------------------------

/**
 * Held in the module, which is per server process.
 *
 * Not a distributed limiter, and it does not need to be: this bounds one
 * instance to Nominatim's stated rate, and the number of instances is a number
 * whoever runs this knows. A Redis lease for an operator typing an address
 * would be machinery for nothing.
 */
let lastRequestAt = 0;

/** For the tests, which call `searchAddress` more than once a second. */
export function resetThrottle(): void {
  lastRequestAt = 0;
}

export function mayRequestNow(now: number, last: number = lastRequestAt): boolean {
  return now - last >= MIN_REQUEST_GAP_MS;
}

// --- The call ----------------------------------------------------------------

export async function searchAddress(input: {
  query: unknown;
  near?: Coordinate | undefined;
  env?: Record<string, string | undefined>;
  now?: number;
  fetchImpl?: typeof fetch;
}): Promise<GeocodeOutcome> {
  const config = geocoderConfig(input.env);
  if (config === null) return { ok: false, reason: 'NOT_CONFIGURED' };

  const query = normaliseQuery(input.query);
  if (query.length < MIN_QUERY_LENGTH) return { ok: false, reason: 'TOO_SHORT' };

  const now = input.now ?? Date.now();
  if (!mayRequestNow(now)) return { ok: false, reason: 'RATE_LIMITED' };
  // Claimed BEFORE the call, not after: two searches arriving in the same
  // millisecond would otherwise both see a stale timestamp and both go out.
  lastRequestAt = now;

  const request = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await request(
      buildGeocodeUrl({
        config,
        query,
        ...(input.near === undefined ? {} : { near: input.near }),
      }),
      {
        headers: {
          // Policy. A browser cannot send this, which is most of why this call
          // happens here rather than there.
          'user-agent': userAgent(config),
          accept: 'application/json',
          'accept-language': 'en',
        },
        // Somebody is watching a spinner on a form. Four seconds is already
        // longer than they will like.
        signal: AbortSignal.timeout(4_000),
      },
    );
  } catch {
    return { ok: false, reason: 'UNAVAILABLE' };
  }

  if (!response.ok) return { ok: false, reason: 'UNAVAILABLE' };

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, reason: 'UNAVAILABLE' };
  }

  const candidates = parseGeocodeResponse(payload);
  if (candidates.length === 0) return { ok: false, reason: 'NOTHING_FOUND' };
  return { ok: true, candidates };
}

/** Rendered under the results. Nominatim asks to be credited, like the tiles. */
export const GEOCODER_CREDIT = 'Search by OpenStreetMap / Nominatim';

/** Whether the box should be shown at all. */
export function geocodingIsAvailable(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return geocoderConfig(env) !== null;
}
