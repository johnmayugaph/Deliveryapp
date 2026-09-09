import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GEOCODER_CREDIT,
  GEOCODE_FAILURE_MESSAGE,
  MAX_CANDIDATES,
  MIN_QUERY_LENGTH,
  MIN_REQUEST_GAP_MS,
  NOMINATIM,
  buildGeocodeUrl,
  geocoderConfig,
  geocodingIsAvailable,
  mayRequestNow,
  normaliseQuery,
  parseGeocodeResponse,
  resetThrottle,
  searchAddress,
  userAgent,
} from '@/lib/geo/geocode';

/**
 * Address search.
 *
 * A convenience on top of three ways of setting a coordinate that already
 * work, so most of what matters here is what happens when it does NOT work —
 * and being a good citizen of a free service that is under no obligation to
 * serve us.
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

afterEach(() => resetThrottle());

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

describe('configuration', () => {
  it('works out of the box, against OpenStreetMap’s own', () => {
    expect(geocoderConfig({})?.endpoint).toBe(NOMINATIM);
    expect(geocodingIsAvailable({})).toBe(true);
  });

  it('can be switched off outright', () => {
    // Somebody on a network where calling out is not acceptable should be able
    // to say so, rather than having every search time out.
    for (const off of ['off', 'none', 'DISABLED']) {
      expect(geocoderConfig({ GEOCODER_URL: off }), off).toBeNull();
      expect(geocodingIsAvailable({ GEOCODER_URL: off }), off).toBe(false);
    }
  });

  it('can be pointed at a paid or self-hosted instance', () => {
    expect(
      geocoderConfig({ GEOCODER_URL: 'https://geo.example.ph/search' })?.endpoint,
    ).toBe('https://geo.example.ph/search');
  });

  it('refuses something that is not a URL rather than trying it', () => {
    expect(geocoderConfig({ GEOCODER_URL: 'geo.example.ph' })).toBeNull();
  });

  it('identifies the application, which is the policy', () => {
    // Nominatim asks for a User-Agent naming the application. A browser cannot
    // send one, which is most of the reason this call happens on the server.
    expect(userAgent({ endpoint: NOMINATIM, contact: null })).toMatch(/TARA/);
    expect(userAgent({ endpoint: NOMINATIM, contact: 'ops@tara.ph' })).toContain(
      'ops@tara.ph',
    );
  });
});

// -----------------------------------------------------------------------------
// The request
// -----------------------------------------------------------------------------

describe('the request', () => {
  const config = { endpoint: NOMINATIM, contact: null };

  it('asks only about the Philippines', () => {
    // The single biggest improvement to relevance: without it "Mabini Street"
    // matches a dozen countries.
    const url = new URL(buildGeocodeUrl({ config, query: 'Mabini Street' }));
    expect(url.searchParams.get('countrycodes')).toBe('ph');
    expect(url.searchParams.get('q')).toBe('Mabini Street');
    expect(url.searchParams.get('limit')).toBe(String(MAX_CANDIDATES));
  });

  it('nudges towards the city already chosen on the form', () => {
    const url = new URL(
      buildGeocodeUrl({
        config,
        query: 'Mabini',
        near: { latitude: 10.3157, longitude: 123.8854 },
      }),
    );
    const viewbox = url.searchParams.get('viewbox');
    expect(viewbox).not.toBeNull();
    expect(viewbox!.split(',')).toHaveLength(4);
    // NOT bounded: a shop just over a city line should still be findable.
    expect(url.searchParams.get('bounded')).toBeNull();
  });

  it('passes a contact address when one is set', () => {
    const url = new URL(
      buildGeocodeUrl({
        config: { endpoint: NOMINATIM, contact: 'ops@tara.ph' },
        query: 'Mabini',
      }),
    );
    expect(url.searchParams.get('email')).toBe('ops@tara.ph');
  });

  it('trims and caps what somebody typed', () => {
    expect(normaliseQuery('  Aling   Nena  ')).toBe('Aling Nena');
    expect(normaliseQuery('x'.repeat(500)).length).toBeLessThanOrEqual(160);
    expect(normaliseQuery(null)).toBe('');
  });
});

// -----------------------------------------------------------------------------
// Somebody else's JSON
// -----------------------------------------------------------------------------

describe('reading the response', () => {
  it('reads a normal Nominatim row', () => {
    // Note the types: Nominatim sends coordinates as STRINGS, which is the
    // detail that quietly turns a coordinate into NaN if you trust the field
    // names and not the types.
    const candidates = parseGeocodeResponse([
      { lat: '14.5995', lon: '120.9842', display_name: 'Aling Nena, Tondo, Manila' },
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.point).toEqual({ latitude: 14.5995, longitude: 120.9842 });
    expect(candidates[0]!.label).toBe('Aling Nena, Tondo, Manila');
  });

  it('drops a row it cannot read rather than throwing', () => {
    // This is somebody else's free JSON and it is under no obligation to keep
    // its shape. A malformed row should cost one result, not the search.
    const candidates = parseGeocodeResponse([
      null,
      'nonsense',
      {},
      { lat: 'abc', lon: 'def', display_name: 'Nowhere' },
      { lat: '14.6', lon: '121.0' },
      { lat: '14.5995', lon: '120.9842', display_name: 'Real place' },
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.label).toBe('Real place');
  });

  it('drops anything outside the Philippines, even though it asked for none', () => {
    // The same bounds the picker and the server action use, so a candidate can
    // never place a pin the form would then refuse.
    expect(
      parseGeocodeResponse([
        { lat: '51.5', lon: '-0.12', display_name: 'Trafalgar Square' },
      ]),
    ).toEqual([]);
  });

  it('never returns more than a list somebody would read', () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      lat: '14.5995',
      lon: String(120.98 + index / 1000),
      display_name: `Place ${index}`,
    }));
    expect(parseGeocodeResponse(many)).toHaveLength(MAX_CANDIDATES);
  });

  it('shortens a label that is a whole postal address', () => {
    const long = parseGeocodeResponse([
      { lat: '14.5995', lon: '120.9842', display_name: 'A, '.repeat(90) },
    ]);
    expect(long[0]!.label.length).toBeLessThanOrEqual(120);
    expect(long[0]!.label.endsWith('…')).toBe(true);
  });

  it('survives a response that is not an array at all', () => {
    expect(parseGeocodeResponse({ error: 'nope' })).toEqual([]);
    expect(parseGeocodeResponse(null)).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Being a good citizen
// -----------------------------------------------------------------------------

describe('the rate limit', () => {
  it('is the one Nominatim asks for', () => {
    expect(MIN_REQUEST_GAP_MS).toBeGreaterThanOrEqual(1000);
  });

  it('refuses a second request inside the gap', () => {
    expect(mayRequestNow(1000, 500)).toBe(false);
    expect(mayRequestNow(1000 + MIN_REQUEST_GAP_MS, 1000)).toBe(true);
  });

  it('claims the slot BEFORE the call, not after', async () => {
    // Two searches arriving in the same millisecond would otherwise both see a
    // stale timestamp and both go out.
    const calls: string[] = [];
    const stub: typeof fetch = async (url) => {
      calls.push(String(url));
      // Deliberately slow, so the second call starts while this is in flight.
      await new Promise((resolve) => setTimeout(resolve, 30));
      return new Response('[]', { status: 200 });
    };

    const [first, second] = await Promise.all([
      searchAddress({ query: 'Mabini Street', now: 10_000, fetchImpl: stub }),
      searchAddress({ query: 'Rizal Avenue', now: 10_000, fetchImpl: stub }),
    ]);

    expect(calls).toHaveLength(1);
    const refused = [first, second].filter((r) => !r.ok && r.reason === 'RATE_LIMITED');
    expect(refused).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------------
// Failing
// -----------------------------------------------------------------------------

describe('when it does not work', () => {
  const ok = (body: unknown): typeof fetch => async () =>
    new Response(JSON.stringify(body), { status: 200 });

  it('says so when it is switched off, without calling anything', async () => {
    let called = false;
    const result = await searchAddress({
      query: 'Mabini Street',
      env: { GEOCODER_URL: 'off' },
      fetchImpl: async () => {
        called = true;
        return new Response('[]');
      },
    });
    expect(result).toEqual({ ok: false, reason: 'NOT_CONFIGURED' });
    expect(called).toBe(false);
  });

  it('does not spend somebody else’s server on two characters', async () => {
    let called = false;
    const result = await searchAddress({
      query: 'ab',
      fetchImpl: async () => {
        called = true;
        return new Response('[]');
      },
    });
    expect(result).toEqual({ ok: false, reason: 'TOO_SHORT' });
    expect(called).toBe(false);
    expect(MIN_QUERY_LENGTH).toBeGreaterThan(1);
  });

  it('is unavailable rather than broken when the network refuses', async () => {
    const result = await searchAddress({
      query: 'Mabini Street',
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(result).toEqual({ ok: false, reason: 'UNAVAILABLE' });
  });

  it('treats an error status as unavailable', async () => {
    const result = await searchAddress({
      query: 'Mabini Street',
      fetchImpl: async () => new Response('rate limited', { status: 429 }),
    });
    expect(result).toEqual({ ok: false, reason: 'UNAVAILABLE' });
  });

  it('treats unparseable JSON as unavailable', async () => {
    const result = await searchAddress({
      query: 'Mabini Street',
      fetchImpl: async () => new Response('<html>maintenance</html>', { status: 200 }),
    });
    expect(result).toEqual({ ok: false, reason: 'UNAVAILABLE' });
  });

  it('tells an empty result apart from a broken one', async () => {
    // Different sentences, because they need different actions from the person
    // reading them.
    const result = await searchAddress({ query: 'Mabini Street', fetchImpl: ok([]) });
    expect(result).toEqual({ ok: false, reason: 'NOTHING_FOUND' });
    expect(GEOCODE_FAILURE_MESSAGE.NOTHING_FOUND).not.toBe(
      GEOCODE_FAILURE_MESSAGE.UNAVAILABLE,
    );
  });

  it('every failure names something else the person can do', async () => {
    // Search is a convenience. Every message about it failing should point at
    // one of the three ways that still work.
    for (const reason of ['NOT_CONFIGURED', 'UNAVAILABLE', 'NOTHING_FOUND'] as const) {
      expect(GEOCODE_FAILURE_MESSAGE[reason], reason).toMatch(
        /tap the map|paste a link|type the coordinates|by hand/i,
      );
    }
  });

  it('returns candidates on the happy path', async () => {
    const result = await searchAddress({
      query: 'Aling Nena',
      fetchImpl: ok([
        { lat: '14.5995', lon: '120.9842', display_name: 'Aling Nena, Tondo' },
      ]),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates[0]!.label).toBe('Aling Nena, Tondo');
  });
});

// -----------------------------------------------------------------------------
// Wiring
// -----------------------------------------------------------------------------

describe('the wiring', () => {
  it('never lets the browser call the geocoder itself', () => {
    // A browser cannot send the User-Agent the policy asks for, cannot be
    // rate-limited from here, and would put the third party one hop from the
    // customer. Nothing in this application talks to somebody else's API from
    // the browser.
    const picker = codeOnly(source('src/components/geo/LocationPicker.tsx'));
    expect(picker).not.toMatch(/nominatim|fetch\(/i);
    expect(picker).toMatch(/searchAddressAction/);
  });

  it('requires an administrator, or it is an open geocoding proxy', () => {
    const action = codeOnly(source('src/lib/actions/geocode-actions.ts'));
    expect(action).toMatch(/requireAdmin\(\)/);
  });

  it('stays out of the file whose every action needs a reason and an audit row', () => {
    // This is a READ of a public search index. "An administrator typed a
    // street name" would be noise in the log that matters.
    const admin = codeOnly(source('src/lib/actions/admin-actions.ts'));
    expect(admin).not.toMatch(/searchAddress/);
  });

  it('validates the viewbox centre instead of trusting the form', () => {
    const action = codeOnly(source('src/lib/actions/geocode-actions.ts'));
    expect(action).toMatch(/isInPhilippines\(\{ latitude, longitude \}\)/);
  });

  it('hides the box entirely when there is no geocoder', () => {
    // Rather than rendering a search field that can only ever fail.
    expect(codeOnly(source('src/components/geo/LocationPicker.tsx'))).toMatch(
      /searchAvailable \? \(/,
    );
    expect(codeOnly(source('src/app/admin/stores/page.tsx'))).toMatch(
      /geocodingIsAvailable\(\)/,
    );
  });

  it('does not nest a form inside the store form', () => {
    // The picker is rendered INSIDE it. A nested form is invalid HTML: the
    // browser unnests it and the outer form starts submitting on the wrong
    // button. So the action is dispatched directly.
    const picker = codeOnly(source('src/components/geo/LocationPicker.tsx'));
    expect(picker).not.toMatch(/<form/);
    expect(picker).toMatch(/startTransition\(\(\) => search\(payload\)\)/);
  });

  it('dispatches inside a transition, because it is not a form action', () => {
    // React only establishes an action context automatically for a dispatch
    // passed to a form's `action` prop. Called bare it works AND logs an
    // error — the worst of both, in the console of a page whose whole purpose
    // is to be trusted with a shop's coordinates. A browser found this.
    const picker = codeOnly(source('src/components/geo/LocationPicker.tsx'));
    expect(picker).toMatch(/startTransition/);
  });

  it('does not submit the store form when somebody presses Enter to search', () => {
    const picker = codeOnly(source('src/components/geo/LocationPicker.tsx'));
    const handlers = picker.match(/event\.key === 'Enter'/g) ?? [];
    // One for the search box, one for the paste box.
    expect(handlers.length).toBe(2);
  });

  it('credits Nominatim, which it asks for like the tiles do', () => {
    expect(GEOCODER_CREDIT).toMatch(/OpenStreetMap|Nominatim/);
    expect(codeOnly(source('src/components/geo/LocationPicker.tsx'))).toMatch(
      /GEOCODER_CREDIT/,
    );
  });
});
