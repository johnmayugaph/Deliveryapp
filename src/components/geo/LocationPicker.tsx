'use client';

import {
  startTransition,
  useActionState,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import 'leaflet/dist/leaflet.css';
import {
  PARSE_FAILURE_MESSAGE,
  PH_BOUNDS,
  formatCoordinate,
  isInPhilippines,
  parseCoordinateInput,
  type Coordinate,
} from '@/lib/geo/philippines';
import type { TileSource } from '@/lib/geo/tiles';
import {
  GEOCODER_CREDIT,
  GEOCODE_FAILURE_MESSAGE,
  MIN_QUERY_LENGTH,
} from '@/lib/geo/geocode';
import { searchAddressAction } from '@/lib/actions/geocode-actions';

/**
 * Dropping a pin on a place.
 *
 * Used for two things now — a shop's location and a customer's delivery
 * address — so the heading and the sentence under the map are PROPS rather
 * than fixed copy. They were fixed, and the customer address screen rendered
 * "Where the shop is / Every delivery fee from this shop is measured from
 * here" at somebody adding their own home. Same defect class as everything
 * else in this audit: a screen making a claim about the wrong subject.
 *
 * The coordinates matter more than they look: every delivery fee from this
 * store is computed from them, so a transposed pair does not fail — it quietly
 * charges the wrong money forever. Typing two eight-decimal numbers off a phone
 * screen is exactly the task people get wrong.
 *
 * FOUR WAYS IN, and all four write to the same two number fields, which stay
 * visible and editable:
 *
 *   1. Search for the address. Where somebody starts when they have a name and
 *      a street rather than a pin.
 *   2. Click or drag on the map. How they finish — a geocoder puts you on the
 *      right road, not the right doorway.
 *   3. Paste a Google Maps or Waze link. What they actually have — somebody
 *      stands outside the shop, drops a pin on their phone and shares it.
 *   4. Type the numbers. The keyboard path, and the one that still works when
 *      everything else is unreachable.
 *
 * The number inputs ARE the form fields rather than a read-out beside hidden
 * ones. That keeps the value inspectable, keyboard-editable and correct with
 * no JavaScript at all — a map is not an accessible way to enter a coordinate,
 * and it should not be the only way.
 *
 * Leaflet is imported dynamically inside an effect because it touches `window`
 * at module scope. Tiles come from OpenStreetMap, in the browser, so nothing
 * about this depends on the server having egress — and if they fail to load,
 * the panel says so and the other two ways in keep working.
 */

/** Manila, so a fresh form starts somewhere rather than mid-Pacific. */
const FALLBACK_CENTRE: Coordinate = { latitude: 14.5995, longitude: 120.9842 };

const FIELD =
  'mt-1 w-full rounded-lg border border-black/10 bg-surface px-2.5 py-1.5 text-[13px]';

export function LocationPicker({
  /**
   * A pin this shop already has, for the EDIT form.
   *
   * Without it the edit form opened with an empty picker over a city centroid
   * and no pin — which reads as "this shop has no location", and any save
   * would have needed somebody to drop the pin again from memory.
   */
  initial,
  /** Centre of the chosen city, so the map opens near the place. */
  centre,
  /** Changes when the city select changes, so the map can follow — once. */
  centreKey,
  /** Resolved on the server from `MAP_TILE_URL`; see `lib/geo/tiles.ts`. */
  tiles: tileSource,
  /**
   * Whether the deployment has a geocoder at all. Resolved on the server, so a
   * deployment with search switched off never renders a box that cannot work.
   */
  searchAvailable,
  heading = 'Where the shop is',
  help = 'Tap the map, or drag the pin. Every delivery fee from this shop is measured from here, so put it on the building rather than the street.',
}: {
  initial?: Coordinate | undefined;
  centre?: Coordinate | undefined;
  centreKey?: string | undefined;
  tiles: TileSource;
  searchAvailable: boolean;
  /** Heading above the map. Defaults to the store wording. */
  heading?: string;
  /** The sentence under the map, saying why the pin matters HERE. */
  help?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  // Typed loosely on purpose: importing Leaflet's types eagerly would pull the
  // module into the server bundle, which is the thing the dynamic import is
  // avoiding.
  const mapRef = useRef<{
    setView: (centre: [number, number], zoom: number) => void;
    remove: () => void;
  } | null>(null);
  const markerRef = useRef<{ setLatLng: (latlng: [number, number]) => void } | null>(
    null,
  );

  const [point, setPoint] = useState<Coordinate | null>(initial ?? null);
  /** What the person typed, kept separate so a half-typed number is not clobbered. */
  const [latText, setLatText] = useState(
    initial ? formatCoordinate(initial.latitude) : '',
  );
  const [lngText, setLngText] = useState(
    initial ? formatCoordinate(initial.longitude) : '',
  );
  const [pasted, setPasted] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [noteIsError, setNoteIsError] = useState(false);
  const [mapState, setMapState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [found, search, searching] = useActionState(searchAddressAction, null);
  /** Set when a candidate is chosen, so the list does not linger. */
  const [dismissedSearch, setDismissedSearch] = useState(false);
  /**
   * A refusal decided HERE rather than by the server — currently only "type a
   * bit more". It needs its own slot because `useActionState` cannot be
   * written to directly, and without one a two-character search left the
   * previous result on screen: somebody would read "nothing found" about a
   * query that was never sent.
   */
  const [searchNote, setSearchNote] = useState<string | null>(null);

  /** One way in and out: everything that moves the pin comes through here. */
  const place = useCallback((next: Coordinate) => {
    setPoint(next);
    setLatText(formatCoordinate(next.latitude));
    setLngText(formatCoordinate(next.longitude));
    markerRef.current?.setLatLng([next.latitude, next.longitude]);
  }, []);

  // --- the map ---------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;

    (async () => {
      try {
        const L = await import('leaflet');
        if (cancelled || mapRef.current) return;

        // The shop's own pin wins over the city centroid: an edit form should
        // open on the building, not on the middle of the city.
        const start = initial ?? centre ?? FALLBACK_CENTRE;
        const map = L.map(container, {
          center: [start.latitude, start.longitude],
          zoom: initial ? 16 : centre ? 13 : 11,
          // A shop is a point, not a region. Rotating gestures and a scroll
          // wheel that zooms while somebody is scrolling the form past it are
          // both annoyances rather than features.
          scrollWheelZoom: false,
          attributionControl: true,
        });

        const tiles = L.tileLayer(tileSource.url, {
          maxZoom: 19,
          // Required by the ODbL for OpenStreetMap, and near-certainly by
          // whoever else's tiles somebody points this at. Not decoration.
          attribution: tileSource.attribution,
        });
        // Counted rather than latched on the first event, and this took a
        // browser to get right.
        //
        // Leaflet's `load` fires when the visible batch has SETTLED — loaded
        // or errored, it does not distinguish — so a naive `once('load')`
        // declared the map ready even when every single tile had failed, and
        // an operator with no route to the tile server got a silent grey box.
        // Meanwhile latching on the first `tileerror` would be wrong the other
        // way: one missing tile over the Sulu Sea is normal.
        //
        // So: broken means the batch settled and NOTHING loaded.
        let loadedTiles = 0;
        let failedTiles = 0;
        tiles.on('tileload', () => {
          loadedTiles += 1;
        });
        tiles.on('tileerror', () => {
          failedTiles += 1;
        });
        tiles.on('load', () => {
          if (cancelled) return;
          setMapState(loadedTiles === 0 && failedTiles > 0 ? 'failed' : 'ready');
        });
        tiles.addTo(map);

        // And a hang is not an error: a tile server that accepts the
        // connection and never answers fires neither event, which would leave
        // "Loading the map…" on screen forever.
        window.setTimeout(() => {
          if (!cancelled && loadedTiles === 0) setMapState('failed');
        }, 8000);

        // A `divIcon` rather than Leaflet's default marker, which loads its
        // image from a relative path that no bundler resolves correctly. This
        // also lets the pin be the brand colour.
        // An inline SVG rather than a CSS teardrop, and rather than Leaflet's
        // own marker.
        //
        // Not the default marker because its image is loaded from a relative
        // path that no bundler resolves, which shows up as an invisible pin and
        // no error. Not a rotated `div` because the tip of a rotated square
        // does not land where its bounding box says, so `iconAnchor` becomes a
        // trigonometry exercise that is wrong by about fifteen metres on
        // screen — which is precisely the accuracy this control exists for.
        //
        // Here the tip is at (12, 32) in the SVG's own coordinates, and that is
        // exactly what `iconAnchor` says.
        const icon = L.divIcon({
          className: '',
          html:
            '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="32" viewBox="0 0 24 32">' +
            '<path d="M12 32C12 32 22 18.5 22 11.5A10 10 0 1 0 2 11.5C2 18.5 12 32 12 32Z" ' +
            'fill="#0a56c4" stroke="#fff" stroke-width="2"/>' +
            '<circle cx="12" cy="11.5" r="3.2" fill="#fff"/></svg>',
          iconSize: [24, 32],
          iconAnchor: [12, 32],
        });

        const marker = L.marker([start.latitude, start.longitude], {
          icon,
          draggable: true,
          keyboard: false,
        }).addTo(map);

        marker.on('dragend', () => {
          const { lat, lng } = marker.getLatLng();
          place({ latitude: lat, longitude: lng });
          setNote(null);
        });
        map.on('click', (event: { latlng: { lat: number; lng: number } }) => {
          place({ latitude: event.latlng.lat, longitude: event.latlng.lng });
          setNote(null);
        });

        mapRef.current = map as unknown as typeof mapRef.current;
        markerRef.current = marker as unknown as typeof markerRef.current;
      } catch {
        // The bundle did not arrive, or the browser refused it. The paste box
        // and the number fields below are unaffected.
        if (!cancelled) setMapState('failed');
      }
    })();

    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // Built once. Recentring on a city change is the effect below, which must
    // not tear the map down and lose a pin somebody already placed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- follow the city select, but only until a pin is placed ----------------
  useEffect(() => {
    if (!centre || point !== null) return;
    mapRef.current?.setView([centre.latitude, centre.longitude], 13);
    // `centreKey` rather than the object, so a re-render with an equal centre
    // does not jump the map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centreKey]);

  // --- typing the numbers ----------------------------------------------------
  function commitTyped(nextLat: string, nextLng: string): void {
    const latitude = Number(nextLat);
    const longitude = Number(nextLng);
    if (nextLat.trim() === '' || nextLng.trim() === '') return;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
    if (!isInPhilippines({ latitude, longitude })) return;
    setPoint({ latitude, longitude });
    markerRef.current?.setLatLng([latitude, longitude]);
    mapRef.current?.setView([latitude, longitude], 16);
  }

  // --- searching for an address ----------------------------------------------

  /**
   * Dispatched directly rather than through a `<form action>`, because this
   * component is rendered INSIDE the store form and a nested form is invalid
   * HTML — the browser silently unnests it and the outer form starts
   * submitting on the wrong button.
   *
   * Which is why the dispatch is wrapped in `startTransition`: React only
   * establishes an action context for it automatically when it is passed to a
   * form's `action` prop. Called bare, it works and logs an error, which is
   * the worst of both — it would sit in the console of a page whose whole
   * purpose is to be trusted with a shop's coordinates.
   */
  function runSearch(): void {
    const query = searchRef.current?.value ?? '';
    if (query.trim().length < MIN_QUERY_LENGTH) {
      // Not sent: the server would refuse it too, and there is no reason to
      // spend somebody else's request budget finding that out.
      setSearchNote(GEOCODE_FAILURE_MESSAGE.TOO_SHORT);
      setDismissedSearch(true);
      return;
    }
    setSearchNote(null);
    const payload = new FormData();
    payload.set('query', query);
    if (centre) {
      payload.set('nearLat', String(centre.latitude));
      payload.set('nearLng', String(centre.longitude));
    }
    setDismissedSearch(false);
    startTransition(() => search(payload));
  }

  function chooseCandidate(next: Coordinate): void {
    place(next);
    setSearchNote(null);
    // 17 rather than the map's own zoom: a geocoder lands on the road, and the
    // point of the next step is to drag the pin onto the building.
    mapRef.current?.setView([next.latitude, next.longitude], 17);
    setDismissedSearch(true);
    setNoteIsError(false);
    setNote('Pin moved to the search result. Drag it onto the building.');
  }

  // --- pasting a link --------------------------------------------------------
  function applyPastedLink(): void {
    const result = parseCoordinateInput(pasted);
    if (!result.ok) {
      setNote(PARSE_FAILURE_MESSAGE[result.reason]);
      setNoteIsError(true);
      return;
    }
    place(result.point);
    mapRef.current?.setView([result.point.latitude, result.point.longitude], 17);
    setNoteIsError(false);
    setNote(
      result.swapped
        ? 'Those were the right numbers the wrong way round — swapped. Check the pin.'
        : 'Pin moved. Check it is on the right building.',
    );
    setPasted('');
  }

  return (
    <div className="space-y-2">
      <span className="text-[11px] font-semibold text-ink-muted">
        {heading}
      </span>

      {searchAvailable ? (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-[12rem] flex-1">
              <span className="text-[11px] font-normal text-ink-muted">
                Search for the address
              </span>
              <input
                ref={searchRef}
                type="text"
                // NOT `type="search"`, which some browsers give an Enter
                // behaviour of their own inside a form.
                placeholder="Aling Nena Carinderia, Tondo"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    // Otherwise this submits the store form.
                    event.preventDefault();
                    runSearch();
                  }
                }}
                className={FIELD}
              />
            </label>
            <button
              type="button"
              onClick={runSearch}
              disabled={searching}
              className="rounded-lg bg-surface-sunken px-3 py-1.5 text-xs font-semibold text-brand-700 disabled:text-ink-faint"
            >
              {searching ? 'Searching…' : 'Search'}
            </button>
          </div>

          {searchNote !== null ? (
            <p role="status" className="text-[11px] leading-relaxed text-red-700">
              {searchNote}
            </p>
          ) : found && !dismissedSearch ? (
            found.ok ? (
              <ul className="divide-y divide-black/5 overflow-hidden rounded-lg border border-black/10">
                {found.candidates.map((candidate) => (
                  <li key={`${candidate.point.latitude},${candidate.point.longitude}`}>
                    <button
                      type="button"
                      onClick={() => chooseCandidate(candidate.point)}
                      className="block w-full px-2.5 py-2 text-left text-[12px] leading-snug hover:bg-surface-sunken"
                    >
                      {candidate.label}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p role="status" className="text-[11px] leading-relaxed text-red-700">
                {found.message}
              </p>
            )
          ) : null}

          <p className="text-[11px] text-ink-faint">{GEOCODER_CREDIT}</p>
        </div>
      ) : null}

      <div
        // Height in the wrapper, not on the map element, so Leaflet measures a
        // container that already has one — a zero-height map renders nothing
        // and gives no error.
        className="relative h-64 w-full overflow-hidden rounded-lg border border-black/10 bg-surface-sunken"
      >
        <div ref={containerRef} className="h-full w-full" />
        {mapState !== 'ready' ? (
          <div
            // Opaque once it has failed — the map underneath is a grey box with
            // a pin floating over the explanation, which reads as a glitch.
            // Translucent while loading, so the tiles appearing is visible.
            className={`pointer-events-none absolute inset-0 grid place-content-center px-6 text-center ${
              mapState === 'failed' ? 'bg-surface-sunken' : 'bg-surface-sunken/85'
            }`}
          >
            <p className="text-[11px] leading-relaxed text-ink-muted">
              {mapState === 'loading'
                ? 'Loading the map…'
                : 'The map could not load — this browser cannot reach the tile ' +
                  'server. Paste a link or type the coordinates below; both work ' +
                  'without it.'}
            </p>
          </div>
        ) : null}
      </div>

      <p className="text-[11px] leading-relaxed text-ink-faint">
        {help}
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-[12rem] flex-1">
          <span className="text-[11px] font-semibold text-ink-muted">
            Or paste a Google Maps or Waze link
          </span>
          <input
            type="text"
            value={pasted}
            onChange={(event) => setPasted(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                // Otherwise this submits the whole store form.
                event.preventDefault();
                applyPastedLink();
              }
            }}
            placeholder="https://www.google.com/maps/@14.5995,120.9842,17z"
            className={FIELD}
          />
        </label>
        <button
          type="button"
          onClick={applyPastedLink}
          className="rounded-lg bg-surface-sunken px-3 py-1.5 text-xs font-semibold text-brand-700"
        >
          Use it
        </button>
      </div>

      {note ? (
        <p
          role="status"
          className={`text-[11px] leading-relaxed ${
            noteIsError ? 'text-red-700' : 'text-emerald-700'
          }`}
        >
          {note}
        </p>
      ) : null}

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="text-[11px] font-semibold text-ink-muted">Latitude</span>
          <input
            name="latitude"
            required
            type="number"
            step="any"
            min={PH_BOUNDS.minLat}
            max={PH_BOUNDS.maxLat}
            value={latText}
            onChange={(event) => {
              setLatText(event.target.value);
              commitTyped(event.target.value, lngText);
            }}
            placeholder="14.5995"
            className={`${FIELD} tabular-nums`}
          />
        </label>
        <label className="block">
          <span className="text-[11px] font-semibold text-ink-muted">Longitude</span>
          <input
            name="longitude"
            required
            type="number"
            step="any"
            min={PH_BOUNDS.minLng}
            max={PH_BOUNDS.maxLng}
            value={lngText}
            onChange={(event) => {
              setLngText(event.target.value);
              commitTyped(latText, event.target.value);
            }}
            placeholder="120.9842"
            className={`${FIELD} tabular-nums`}
          />
        </label>
      </div>
    </div>
  );
}
