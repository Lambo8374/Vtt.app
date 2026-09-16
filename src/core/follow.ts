import type { LatLon } from './geo';
import { bearing, haversine, projectOnSegment } from './geo';
import type { Route } from './types';

export interface FollowState {
  /** Index du segment du circuit sur lequel le cycliste est projeté. */
  segment: number;
  /** Position projetée sur le circuit. */
  snapped: LatLon;
  /** Écart perpendiculaire au circuit, en mètres. */
  deviation: number;
  /** false quand l'écart dépasse le seuil de tolerance. */
  onRoute: boolean;
  /** Distance parcourue le long du circuit, en mètres. */
  distanceAlong: number;
  /** Distance restante jusqu'à l'arrivée, en mètres. */
  distanceRemaining: number;
  /** Dénivelé positif restant, en mètres. */
  ascentRemaining: number;
  /** Avancement dans [0, 1]. */
  progress: number;
  /** Cap à suivre pour rejoindre le circuit, en degrés. */
  bearingToRoute: number;
  /** true si la progression recule : le cycliste revient sur ses pas. */
  wrongWay: boolean;
}

export interface FollowOptions {
  /** Écart au-delà duquel on signale une sortie de trace, en mètres. */
  offRouteThreshold?: number;
  /** Portée de recherche en avant de la position précédente, en mètres. */
  lookAhead?: number;
  /** Portée de recherche en arrière, en mètres. */
  lookBehind?: number;
  /**
   * Pénalité appliquée à un segment orienté a contresens du déplacement, en
   * mètres equivalents. Mettre 0 désactive la desambiguisation par le cap.
   */
  headingWeight?: number;
  /** Déplacement minimal pour que le cap soit jugé fiable, en mètres. */
  headingMinMove?: number;
}

/**
 * Suivi d'une trace existante.
 *
 * Le point delicat est le recalage : chercher bêtement le point du circuit le
 * plus proche fait sauter la progression sur une boucle ou un aller-retour, ou
 * deux portions distantes de quelques mètres se croisent. On limite donc la
 * recherche à une fenêtre autour de la position précédente, et on ne rebascule
 * sur une recherche globale que lorsque la fenêtre ne trouvé plus rien de
 * valable — c'est-a-dire en cas de vraie sortie de trace.
 */
export class RouteFollower {
  private readonly route: Route;
  private readonly opts: Required<FollowOptions>;
  /** Dénivelé positif restant à partir de chaque point. */
  private readonly ascentSuffix: number[];
  private lastSegment = 0;
  private lastAlong = 0;
  private lastPosition: LatLon | null = null;
  /** Dernier cap de déplacement jugé fiable, conservé pendant les arrêts. */
  private travelBearing: number | null = null;

  constructor(route: Route, opts: FollowOptions = {}) {
    this.route = route;
    this.opts = {
      offRouteThreshold: opts.offRouteThreshold ?? 40,
      lookAhead: opts.lookAhead ?? 800,
      lookBehind: opts.lookBehind ?? 200,
      headingWeight: opts.headingWeight ?? 45,
      headingMinMove: opts.headingMinMove ?? 5,
    };
    this.ascentSuffix = buildAscentSuffix(route);
  }

  /** Réinitialise le recalage, par exemple après une mise en pause longue. */
  reset(): void {
    this.lastSegment = 0;
    this.lastAlong = 0;
    this.lastPosition = null;
    this.travelBearing = null;
  }

  update(position: LatLon): FollowState {
    const { points, cumDist, distance } = this.route;
    if (points.length < 2) {
      return {
        segment: 0,
        snapped: position,
        deviation: 0,
        onRoute: true,
        distanceAlong: 0,
        distanceRemaining: 0,
        ascentRemaining: 0,
        progress: 0,
        bearingToRoute: 0,
        wrongWay: false,
      };
    }

    // Le cap de déplacement n'est mis a jour qu'au-delà d'un seuil : sous ce
    // seuil il ne refléterait que le bruit. On garde le dernier cap connu
    // pendant les arrêts plutôt que de le perdre.
    if (this.lastPosition) {
      const moved = haversine(this.lastPosition, position);
      if (moved >= this.opts.headingMinMove) {
        this.travelBearing = bearing(this.lastPosition, position);
      }
    }
    this.lastPosition = position;

    let best = this.searchWindow(position, this.lastSegment);
    if (best.deviation > this.opts.offRouteThreshold) {
      const global = this.searchWindow(position, 0, true);
      if (global.deviation < best.deviation) best = global;
    }

    const along = cumDist[best.segment] + best.t * (cumDist[best.segment + 1] - cumDist[best.segment]);
    // Un recul de quelques mètres n'est que du bruit GPS ; on ne le signale
    // qu'au-delà de 15 m pour ne pas alerter à chaque arrêt.
    const wrongWay = along < this.lastAlong - 15;
    this.lastSegment = best.segment;
    this.lastAlong = along;

    return {
      segment: best.segment,
      snapped: best.point,
      deviation: best.deviation,
      onRoute: best.deviation <= this.opts.offRouteThreshold,
      distanceAlong: along,
      distanceRemaining: Math.max(0, distance - along),
      ascentRemaining: this.ascentRemainingAt(best.segment, best.t),
      progress: distance > 0 ? Math.min(1, along / distance) : 0,
      bearingToRoute: bearing(position, best.point),
      wrongWay,
    };
  }

