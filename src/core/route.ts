import { cumulativeDistances, haversine } from './geo';
import { elevationProfile } from './filters';
import { newId } from './id';
import type { Route, RoutePoint } from './types';

/**
 * Densifie une polyligne en insérant des points intermédiaires.
 *
 * Un circuit trace à la main peut n'avoir que quelques sommets : sans
 * densification, le profil altimétrique n'aurait aucun point entre deux clics
 * et le suivi de trace considererait le cycliste hors trace sur les longs
 * segments.
 *
 * @param step Espacement cible entre deux points, en mètres.
 */
export function densify(points: RoutePoint[], step = 25): RoutePoint[] {
  if (points.length < 2) return points.slice();
  const out: RoutePoint[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const d = haversine(a, b);
    const n = Math.floor(d / step);
    for (let k = 1; k <= n; k++) {
      const f = (k * step) / d;
      if (f >= 1) break;
      out.push({
        lat: a.lat + (b.lat - a.lat) * f,
        lon: a.lon + (b.lon - a.lon) * f,
        ele: a.ele != null && b.ele != null ? a.ele + (b.ele - a.ele) * f : null,
      });
    }
    out.push(b);
  }
  return out;
}

/** Construit un circuit complet (distances cumulées, dénivelé, détection de boucle). */
export function buildRoute(name: string, points: RoutePoint[], id: string = newId()): Route {
  const cumDist = cumulativeDistances(points);
  const distance = cumDist[cumDist.length - 1] ?? 0;
  const hasEle = points.some((p) => p.ele != null);
  let ascent = 0;
  let descent = 0;
  if (hasEle) {
    let last = points.find((p) => p.ele != null)!.ele!;
    const eles = points.map((p) => {
      if (p.ele != null) last = p.ele;
      return last;
    });
    // Seuil bas : les altitudes viennent d'un modèle de terrain, pas du GPS,
    // donc elles ne portent pas le bruit qui impose un seuil élevé a
    // l'enregistrement.
    const prof = elevationProfile(eles, { medianWindow: 3, smoothWindow: 3, threshold: 1 });
    ascent = prof.ascent;
    descent = prof.descent;
  }
  const first = points[0];
  const last = points[points.length - 1];
  const loop = points.length > 2 && haversine(first, last) < 50;

  return { id, name, createdAt: Date.now(), points, cumDist, distance, ascent, descent, loop };
}
