import type { LatLon } from './geo';
import { haversine } from './geo';
import type { TrackPoint } from './types';

/**
 * Filtre médian glissant.
 *
 * C'est le seul filtre qui supprime vraiment les pics isolés d'altitude GPS
 * sans les étaler sur les échantillons voisins, contrairement à une moyenne.
 */
export function medianFilter(values: number[], window = 5): number[] {
  if (window < 2 || values.length === 0) return values.slice();
  const half = Math.floor(window / 2);
  const out = new Array<number>(values.length);
  for (let i = 0; i < values.length; i++) {
    const from = Math.max(0, i - half);
    const to = Math.min(values.length, i + half + 1);
    const slice = values.slice(from, to).sort((a, b) => a - b);
    const mid = slice.length >> 1;
    out[i] = slice.length % 2 ? slice[mid] : (slice[mid - 1] + slice[mid]) / 2;
  }
  return out;
}

/** Moyenne glissante centrée, appliquée après le médian pour adoucir les paliers. */
export function movingAverage(values: number[], window = 5): number[] {
  if (window < 2 || values.length === 0) return values.slice();
  const half = Math.floor(window / 2);
  const out = new Array<number>(values.length);
  for (let i = 0; i < values.length; i++) {
    const from = Math.max(0, i - half);
    const to = Math.min(values.length, i + half + 1);
    let sum = 0;
    for (let j = from; j < to; j++) sum += values[j];
    out[i] = sum / (to - from);
  }
  return out;
}

export interface ElevationOptions {
  /** Taille de la fenêtre du filtre médian, en nombre d'échantillons. */
  medianWindow?: number;
  /** Taille de la fenêtre de la moyenne glissante, en nombre d'échantillons. */
  smoothWindow?: number;
  /**
   * Seuil d'hystérésis en mètres : une variation doit dépasser cette valeur
   * pour être comptée comme un vrai changement d'altitude.
   */
  threshold?: number;
}

/**
 * Réglages par défaut, calibrés sur des traces synthétiques bruitées a +/- 8 m
 * (l'ordre de grandeur de l'altimétrie GPS d'un téléphone).
 *
 * Trois scénarios ont servi d'arbitrage : un parcours plat, une montée régulière
 * de 400 m et une succession de bosses de 30 m. Ces valeurs ramènent le D+
 * fantôme du plat sous 25 m par heure (contre près de 9 400 m en sommant
 * naïvement les deltas), au prix d'une sous-estimation des bosses courtes,
 * atténuées par le lissage. Ce compromis est structurel : a +/- 8 m de bruit,
 * une bosse de 15 m d'amplitude n'est pas séparable du bruit sans perdre de
 * l'amplitude. Seul un baromètre le leve vraiment.
 */
export const DEFAULT_ELEVATION_OPTIONS: Required<ElevationOptions> = {
  medianWindow: 5,
  smoothWindow: 15,
  threshold: 7,
};

export interface ElevationProfile {
  /** Série d'altitudes lissée, de même longueur que l'entrée. */
  smoothed: number[];
  ascent: number;
  descent: number;
  /** Distance horizontale parcourue en montée, en mètres (0 sans `cumDist`). */
  ascentDistance: number;
  /** Distance horizontale parcourue en descente, en mètres (0 sans `cumDist`). */
  descentDistance: number;
  /**
   * Gain d'altitude attribué à chaque index, en mètres.
   *
   * Sert à ventiler le dénivelé par tranche sans relancer l'hystérésis : une
   * hystérésis relancée sur chaque kilomètre repart d'une altitude de référence
   * neuve, si bien que la somme des tranches ne retombe pas sur le total. En
   * partageant ces incréments, les deux chiffres coïncident par construction.
   */
  ascentSteps: number[];
  /** Perte d'altitude attribuée à chaque index, en mètres. */
  descentSteps: number[];
}

/**
 * Calculé le dénivelé à partir d'une série d'altitudes bruitées.
 *
 * Sommer les deltas positifs bruts est faux : avec un bruit GPS de +/- 10 m,
 * une sortie plate de deux heures produit plusieurs centaines de mètres de D+
 * inexistant. On lisse d'abord (médian puis moyenne), puis on n'accumule qu'au
 * franchissement d'un seuil d'hystérésis, ce qui rend le résultat stable même
 * quand la série oscille autour d'une valeur.
 */
