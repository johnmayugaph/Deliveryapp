import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPENSTREETMAP, tileSource } from '@/lib/geo/tiles';
import {
  PARSE_FAILURE_MESSAGE,
  PH_BOUNDS,
  formatCoordinate,
  isInPhilippines,
  looksSwapped,
  parseCoordinateInput,
} from '@/lib/geo/philippines';

/**
 * Coordinates, and getting them out of whatever somebody pasted.
 *
 * This matters more than it looks. Every delivery fee from a store is measured
 * from its coordinates, so a transposed pair does not fail — it quietly
 * charges the wrong money forever. Every case below is a real shape a
 * Philippine operator would paste in.
 */

function source(relativePath: string): string {
  return readFileSync(path.resolve(__dirname, '..', '..', relativePath), 'utf8');
}

function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

/** Aling Nena's, near Divisoria. */
const SHOP = { latitude: 14.5995, longitude: 120.9842 };

describe('the bounds', () => {
  it('cover the whole archipelago', () => {
    // Y'Ami in the north to Saluag in the south, Balabac to eastern Mindanao.
    expect(isInPhilippines({ latitude: 21.0, longitude: 121.9 })).toBe(true); // Batanes
    expect(isInPhilippines({ latitude: 5.0, longitude: 120.0 })).toBe(true); // Tawi-Tawi
    expect(isInPhilippines({ latitude: 7.19, longitude: 125.46 })).toBe(true); // Davao
    expect(isInPhilippines({ latitude: 10.32, longitude: 123.89 })).toBe(true); // Cebu
  });

  it('rejects the two mistakes that actually happen', () => {
    // An empty form field arrives as 0, which is in the Atlantic — and every
    // delivery fee from a store there would be computed from the Gulf of
    // Guinea rather than failing.
    expect(isInPhilippines({ latitude: 0, longitude: 0 })).toBe(false);
    // And the pair the wrong way round.
    expect(isInPhilippines({ latitude: 120.9842, longitude: 14.5995 })).toBe(false);
  });

  it('refuses anything that is not a finite number', () => {
    expect(isInPhilippines({ latitude: Number.NaN, longitude: 120 })).toBe(false);
    expect(isInPhilippines({ latitude: 14, longitude: Number.POSITIVE_INFINITY })).toBe(
      false,
    );
  });

  it('can tell a swap from a wrong number, because the ranges do not overlap', () => {
    // The entire reason `looksSwapped` is allowed to exist. Elsewhere in the
    // world it would be a guess.
    expect(PH_BOUNDS.maxLat).toBeLessThan(PH_BOUNDS.minLng);
    expect(looksSwapped({ latitude: 120.9842, longitude: 14.5995 })).toBe(true);
    expect(looksSwapped(SHOP)).toBe(false);
    // London is not a swap; it is somewhere else.
    expect(looksSwapped({ latitude: 51.5, longitude: -0.12 })).toBe(false);
  });
});

describe('formatting', () => {
  it('keeps about eleven centimetres and no noise', () => {
    expect(formatCoordinate(14.5995)).toBe('14.5995');
    expect(formatCoordinate(14.59950000001)).toBe('14.5995');
    expect(formatCoordinate(14)).toBe('14');
  });
});

