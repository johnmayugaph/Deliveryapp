const EARTH_RADIUS_METERS = 6_371_000;

/**
 * Great-circle distance in metres.
 *
 * Good enough for a delivery quote and a dispatch shortlist; it ignores roads,
 * which is why the fee rules carry a base fee rather than pretending this is
 * the distance a rider actually travels.
 */
export function haversineMeters(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRadians(toLat - fromLat);
  const dLng = toRadians(toLng - fromLng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(fromLat)) * Math.cos(toRadians(toLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * A latitude/longitude bounding box around a point, for narrowing a query
 * before computing exact distances. A degree of latitude is ~111km; longitude
 * shrinks with latitude, and Philippine latitudes are low enough that the
 * correction is small but worth applying.
 */
export function boundingBox(
  latitude: number,
  longitude: number,
  radiusMeters: number,
): { latDelta: number; lngDelta: number } {
  const latDelta = radiusMeters / 111_000;
  const lngDelta =
    radiusMeters / (111_000 * Math.max(0.1, Math.cos((latitude * Math.PI) / 180)));
  return { latDelta, lngDelta };
}
