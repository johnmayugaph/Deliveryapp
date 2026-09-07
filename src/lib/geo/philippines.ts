/**
 * Where a Philippine coordinate can be, and how to read one out of whatever
 * somebody pasted.
 *
 * All pure, and shared by the store form and the server action that accepts it.
 * The bounds used to be written out twice — once in the action, once in a
 * comment — which is exactly the pair that drifts. A picker that lets somebody
 * drop a pin the server then rejects is worse than no picker.
 */

/**
 * A generous box around the whole archipelago: Y'Ami islet in the north to
 * Saluag in the south, Balabac in the west to the eastern edge of Mindanao.
 * Deliberately loose — this is a typo filter, not a border.
 */
export const PH_BOUNDS = {
  minLat: 4,
  maxLat: 21,
  minLng: 116,
  maxLng: 127,
} as const;

export interface Coordinate {
  latitude: number;
  longitude: number;
}

export function isFiniteCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isInPhilippines(point: Coordinate): boolean {
  return (
    isFiniteCoordinate(point.latitude) &&
    isFiniteCoordinate(point.longitude) &&
    point.latitude >= PH_BOUNDS.minLat &&
    point.latitude <= PH_BOUNDS.maxLat &&
    point.longitude >= PH_BOUNDS.minLng &&
    point.longitude <= PH_BOUNDS.maxLng
  );
}

/**
 * Whether the pair is the right two numbers in the wrong order.
 *
 * Unambiguous here, and that is the whole reason this function can exist: the
 * Philippine latitude range (4–21) and longitude range (116–127) do not
 * overlap, so a pair that is invalid as given and valid when swapped can only
 * be a swap. Elsewhere in the world that would be a guess.
 */
export function looksSwapped(point: Coordinate): boolean {
  if (isInPhilippines(point)) return false;
  return isInPhilippines({ latitude: point.longitude, longitude: point.latitude });
}

/** Six decimal places is about 11 cm. More is noise; less loses a doorway. */
export function formatCoordinate(value: number): string {
  return value.toFixed(6).replace(/\.?0+$/, '');
}

// --- Reading a coordinate out of a pasted string -----------------------------

export type ParseResult =
  | { ok: true; point: Coordinate; swapped: boolean }
  | { ok: false; reason: 'EMPTY' | 'SHORT_LINK' | 'NO_NUMBERS' | 'OUT_OF_RANGE' };

/**
 * Google's own place URLs carry the pin twice: `@lat,lng,zoom` is where the
 * MAP is centred, and `!3dlat!4dlng` is where the PLACE is. They differ when
 * somebody has panned, and the place is the one that is wanted — so it is
 * tried first.
 */
const PATTERNS: readonly RegExp[] = [
  // Google place data: !3d<lat>!4d<lng>
  /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/,
  // Google map centre: @<lat>,<lng>
  /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
  // ?q=, ?query=, ?ll=, ?center=, ?destination= — Google, Waze, Apple
  /[?&](?:q|query|ll|center|centre|destination|daddr|sll)=(-?\d+(?:\.\d+)?)(?:,|%2C|\s)\s*(-?\d+(?:\.\d+)?)/i,
  // geo: URIs, which is what an Android share sheet often produces
  /geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i,
  // A bare pair, which is what somebody types
  /(-?\d+(?:\.\d+)?)\s*[,;]\s*(-?\d+(?:\.\d+)?)/,
];

/**
 * Turns a pasted link or typed pair into a point.
 *
 * This exists because of how the coordinates for a small shop are actually
 * obtained: somebody stands outside it, drops a pin in Google Maps on their
 * phone, and shares the link. Asking them to transcribe two eight-digit
 * decimals from that screen is asking for a transposition.
 */
export function parseCoordinateInput(raw: string): ParseResult {
  const text = raw.trim();
  if (text.length === 0) return { ok: false, reason: 'EMPTY' };

  // A shortened link is a redirect with no coordinates in it, and the browser
  // cannot follow it to find out — cross-origin. Saying so is much better than
  // "no numbers found", which sends somebody looking for a typo that is not
  // there.
  if (/(?:maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs)/i.test(text)) {
    return { ok: false, reason: 'SHORT_LINK' };
  }

  for (const pattern of PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const first = Number(match[1]);
    const second = Number(match[2]);
    if (!Number.isFinite(first) || !Number.isFinite(second)) continue;

    const asGiven = { latitude: first, longitude: second };
    if (isInPhilippines(asGiven)) {
      return { ok: true, point: asGiven, swapped: false };
    }
    if (looksSwapped(asGiven)) {
      return {
        ok: true,
        point: { latitude: second, longitude: first },
        swapped: true,
      };
    }
    // Numbers found, but not a place in the Philippines. Keep looking through
    // the remaining patterns — a Google URL contains several number pairs and
    // the first one matched may have been a zoom level or a viewport.
  }

  return { ok: false, reason: /\d/.test(text) ? 'OUT_OF_RANGE' : 'NO_NUMBERS' };
}

/** One sentence per failure, for the form. */
export const PARSE_FAILURE_MESSAGE: Readonly<Record<
  Extract<ParseResult, { ok: false }>['reason'],
  string
>> = {
  EMPTY: 'Paste a link, or two numbers.',
  SHORT_LINK:
    'A shortened Google link has no coordinates in it. Open it, then copy the ' +
    'full address bar — the one with @14.5…,120.9… in the middle.',
  NO_NUMBERS: 'No coordinates in that. Paste the full map link, or type "14.5995, 120.9842".',
  OUT_OF_RANGE:
    'Those coordinates are not in the Philippines. Check you copied the whole ' +
    'link, and that it is not a zoom level.',
};