describe('reading a pasted link', () => {
  const cases: [string, string][] = [
    ['a plain typed pair', '14.5995, 120.9842'],
    ['a pair with no space', '14.5995,120.9842'],
    ['a semicolon, which some keyboards give', '14.5995; 120.9842'],
    ['a Google map centre', 'https://www.google.com/maps/@14.5995,120.9842,17z'],
    [
      'a Google place URL',
      'https://www.google.com/maps/place/Aling+Nena/@14.5995,120.9842,17z/data=!3m1!4b1',
    ],
    ['a Google query link', 'https://maps.google.com/?q=14.5995,120.9842'],
    [
      'the search API form',
      'https://www.google.com/maps/search/?api=1&query=14.5995,120.9842',
    ],
    ['a Waze link', 'https://waze.com/ul?ll=14.5995,120.9842&navigate=yes'],
    ['an Android geo: share', 'geo:14.5995,120.9842?q=Aling+Nena'],
    ['a URL-encoded comma', 'https://maps.apple.com/?ll=14.5995%2C120.9842'],
  ];

  for (const [label, input] of cases) {
    it(`handles ${label}`, () => {
      const result = parseCoordinateInput(input);
      expect(result.ok, input).toBe(true);
      if (!result.ok) return;
      expect(result.point.latitude).toBeCloseTo(SHOP.latitude, 4);
      expect(result.point.longitude).toBeCloseTo(SHOP.longitude, 4);
      expect(result.swapped).toBe(false);
    });
  }

  it('prefers the PLACE over the map centre when a link carries both', () => {
    // Google's place URLs hold the pin twice, and they differ once somebody
    // has panned. The place is the shop; the centre is wherever they were
    // looking.
    const result = parseCoordinateInput(
      'https://www.google.com/maps/place/Shop/@14.7000,121.0000,17z/data=!4m2!3m1!3d14.5995!4d120.9842',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.point.latitude).toBeCloseTo(14.5995, 4);
  });

  it('swaps a reversed pair and says so', () => {
    const result = parseCoordinateInput('120.9842, 14.5995');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.swapped).toBe(true);
    expect(result.point.latitude).toBeCloseTo(SHOP.latitude, 4);
    expect(result.point.longitude).toBeCloseTo(SHOP.longitude, 4);
  });

  it('skips a leading number pair that is not a place', () => {
    // A Google URL is full of numbers. The first pair a naive regex finds can
    // be a zoom level or a viewport, and taking it would silently place the
    // shop somewhere plausible-looking.
    const result = parseCoordinateInput(
      'https://www.google.com/maps/dir/12.0,13.0/@14.5995,120.9842,15z',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.point.latitude).toBeCloseTo(SHOP.latitude, 4);
  });

  it('names a shortened link for what it is', () => {
    // The coordinates are not in it and the browser cannot follow it to find
    // out — cross-origin. "No numbers found" would send somebody hunting for a
    // typo that is not there.
    for (const short of [
      'https://maps.app.goo.gl/abc123',
      'https://goo.gl/maps/xyz',
    ]) {
      const result = parseCoordinateInput(short);
      expect(result.ok, short).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('SHORT_LINK');
      expect(PARSE_FAILURE_MESSAGE[result.reason]).toMatch(/full address bar/i);
    }
  });

  it('rejects an empty box, a sentence, and somewhere else entirely', () => {
    expect(parseCoordinateInput('   ')).toEqual({ ok: false, reason: 'EMPTY' });
    expect(parseCoordinateInput('near the church')).toEqual({
      ok: false,
      reason: 'NO_NUMBERS',
    });
    // Trafalgar Square: real coordinates, wrong country.
    const abroad = parseCoordinateInput('51.5080, -0.1281');
    expect(abroad.ok).toBe(false);
    if (abroad.ok) return;
    expect(abroad.reason).toBe('OUT_OF_RANGE');
  });

  it('has a sentence for every failure', () => {
    for (const reason of ['EMPTY', 'SHORT_LINK', 'NO_NUMBERS', 'OUT_OF_RANGE'] as const) {
      expect(PARSE_FAILURE_MESSAGE[reason].length).toBeGreaterThan(10);
    }
  });
});

// -----------------------------------------------------------------------------
// The picker
// -----------------------------------------------------------------------------