export function elevationProfile(
  eles: number[],
  opts: ElevationOptions = {},
  /** Distances cumulées alignées sur `eles`, pour répartir la distance montée/descente. */
  cumDist?: number[],
): ElevationProfile {
  const {
    medianWindow = DEFAULT_ELEVATION_OPTIONS.medianWindow,
    smoothWindow = DEFAULT_ELEVATION_OPTIONS.smoothWindow,
    threshold = DEFAULT_ELEVATION_OPTIONS.threshold,
  } = opts;
  if (eles.length === 0) {
    return {
      smoothed: [],
      ascent: 0,
      descent: 0,
      ascentDistance: 0,
      descentDistance: 0,
      ascentSteps: [],
      descentSteps: [],
    };
  }

  const smoothed = movingAverage(medianFilter(eles, medianWindow), smoothWindow);

  let ascent = 0;
  let descent = 0;
  let ascentDistance = 0;
  let descentDistance = 0;
  const ascentSteps = new Array<number>(smoothed.length).fill(0);
  const descentSteps = new Array<number>(smoothed.length).fill(0);
  // Altitude de référence : elle ne bouge qu'une fois le seuil franchi.
  let ref = smoothed[0];
  // Index du dernier franchissement, pour attribuer la distance au bon sens.
  let refIndex = 0;
  for (let i = 1; i < smoothed.length; i++) {
    const delta = smoothed[i] - ref;
    if (delta > threshold || delta < -threshold) {
      const span = cumDist ? cumDist[i] - cumDist[refIndex] : 0;
      if (delta > 0) {
        ascent += delta;
        ascentDistance += span;
        ascentSteps[i] = delta;
      } else {
        descent += -delta;
        descentDistance += span;
        descentSteps[i] = -delta;
      }
      ref = smoothed[i];
      refIndex = i;
    }
  }
  return { smoothed, ascent, descent, ascentDistance, descentDistance, ascentSteps, descentSteps };
}

/**
 * Filtre de Kalman 1D applique indépendamment à la latitude et à la longitude.
 *
 * L'intérêt par rapport à une moyenne glissante : la précision annoncée par le
 * récepteur (`acc`) sert de variance de mesure, donc un point sous couvert
 * forestier pèse moins qu'un point acquis a ciel ouvert.
 *
 * @param processNoise Bruit de process en m/s. Plus il est élevé, plus le
 *   filtre suit les manœuvres rapides ; plus il est bas, plus la trace est
 *   lisse mais en retard dans les virages. 3 m/s convient au VTT.
 */
export function kalmanSmooth(points: TrackPoint[], processNoise = 3): TrackPoint[] {
  if (points.length === 0) return [];
  const out: TrackPoint[] = [];
  let lat = points[0].lat;
  let lon = points[0].lon;
  let variance = (points[0].acc ?? 20) ** 2;
  out.push({ ...points[0] });

  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    const dt = Math.max(0, (p.t - points[i - 1].t) / 1000);
    variance += dt * processNoise * processNoise;
    const measVar = Math.max(1, p.acc ?? 20) ** 2;
    const k = variance / (variance + measVar);
    lat += k * (p.lat - lat);
    lon += k * (p.lon - lon);
    variance *= 1 - k;
    out.push({ ...p, lat, lon });
  }
  return out;
}

export interface CleanOptions {
  /** Précision maximale tolérée, en mètres. Au-delà le point est rejeté. */
  maxAccuracy?: number;
  /** Vitesse maximale plausible, en m/s. Au-delà le point est considère aberrant. */
  maxSpeed?: number;
  /**
   * Déplacement minimal entre deux points retenus, en mètres. Sous ce seuil on
   * considère que l'on est à l'arrêt et que le mouvement apparent est du bruit.
   */
  minSegment?: number;
}

/**
 * Élimine les points inexploitables avant tout calcul de métrique.
 *
 * Sans ce nettoyage, la distance dérive : à l'arrêt, un récepteur qui oscille
 * de 5 m entre deux mesures ajoute environ 300 m par heure de pause.
 */