  private searchWindow(position: LatLon, from: number, global = false) {
    const { points, cumDist } = this.route;
    const anchor = cumDist[from];
    const lo = global ? 0 : lowerBound(cumDist, anchor - this.opts.lookBehind);
    const hi = global
      ? points.length - 1
      : Math.min(points.length - 1, lowerBound(cumDist, anchor + this.opts.lookAhead) + 1);

    let bestScore = Infinity;
    let bestDist = Infinity;
    let bestSeg = from;
    let bestT = 0;
    let bestPoint: LatLon = points[from];
    for (let i = lo; i < hi; i++) {
      const r = projectOnSegment(position, points[i], points[i + 1]);
      // Sur un aller-retour emprunte dans les deux sens, les deux branches se
      // superposent : l'écart latéral ne les distingue pas et le recalage
      // resterait bloque sur l'aller. Le cap de déplacement, lui, les séparé.
      // La pénalité n'agit que sur le choix du segment, jamais sur l'écart
      // renvoyé, pour ne pas declencher de fausse sortie de trace.
      const score = r.distance + this.headingPenalty(i);
      if (score < bestScore) {
        bestScore = score;
        bestDist = r.distance;
        bestSeg = i;
        bestT = r.t;
        bestPoint = r.point;
      }
    }
    return { segment: bestSeg, t: bestT, point: bestPoint, deviation: bestDist };
  }

  /** 0 si le segment suit le sens de marche, `headingWeight` s'il est a contresens. */
  private headingPenalty(segment: number): number {
    const { headingWeight } = this.opts;
    if (headingWeight <= 0 || this.travelBearing == null) return 0;
    const { points } = this.route;
    const segBearing = bearing(points[segment], points[segment + 1]);
    const diff = Math.abs(((segBearing - this.travelBearing + 540) % 360) - 180);
    return (headingWeight * (1 - Math.cos((diff * Math.PI) / 180))) / 2;
  }

  /**
   * Dénivelé restant, interpolé à l'intérieur du segment courant.
   *
   * Sans interpolation, arrive au dernier point on annoncerait encore le
   * dénivelé complet du dernier segment au lieu de zéro.
   */
  private ascentRemainingAt(segment: number, t: number): number {
    const { points } = this.route;
    const a = points[segment].ele;
    const b = points[segment + 1]?.ele;
    const gain = a != null && b != null ? Math.max(0, b - a) : 0;
    return Math.max(0, this.ascentSuffix[segment] - t * gain);
  }
}

/** Dénivelé positif restant à partir de chaque point du circuit. */
function buildAscentSuffix(route: Route): number[] {
  const { points } = route;
  const out = new Array<number>(points.length).fill(0);
  for (let i = points.length - 2; i >= 0; i--) {
    const a = points[i].ele;
    const b = points[i + 1].ele;
    const gain = a != null && b != null ? Math.max(0, b - a) : 0;
    out[i] = out[i + 1] + gain;
  }
  return out;
}

/** Index du premier élément de `arr` (trié) supérieur ou égal a `value`. */
function lowerBound(arr: number[], value: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Distance restante jusqu'au prochain changement de direction marqué, en mètres. */
export function distanceToNextTurn(route: Route, segment: number, minAngle = 45): number | null {
  const { points, cumDist } = route;
  for (let i = segment + 1; i < points.length - 1; i++) {
    const a = bearing(points[i - 1], points[i]);
    const b = bearing(points[i], points[i + 1]);
    // Écart de cap ramène dans [0, 180] : 0 = tout droit, 90 = angle droit.
    const diff = Math.abs(((b - a + 540) % 360) - 180);
    if (diff > minAngle) return cumDist[i] - cumDist[segment];
  }
  return null;
}
