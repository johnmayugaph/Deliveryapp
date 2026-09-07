/**
 * Where the map's tiles come from.
 *
 * OpenStreetMap by default: free, no account, no key, and good coverage of
 * Philippine barangay streets — which is more than can be said for some paid
 * providers. Their tile policy permits light use, and a store-creation form in
 * an operator console is about as light as it gets.
 *
 * Overridable because it will eventually need to be. If TARA ever renders maps
 * on a customer screen the volume stops being light, and OSM's policy says to
 * self-host or buy tiles at that point. Better to have the seam now than to
 * discover it in a policy email.
 *
 * Read on the SERVER and passed down as a prop, deliberately NOT through a
 * `NEXT_PUBLIC_` variable. Those are inlined into the client bundle at build
 * time, so a `NEXT_PUBLIC_MAP_TILE_URL` would bake whatever was set during
 * `docker build` into the image and ignore the deployment's own setting — see
 * the note in the Dockerfile.
 */

export interface TileSource {
  /** A Leaflet template: `{z}`, `{x}`, `{y}`. */
  url: string;
  /** Rendered in the map's corner. For OSM this is a licence condition. */
  attribution: string;
}

export const OPENSTREETMAP: TileSource = {
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '&copy; OpenStreetMap contributors',
};

export function tileSource(
  env: Record<string, string | undefined> = process.env,
): TileSource {
  const url = (env.MAP_TILE_URL ?? '').trim();
  // A template with no {z}/{x}/{y} in it is a misconfiguration that would
  // render one tile repeated across the whole map — which looks like a working
  // map of nowhere, and is worse than falling back.
  if (url.length === 0 || !/\{z\}/.test(url) || !/\{x\}/.test(url) || !/\{y\}/.test(url)) {
    return OPENSTREETMAP;
  }
  const attribution = (env.MAP_TILE_ATTRIBUTION ?? '').trim();
  return {
    url,
    // Whoever the tiles come from almost certainly requires crediting too, so
    // an empty attribution keeps a visible placeholder rather than silently
    // rendering none.
    attribution: attribution.length > 0 ? attribution : 'Map tiles',
  };
}
