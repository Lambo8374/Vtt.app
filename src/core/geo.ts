/** Rayon moyen de la Terre en metres (sphere WGS84 de meme volume). */
export const EARTH_RADIUS = 6371008.8;

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

export interface LatLon {
  lat: number;
  lon: number;
}

/**
 * Distance orthodromique entre deux points, en metres.
 *
 * On utilise haversine plutot que Vincenty : l'erreur due a l'aplatissement
 * terrestre (~0,3 %) est un ordre de grandeur en dessous du bruit GPS sur les
 * segments de quelques metres qu'on manipule ici.
 */
export function haversine(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Cap (azimut) de `a` vers `b`, en degres dans [0, 360). */
export function bearing(a: LatLon, b: LatLon): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Projection locale en metres autour d'une origine.
 *
 * Suffisamment exacte sur l'etendue d'une sortie VTT (quelques dizaines de km)
 * et bien plus rapide qu'une vraie projection ; elle sert aux calculs
 * geometriques (projection sur segment, simplification) ou travailler en
 * degres fausserait les distances a cause du cos(latitude).
 */
export function localProjector(origin: LatLon) {
  const mPerDegLat = 111132.92 - 559.82 * Math.cos(2 * toRad(origin.lat));
  const mPerDegLon = 111412.84 * Math.cos(toRad(origin.lat));
  return {
    toXY(p: LatLon): [number, number] {
      return [(p.lon - origin.lon) * mPerDegLon, (p.lat - origin.lat) * mPerDegLat];
    },
    toLatLon(x: number, y: number): LatLon {
      return { lat: origin.lat + y / mPerDegLat, lon: origin.lon + x / mPerDegLon };
    },
  };
}

export interface ProjectionResult {
  /** Point projete sur le segment. */
  point: LatLon;
  /** Distance perpendiculaire au segment, en metres. */
  distance: number;
  /** Position relative sur le segment, dans [0, 1]. */
  t: number;
}

/** Projette `p` sur le segment [a, b] et renvoie le point le plus proche. */
export function projectOnSegment(p: LatLon, a: LatLon, b: LatLon): ProjectionResult {
  const proj = localProjector(a);
  const [px, py] = proj.toXY(p);
  const [bx, by] = proj.toXY(b);
  const len2 = bx * bx + by * by;
  if (len2 === 0) return { point: a, distance: haversine(p, a), t: 0 };
  let t = (px * bx + py * by) / len2;
  t = Math.max(0, Math.min(1, t));
  const point = proj.toLatLon(bx * t, by * t);
  return { point, distance: haversine(p, point), t };
}

/** Distances cumulees le long d'une polyligne, en metres (premier element : 0). */
export function cumulativeDistances(points: LatLon[]): number[] {
  const out = new Array<number>(points.length);
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    if (i > 0) total += haversine(points[i - 1], points[i]);
    out[i] = total;
  }
  return out;
}

/** Longueur totale d'une polyligne, en metres. */
export function pathLength(points: LatLon[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversine(points[i - 1], points[i]);
  return total;
}

export interface Bounds {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

export function boundsOf(points: LatLon[]): Bounds | null {
  if (points.length === 0) return null;
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  return { minLat, minLon, maxLat, maxLon };
}
