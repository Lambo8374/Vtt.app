import type { LatLon } from './geo';
import { haversine } from './geo';
import type { TrackPoint } from './types';

/**
 * Filtre median glissant.
 *
 * C'est le seul filtre qui supprime vraiment les pics isoles d'altitude GPS
 * sans les etaler sur les echantillons voisins, contrairement a une moyenne.
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

/** Moyenne glissante centree, appliquee apres le median pour adoucir les paliers. */
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
  /** Taille de la fenetre du filtre median, en nombre d'echantillons. */
  medianWindow?: number;
  /** Taille de la fenetre de la moyenne glissante, en nombre d'echantillons. */
  smoothWindow?: number;
  /**
   * Seuil d'hysteresis en metres : une variation doit depasser cette valeur
   * pour etre comptee comme un vrai changement d'altitude.
   */
  threshold?: number;
}

/**
 * Reglages par defaut, calibres sur des traces synthetiques bruitees a +/- 8 m
 * (l'ordre de grandeur de l'altimetrie GPS d'un telephone).
 *
 * Trois scenarios ont servi d'arbitrage : un parcours plat, une montee reguliere
 * de 400 m et une succession de bosses de 30 m. Ces valeurs ramenent le D+
 * fantome du plat sous 25 m par heure (contre pres de 9 400 m en sommant
 * naivement les deltas), au prix d'une sous-estimation des bosses courtes,
 * attenuees par le lissage. Ce compromis est structurel : a +/- 8 m de bruit,
 * une bosse de 15 m d'amplitude n'est pas separable du bruit sans perdre de
 * l'amplitude. Seul un barometre le leve vraiment.
 */
export const DEFAULT_ELEVATION_OPTIONS: Required<ElevationOptions> = {
  medianWindow: 5,
  smoothWindow: 15,
  threshold: 7,
};

export interface ElevationProfile {
  /** Serie d'altitudes lissee, de meme longueur que l'entree. */
  smoothed: number[];
  ascent: number;
  descent: number;
  /** Distance horizontale parcourue en montee, en metres (0 sans `cumDist`). */
  ascentDistance: number;
  /** Distance horizontale parcourue en descente, en metres (0 sans `cumDist`). */
  descentDistance: number;
}

/**
 * Calcule le denivele a partir d'une serie d'altitudes bruitees.
 *
 * Sommer les deltas positifs bruts est faux : avec un bruit GPS de +/- 10 m,
 * une sortie plate de deux heures produit plusieurs centaines de metres de D+
 * inexistant. On lisse d'abord (median puis moyenne), puis on n'accumule qu'au
 * franchissement d'un seuil d'hysteresis, ce qui rend le resultat stable meme
 * quand la serie oscille autour d'une valeur.
 */
export function elevationProfile(
  eles: number[],
  opts: ElevationOptions = {},
  /** Distances cumulees alignees sur `eles`, pour repartir la distance montee/descente. */
  cumDist?: number[],
): ElevationProfile {
  const {
    medianWindow = DEFAULT_ELEVATION_OPTIONS.medianWindow,
    smoothWindow = DEFAULT_ELEVATION_OPTIONS.smoothWindow,
    threshold = DEFAULT_ELEVATION_OPTIONS.threshold,
  } = opts;
  const empty = { smoothed: [], ascent: 0, descent: 0, ascentDistance: 0, descentDistance: 0 };
  if (eles.length === 0) return empty;

  const smoothed = movingAverage(medianFilter(eles, medianWindow), smoothWindow);

  let ascent = 0;
  let descent = 0;
  let ascentDistance = 0;
  let descentDistance = 0;
  // Altitude de reference : elle ne bouge qu'une fois le seuil franchi.
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
      } else {
        descent += -delta;
        descentDistance += span;
      }
      ref = smoothed[i];
      refIndex = i;
    }
  }
  return { smoothed, ascent, descent, ascentDistance, descentDistance };
}

/**
 * Filtre de Kalman 1D applique independamment a la latitude et a la longitude.
 *
 * L'interet par rapport a une moyenne glissante : la precision annoncee par le
 * recepteur (`acc`) sert de variance de mesure, donc un point sous couvert
 * forestier pese moins qu'un point acquis a ciel ouvert.
 *
 * @param processNoise Bruit de process en m/s. Plus il est eleve, plus le
 *   filtre suit les manoeuvres rapides ; plus il est bas, plus la trace est
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
  /** Precision maximale toleree, en metres. Au-dela le point est rejete. */
  maxAccuracy?: number;
  /** Vitesse maximale plausible, en m/s. Au-dela le point est considere aberrant. */
  maxSpeed?: number;
  /**
   * Deplacement minimal entre deux points retenus, en metres. Sous ce seuil on
   * considere que l'on est a l'arret et que le mouvement apparent est du bruit.
   */
  minSegment?: number;
}

/**
 * Elimine les points inexploitables avant tout calcul de metrique.
 *
 * Sans ce nettoyage, la distance derive : a l'arret, un recepteur qui oscille
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
    // Saut impossible : point aberrant, on le jette plutot que de le lisser.
    if (d / dt > maxSpeed) continue;
    // Immobile : on garde l'horodatage (pour le temps total) mais on fige la
    // position sur le dernier point valide, ce qui annule la derive.
    if (d < minSegment) {
      out.push({ ...p, lat: last.lat, lon: last.lon });
      continue;
    }
    out.push(p);
  }
  return out;
}

export interface StopOptions {
  /** Duree de la fenetre d'analyse, en secondes. */
  stopWindow?: number;
  /** Rayon plancher en dessous duquel on considere qu'il n'y a pas de deplacement. */
  stopRadius?: number;
  /** Multiplicateur applique a la precision annoncee pour ajuster ce rayon. */
  stopAccuracyFactor?: number;
}

/**
 * Detecte les arrets et fige la position pendant ceux-ci.
 *
 * Le rejet des micro-segments de `cleanPoints` ne suffit pas : a l'arret sous
 * couvert forestier, deux mesures successives peuvent etre distantes de 8 m,
 * bien au-dessus de tout seuil raisonnable pour un seul segment. Le signal
 * fiable n'est pas la longueur d'un segment mais le rapport entre le
 * deplacement net sur une fenetre et le chemin parcouru dans cette fenetre :
 * a l'arret ce rapport s'effondre, en mouvement il reste proche de 1. C'est
 * insensible a l'amplitude du bruit, contrairement a un seuil absolu.
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

  // Fermeture morphologique : un point isole declare en mouvement au milieu
  // d'un arret n'est qu'un aleas de fenetre, pas un vrai redemarrage.
  for (let i = 1; i < n - 1; i++) {
    if (stationary[i]) continue;
    let j = i;
    while (j < n && !stationary[j]) j++;
    if (j < n && stationary[i - 1] && points[j].t - points[i].t < stopWindow * 1000) {
      for (let k = i; k < j; k++) stationary[k] = 1;
    }
    i = j;
  }

  // Chaque plage immobile est ramenee a son barycentre : le deplacement
  // apparent a l'interieur de la plage disparait entierement.
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
