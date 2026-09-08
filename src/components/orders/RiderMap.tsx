'use client';

import { useEffect, useRef, useState } from 'react';
// Leaflet positions every tile with an inline transform and relies on its own
// stylesheet for `position: absolute`. Without this import the tiles load,
// report themselves loaded, and then stack down the page in normal flow — a
// map that is present, correct and unreadable. Statically imported rather
// than pulled in beside the `import('leaflet')` below, so the styles are in
// the bundle before the first tile can paint.
import 'leaflet/dist/leaflet.css';
import { riderPositionAction } from '@/lib/actions/tracking-actions';
import type { TileSource } from '@/lib/geo/tiles';
import {
  POSITION_FRESH_MS,
  TRACKING_POLL_MS,
  describeDistance,
  describeFix,
  metresToDropoff,
} from '@/lib/orders/tracking';

type MapState = 'LOADING' | 'READY' | 'NO_MAP';

interface Fix {
  latitude: number;
  longitude: number;
  /** Aged against the SERVER's clock, sent with every answer. */
  ageMs: number;
}

/**
 * The rider, moving, on the customer's screen.
 *
 * Three things this component refuses to do, and they are the design:
 *
 * **It never shows a stale pin.** The server returns nothing once a fix is
 * older than ninety seconds, and the age is computed from the server's clock
 * rather than the phone's — a handset ten minutes out would otherwise be told
 * a current fix was stale, or worse, a stale one current. With no fix the map
 * is replaced by a sentence, and the status timeline below carries the screen.
 *
 * **It never estimates an arrival time.** Distance as the crow flies, which is
 * honest, instead of minutes derived from a straight line across a city with
 * one bridge. "400 m away" is useful and cannot be wrong in a way that makes
 * somebody stand at a gate.
 *
 * **It stops when it should.** The poll pauses while the tab is hidden and
 * ends the moment the order stops being trackable, so a delivered order costs
 * nothing.
 *
 * The map itself is Leaflet, loaded dynamically and only on a screen that is
 * already tracking a live delivery — which is also what keeps the tile volume
 * proportional to deliveries rather than to page views. See
 * `lib/geo/tiles.ts`: on a customer screen this needs `MAP_TILE_URL` pointed
 * at somebody's tiles rather than OpenStreetMap's own, and `/admin/health`
 * says so.
 */
