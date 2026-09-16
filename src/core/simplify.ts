import type { LatLon } from './geo';
import { localProjector } from './geo';

/**
 * Simplification Douglas-Peucker, tolerance en metres.
 *
 * Utile a deux endroits : alleger un GPX importe de 20 000 points avant de le
 * dessiner (Leaflet s'effondre bien avant), et nettoyer un circuit trace a la
 * main. On projette en metres au prealable, sinon la tolerance varierait avec
 * la latitude.
 */
export function simplify<T extends LatLon>(points: T[], tolerance = 5): T[] {
  if (points.length < 3) return points.slice();
  const proj = localProjector(points[0]);
  const xy = points.map((p) => proj.toXY(p));
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  // Pile explicite : une recursion depasse la limite sur les longues traces.
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    let maxDist = -1;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = perpendicular(xy[i], xy[first], xy[last]);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (maxDist > tolerance && index > 0) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

function perpendicular(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