export function cleanPoints(points: TrackPoint[], opts: CleanOptions = {}): TrackPoint[] {
  const { maxAccuracy = 35, maxSpeed = 25, minSegment = 2 } = opts;
  const out: TrackPoint[] = [];
  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    if (p.acc != null && p.acc > maxAccuracy) continue;
    const last = out[out.length - 1];
    if (!last) {
      out.push(p);
      continue;
    }
    const dt = (p.t - last.t) / 1000;
    if (dt <= 0) continue;
    const d = haversine(last as LatLon, p as LatLon);
    // Saut impossible : point aberrant, on le jette plutôt que de le lisser.
    if (d / dt > maxSpeed) continue;
    // Immobile : on garde l'horodatage (pour le temps total) mais on fige la
    // position sur le dernier point valide, ce qui annule la dérive.
    if (d < minSegment) {
      out.push({ ...p, lat: last.lat, lon: last.lon });
      continue;
    }
    out.push(p);
  }
  return out;
}

export interface StopOptions {
  /** Durée de la fenêtre d'analyse, en secondes. */
  stopWindow?: number;
  /** Rayon plancher en dessous duquel on considère qu'il n'y a pas de déplacement. */
  stopRadius?: number;
  /** Multiplicateur applique à la précision annoncée pour ajuster ce rayon. */
  stopAccuracyFactor?: number;
}

/**
 * Détecte les arrêts et fige la position pendant ceux-ci.
 *
 * Le rejet des micro-segments de `cleanPoints` ne suffit pas : à l'arrêt sous
 * couvert forestier, deux mesures successives peuvent être distantes de 8 m,
 * bien au-dessus de tout seuil raisonnable pour un seul segment. Le signal
 * fiable n'est pas la longueur d'un segment mais le rapport entre le
 * déplacement net sur une fenêtre et le chemin parcouru dans cette fenêtre :
 * à l'arrêt ce rapport s'effondre, en mouvement il reste proche de 1. C'est
 * insensible à l'amplitude du bruit, contrairement à un seuil absolu.
 */
export function freezeStops(points: TrackPoint[], opts: StopOptions = {}): TrackPoint[] {
  const { stopWindow = 10, stopRadius = 8, stopAccuracyFactor = 2.5 } = opts;
  const n = points.length;
  if (n < 3) return points.slice();

  const half = (stopWindow * 1000) / 2;
  const stationary = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let lo = i;
    let hi = i;
    while (lo > 0 && points[i].t - points[lo].t < half) lo--;
    while (hi < n - 1 && points[hi].t - points[i].t < half) hi++;
    if (hi === lo) continue;

    let path = 0;
    let accSum = 0;
    for (let j = lo; j <= hi; j++) {
      if (j > lo) path += haversine(points[j - 1], points[j]);
      accSum += points[j].acc ?? 10;
    }
    const net = haversine(points[lo], points[hi]);
    const limit = Math.max(stopRadius, stopAccuracyFactor * (accSum / (hi - lo + 1)));
    if (net < limit && (path === 0 || net / path < 0.5)) stationary[i] = 1;
  }

  // Fermeture morphologique : un point isolé declare en mouvement au milieu
  // d'un arrêt n'est qu'un aléas de fenêtre, pas un vrai redémarrage.
  for (let i = 1; i < n - 1; i++) {
    if (stationary[i]) continue;
    let j = i;
    while (j < n && !stationary[j]) j++;
    if (j < n && stationary[i - 1] && points[j].t - points[i].t < stopWindow * 1000) {
      for (let k = i; k < j; k++) stationary[k] = 1;
    }
    i = j;
  }

  // Chaque plage immobile est ramenée a son barycentre : le déplacement
  // apparent à l'intérieur de la plage disparaît entièrement.
  const out = points.map((p) => ({ ...p }));
  let i = 0;
  while (i < n) {
    if (!stationary[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && stationary[j]) j++;
    let lat = 0;
    let lon = 0;
    for (let k = i; k < j; k++) {
      lat += points[k].lat;
      lon += points[k].lon;
    }
    const cLat = lat / (j - i);
    const cLon = lon / (j - i);
    for (let k = i; k < j; k++) {
      out[k].lat = cLat;
      out[k].lon = cLon;
      out[k].speed = 0;
    }
    i = j;
  }
  return out;
}