export function RiderMap({
  orderId,
  tileSource,
  dropoff,
  riderName,
}: {
  orderId: string;
  tileSource: TileSource;
  dropoff: { latitude: number; longitude: number };
  riderName: string | null;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<{
    setView: (centre: [number, number], zoom: number) => void;
    remove: () => void;
    fitBounds: (bounds: [[number, number], [number, number]], options?: unknown) => void;
  } | null>(null);
  const riderMarkerRef = useRef<{ setLatLng: (latlng: [number, number]) => void } | null>(
    null,
  );

  const [mapState, setMapState] = useState<MapState>('LOADING');
  const [fix, setFix] = useState<Fix | null>(null);
  const [everHadFix, setEverHadFix] = useState(false);
  const [fitted, setFitted] = useState(false);

  // --- the poll ---------------------------------------------------------
  useEffect(() => {
    let cancelled = false;

    async function ask(): Promise<void> {
      if (document.visibilityState !== 'visible') return;
      try {
        const result = await riderPositionAction(orderId);
        if (cancelled) return;
        if (
          result.found &&
          typeof result.latitude === 'number' &&
          typeof result.longitude === 'number' &&
          typeof result.updatedAtMs === 'number'
        ) {
          setFix({
            latitude: result.latitude,
            longitude: result.longitude,
            ageMs: Math.max(0, result.serverNowMs - result.updatedAtMs),
          });
          setEverHadFix(true);
        } else {
          setFix(null);
        }
      } catch {
        // A failed poll is a gap, not an error worth a banner: the next one is
        // ten seconds away, and the sentence for "no fix" already covers what
        // the customer needs to know.
        if (!cancelled) setFix(null);
      }
    }

    void ask();
    const timer = window.setInterval(() => void ask(), TRACKING_POLL_MS);
    document.addEventListener('visibilitychange', () => void ask());

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [orderId]);

  // --- the map ----------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;

    (async () => {
      try {
        const L = await import('leaflet');
        if (cancelled || mapRef.current) return;

        const map = L.map(container, {
          center: [dropoff.latitude, dropoff.longitude],
          zoom: 15,
          // A customer watching a pin does not need to pan and zoom, and a
          // scroll wheel that grabs the page while they are scrolling past is
          // an annoyance rather than a feature.
          scrollWheelZoom: false,
          attributionControl: true,
          zoomControl: false,
        });

        const tiles = L.tileLayer(tileSource.url, {
          maxZoom: 19,
          attribution: tileSource.attribution,
        });
        // Same counting as the store picker's map, for the same reason:
        // Leaflet's `load` fires when the batch settles whether the tiles
        // arrived or failed, so a naive listener calls a grey box ready.
        let loaded = 0;
        let failed = 0;
        tiles.on('tileload', () => {
          loaded += 1;
        });
        tiles.on('tileerror', () => {
          failed += 1;
        });
        tiles.on('load', () => {
          if (cancelled) return;
          setMapState(loaded === 0 && failed > 0 ? 'NO_MAP' : 'READY');
        });
        tiles.addTo(map);
        window.setTimeout(() => {
          if (!cancelled && loaded === 0) setMapState('NO_MAP');
        }, 8000);

        const home = L.divIcon({
          className: '',
          html:
            '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="30" viewBox="0 0 24 32">' +
            '<path d="M12 32C12 32 22 18.5 22 11.5A10 10 0 1 0 2 11.5C2 18.5 12 32 12 32Z" ' +
            'fill="#0f766e" stroke="#fff" stroke-width="2"/>' +
            '<circle cx="12" cy="11.5" r="3.2" fill="#fff"/></svg>',
          iconSize: [22, 30],
          iconAnchor: [11, 30],
        });
        L.marker([dropoff.latitude, dropoff.longitude], { icon: home, keyboard: false }).addTo(
          map,
        );

        // The rider is a disc rather than a teardrop: it is a moving thing,
        // and a pin whose tip claims a doorway is the wrong shape for a
        // position that is only accurate to a few metres.
        const bike = L.divIcon({
          className: '',
          html:
            '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26">' +
            '<circle cx="13" cy="13" r="10" fill="#0a56c4" stroke="#fff" stroke-width="3"/>' +
            '</svg>',
          iconSize: [26, 26],
          iconAnchor: [13, 13],
        });
        const rider = L.marker([dropoff.latitude, dropoff.longitude], {
          icon: bike,
          keyboard: false,
          opacity: 0,
        }).addTo(map);

        mapRef.current = map as unknown as typeof mapRef.current;
        riderMarkerRef.current = rider as unknown as typeof riderMarkerRef.current;
      } catch {
        if (!cancelled) setMapState('NO_MAP');
      }
    })();

    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      riderMarkerRef.current = null;
    };
  }, [dropoff.latitude, dropoff.longitude, tileSource.url, tileSource.attribution]);

  // --- move the pin -----------------------------------------------------
  useEffect(() => {
    const marker = riderMarkerRef.current as
      | (typeof riderMarkerRef.current & { setOpacity?: (value: number) => void })
      | null;
    if (!marker || !fix) return;
    marker.setLatLng([fix.latitude, fix.longitude]);
    marker.setOpacity?.(1);

    // Framed once, on the first fix: both pins in view, so the customer sees
    // the distance rather than a rider filling the screen. After that the view
    // is left alone — a map that recentres every ten seconds cannot be read,
    // and cannot be panned by somebody trying to look ahead.
    if (!fitted) {
      mapRef.current?.fitBounds(
        [
          [fix.latitude, fix.longitude],
          [dropoff.latitude, dropoff.longitude],
        ],
        { padding: [40, 40], maxZoom: 16 },
      );
      setFitted(true);
    }
  }, [fix, fitted, dropoff.latitude, dropoff.longitude]);

  const rider = riderName ?? 'Your rider';
  const distance = fix ? describeDistance(metresToDropoff(fix, dropoff)) : null;
  const age = fix ? describeFix(new Date(Date.now() - fix.ageMs)) : null;

  return (
    <section
      aria-labelledby="tracking-heading"
      className="overflow-hidden rounded-xl bg-surface shadow-sm ring-1 ring-black/5"
    >
      <div className="flex items-baseline justify-between gap-2 px-4 pt-3">
        <h2 id="tracking-heading" className="text-[13px] font-semibold">
          {fix ? `${rider} is ${distance}` : `Where ${rider.toLowerCase()} is`}
        </h2>
        {fix ? (
          <span className="shrink-0 text-[11px] text-ink-faint" aria-live="polite">
            {age}
          </span>
        ) : null}
      </div>

      <div className="relative mt-2">
        <div
          ref={containerRef}
          role="img"
          aria-label={
            fix
              ? `Map showing ${rider} ${distance} from the delivery address`
              : 'Map of the delivery address'
          }
          className="h-56 w-full bg-surface-sunken"
        />

        {mapState !== 'READY' ? (
          <p className="absolute inset-0 flex items-center justify-center bg-surface-sunken px-6 text-center text-[12px] leading-relaxed text-ink-muted">
            {mapState === 'LOADING'
              ? 'Loading the map…'
              : 'The map could not load. The updates below are unaffected.'}
          </p>
        ) : null}
      </div>

      {!fix ? (
        <p className="px-4 pb-3 pt-2 text-[12px] leading-relaxed text-ink-muted">
          {everHadFix
            ? `No signal from ${rider.toLowerCase()} for a moment. The updates below keep coming.`
            : `${rider} has not shared their location yet. It appears here once they do.`}
        </p>
      ) : (
        <p className="px-4 pb-3 pt-2 text-[11px] leading-relaxed text-ink-faint">
          Straight-line distance, updated every {Math.round(TRACKING_POLL_MS / 1000)}{' '}
          seconds. It disappears if the signal is older than{' '}
          {Math.round(POSITION_FRESH_MS / 1000)} seconds, rather than showing you a
          pin that has stopped being true.
        </p>
      )}
    </section>
  );
}