describe('the map picker', () => {
  const picker = source('src/components/geo/LocationPicker.tsx');

  it('shares its bounds with the server that validates them', () => {
    // A picker that lets somebody drop a pin the server then rejects is worse
    // than no picker. Both read PH_BOUNDS from the same module.
    expect(codeOnly(picker)).toMatch(/from '@\/lib\/geo\/philippines'/);
    const actions = codeOnly(source('src/lib/actions/admin-actions.ts'));
    expect(actions).toMatch(/isInPhilippines\(/);
    // And the numbers are not written out a second time anywhere.
    expect(actions).not.toMatch(/latitude < 4|longitude < 116/);
  });

  it('never loads Leaflet on the server', () => {
    // It touches `window` at module scope. A static import would break the
    // build, and a `typeof window` guard would break hydration instead.
    expect(codeOnly(picker)).toMatch(/await import\('leaflet'\)/);
    expect(codeOnly(picker)).not.toMatch(/^import \* as L from 'leaflet'/m);
  });

  it('keeps the coordinates as real form fields', () => {
    // The number inputs ARE the fields, not a read-out beside hidden ones. A
    // map is not an accessible way to enter a coordinate and must not be the
    // only way — and this is also what makes the form correct with the map
    // broken.
    expect(picker).toMatch(/name="latitude"/);
    expect(picker).toMatch(/name="longitude"/);
    expect(codeOnly(picker)).not.toMatch(/type="hidden"/);
  });

  it('says so when the tiles cannot be reached', () => {
    // Tiles are fetched by the BROWSER. A network that blocks the tile server
    // must leave a form that still works, not a grey box.
    expect(codeOnly(picker)).toMatch(/tileerror/);
    expect(picker).toMatch(/could not load/i);
  });

  it('does not call a map ready just because the tiles stopped trying', () => {
    // The bug a browser found: Leaflet's `load` fires when the batch has
    // SETTLED, loaded or errored alike, so `once('load') -> ready` declared
    // success with every tile failed. Broken means nothing loaded, not that
    // something failed — one missing tile over the Sulu Sea is normal.
    const code = codeOnly(picker);
    expect(code).toMatch(/loadedTiles === 0 && failedTiles > 0/);
    expect(code).not.toMatch(/once\('load'/);
  });

  it('does not sit on "loading" forever when the tile server hangs', () => {
    // A server that accepts the connection and never answers fires neither
    // event.
    expect(codeOnly(picker)).toMatch(/setTimeout\(/);
  });

  it('renders whatever attribution the tile source names', () => {
    // ODbL for OpenStreetMap, and near-certainly a condition of whoever
    // else's tiles somebody points this at. Not decoration.
    expect(codeOnly(picker)).toMatch(/attribution: tileSource\.attribution/);
  });

  it('does not use Leaflet’s default marker image', () => {
    // Its icon is loaded from a relative path no bundler resolves, which shows
    // up as an invisible pin rather than an error.
    expect(codeOnly(picker)).toMatch(/divIcon/);
    expect(codeOnly(picker)).not.toMatch(/L\.icon\(/);
  });

  it('does not submit the whole store form when somebody presses Enter in the paste box', () => {
    const code = codeOnly(picker);
    expect(code).toMatch(/event\.key === 'Enter'/);
    expect(code).toMatch(/event\.preventDefault\(\)/);
  });

  it('stops following the city once a pin has been placed', () => {
    // Choosing a city should move the map near the shop. Re-centring after
    // somebody has placed a pin would throw their work away.
    expect(codeOnly(picker)).toMatch(/if \(!centre \|\| point !== null\) return;/);
  });

  it('opens the map near the chosen city', () => {
    // Otherwise a Cebu shop starts over Manila and somebody pans across the
    // archipelago.
    const page = codeOnly(source('src/app/admin/stores/page.tsx'));
    expect(page).toMatch(/centroidLat: true/);
    expect(codeOnly(source('src/components/admin/StoreCreateForm.tsx'))).toMatch(
      /centroidLat/,
    );
  });
});

describe('where the tiles come from', () => {
  it('is OpenStreetMap with no configuration at all', () => {
    expect(tileSource({})).toEqual(OPENSTREETMAP);
    expect(OPENSTREETMAP.attribution).toMatch(/OpenStreetMap contributors/);
  });

  it('can be pointed somewhere else', () => {
    // It will need to be. OSM's policy permits light use, and a console form is
    // light; the day maps appear on a customer screen it stops being.
    const custom = tileSource({
      MAP_TILE_URL: 'https://tiles.example.ph/{z}/{x}/{y}@2x.png',
      MAP_TILE_ATTRIBUTION: '© Example',
    });
    expect(custom.url).toBe('https://tiles.example.ph/{z}/{x}/{y}@2x.png');
    expect(custom.attribution).toBe('© Example');
  });

  it('never renders no attribution at all', () => {
    // Whoever the tiles come from almost certainly requires crediting.
    expect(tileSource({ MAP_TILE_URL: 'https://t.example/{z}/{x}/{y}.png' }).attribution)
      .not.toBe('');
  });

  it('falls back rather than repeating one tile across the world', () => {
    // A template with no placeholders renders a single tile everywhere, which
    // looks like a working map of nowhere.
    for (const broken of ['https://t.example/tile.png', 'not-a-url', '   ', 'https://t.example/{z}/{x}.png']) {
      expect(tileSource({ MAP_TILE_URL: broken }), broken).toEqual(OPENSTREETMAP);
    }
  });

  it('is read on the server, not baked into the bundle', () => {
    // A `NEXT_PUBLIC_` variable is inlined at build time, so it would freeze
    // whatever was set during `docker build` — see the note in the Dockerfile.
    const picker = codeOnly(source('src/components/geo/LocationPicker.tsx'));
    expect(picker).not.toMatch(/process\.env/);
    expect(codeOnly(source('src/app/admin/stores/page.tsx'))).toMatch(/tileSource\(\)/);
  });
});
