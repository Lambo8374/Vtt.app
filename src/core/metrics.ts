import { cumulativeDistances, haversine } from './geo';
import { DEFAULT_ELEVATION_OPTIONS, cleanPoints, elevationProfile, freezeStops, kalmanSmooth } from './filters';
import type { CleanOptions, ElevationOptions, StopOptions } from './filters';
import type { Split, TrackMetrics, TrackPoint } from './types';

export interface MetricsOptions extends CleanOptions, ElevationOptions, StopOptions {
  /** Seuil sous lequel on considere le velo a l'arret, en m/s (defaut 0,8 = 2,9 km/h). */
  stoppedSpeed?: number;
  /** Fenetre de lissage de la vitesse instantanee, en secondes. */
  speedWindow?: number;
  /** Desactive le lissage de Kalman (utile pour une trace GPX deja propre). */
  skipSmoothing?: boolean;
  /** Desactive la detection d'arret (utile pour inspecter une trace brute). */
  skipStopDetection?: boolean;
}

/**
 * Convertit les fenetres de lissage d'altitude, calibrees a 1 Hz, vers la
 * cadence reelle de la trace.
 *
 * Sans cette conversion, un GPX enregistre toutes les 5 secondes verrait sa
 * fenetre de 15 echantillons couvrir 75 secondes de trajet et perdrait tout le
 * relief ; a l'inverse, un enregistrement a 5 Hz ne serait pas assez lisse.
 */
export function scaleElevationWindows(
  points: TrackPoint[],
  opts: ElevationOptions,
): Required<ElevationOptions> {
  const base = { ...DEFAULT_ELEVATION_OPTIONS, ...stripUndefined(opts) };
  if (points.length < 3) return base;
  const dts: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const dt = (points[i].t - points[i - 1].t) / 1000;
    if (dt > 0) dts.push(dt);
  }
  if (dts.length === 0) return base;
  dts.sort((a, b) => a - b);
  const medianDt = dts[dts.length >> 1];
  if (!(medianDt > 0) || Math.abs(medianDt - 1) < 0.2) return base;
  const scale = (w: number) => {
    const v = Math.round(w / medianDt);
    return Math.max(1, Math.min(61, v % 2 === 0 ? v + 1 : v));
  };
  return {
    medianWindow: opts.medianWindow ?? scale(DEFAULT_ELEVATION_OPTIONS.medianWindow),
    smoothWindow: opts.smoothWindow ?? scale(DEFAULT_ELEVATION_OPTIONS.smoothWindow),
    threshold: base.threshold,
  };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export interface ComputedTrack {
  /** Points apres nettoyage et lissage : c'est cette serie qu'il faut afficher. */
  points: TrackPoint[];
  /** Distance cumulee a chaque point, en metres. */
  cumDist: number[];
  /** Altitudes lissees, alignees sur `points`. */
  elevations: number[];
  /** Vitesse lissee a chaque point, en m/s. */
  speeds: number[];
  metrics: TrackMetrics;
}

const EMPTY_METRICS: TrackMetrics = {
  distance: 0,
  ascent: 0,
  descent: 0,
  duration: 0,
  movingTime: 0,
  avgSpeed: 0,
  avgMovingSpeed: 0,
  maxSpeed: 0,
  minEle: null,
  maxEle: null,
  avgClimbGrade: 0,
};

/**
 * Vitesse lissee sur une fenetre temporelle.
 *
 * On privilegie la vitesse fournie par le recepteur quand elle existe : elle
 * vient du decalage Doppler et reste bien plus juste qu'une derivee de
 * positions bruitees. La derivee ne sert que de repli, lissee sur `window`
 * secondes pour eviter les pics a chaque oscillation du signal.
 */
export function speedSeries(points: TrackPoint[], window = 5): number[] {
  const n = points.length;
  const out = new Array<number>(n).fill(0);
  if (n < 2) return out;

  for (let i = 0; i < n; i++) {
    const reported = points[i].speed;
    if (reported != null && Number.isFinite(reported) && reported >= 0) {
      out[i] = reported;
      continue;
    }
    // Fenetre centree : on cherche les bornes couvrant +/- window/2 secondes.
    const target = (window * 1000) / 2;
    let lo = i;
    let hi = i;
    while (lo > 0 && points[i].t - points[lo].t < target) lo--;
    while (hi < n - 1 && points[hi].t - points[i].t < target) hi++;
    const dt = (points[hi].t - points[lo].t) / 1000;
    if (dt <= 0) {
      out[i] = i > 0 ? out[i - 1] : 0;
      continue;
    }
    let d = 0;
    for (let j = lo + 1; j <= hi; j++) d += haversine(points[j - 1], points[j]);
    out[i] = d / dt;
  }
  return out;
}

/** Calcule toutes les metriques d'une serie de points GPS bruts. */
export function computeTrack(raw: TrackPoint[], opts: MetricsOptions = {}): ComputedTrack {
  const { stoppedSpeed = 0.8, speedWindow = 5, skipSmoothing = false, skipStopDetection = false } = opts;

  // Ordre impose : on rejette d'abord l'inexploitable, on lisse ensuite ce qui
  // reste, puis on neutralise les arrets. Detecter les arrets avant le lissage
  // reviendrait a chercher un signal faible dans le bruit maximal.
  const cleaned = cleanPoints(raw, opts);
  const smoothed = skipSmoothing ? cleaned : kalmanSmooth(cleaned);
  const points = skipStopDetection ? smoothed : freezeStops(smoothed, opts);
  if (points.length === 0) {
    return { points: [], cumDist: [], elevations: [], speeds: [], metrics: { ...EMPTY_METRICS } };
  }

  const cumDist = cumulativeDistances(points);
  // La distance est la somme de tous les segments, sans base minimale.
  // Accumuler sur une base de 10 a 30 m corrigerait bien le gonflement du
  // rectiligne (+3,9 % ramene a +0,2 % en mesure) mais degraderait les lacets
  // serres de -7 % a -16 %, le lissage rognant deja les virages : le pire cas
  // empire. Le biais residuel mesure est de +2 a +4 % selon la qualite du
  // signal, ce qui reste le meilleur compromis disponible ici.
  const distance = cumDist[cumDist.length - 1];

  // Les points sans altitude sont remplaces par la derniere connue : une serie
  // trouee ferait sauter le filtre median.
  const hasEle = points.some((p) => p.ele != null);
  const rawEles: number[] = [];
  let lastEle = points.find((p) => p.ele != null)?.ele ?? 0;
  for (const p of points) {
    if (p.ele != null) lastEle = p.ele;
    rawEles.push(lastEle);
  }

  const eleOpts = scaleElevationWindows(points, opts);
  const profile = hasEle
    ? elevationProfile(rawEles, eleOpts, cumDist)
    : { smoothed: rawEles.map(() => 0), ascent: 0, descent: 0, ascentDistance: 0, descentDistance: 0 };

  const speeds = speedSeries(points, speedWindow);

  let movingTime = 0;
  for (let i = 1; i < points.length; i++) {
    const dt = points[i].t - points[i - 1].t;
    if (dt <= 0) continue;
    // Un segment compte comme roule si la vitesse a l'une de ses bornes depasse
    // le seuil : sinon les redemarrages seraient systematiquement tronques.
    if (Math.max(speeds[i], speeds[i - 1]) > stoppedSpeed) movingTime += dt;
  }

  const duration = points[points.length - 1].t - points[0].t;
  const maxSpeed = speeds.reduce((m, s) => (s > m ? s : m), 0);

  return {
    points,
    cumDist,
    elevations: profile.smoothed,
    speeds,
    metrics: {
      distance,
      ascent: profile.ascent,
      descent: profile.descent,
      duration,
      movingTime,
      avgSpeed: duration > 0 ? distance / (duration / 1000) : 0,
      avgMovingSpeed: movingTime > 0 ? distance / (movingTime / 1000) : 0,
      maxSpeed,
      minEle: hasEle ? Math.min(...profile.smoothed) : null,
      maxEle: hasEle ? Math.max(...profile.smoothed) : null,
      avgClimbGrade:
        profile.ascentDistance > 0 ? (profile.ascent / profile.ascentDistance) * 100 : 0,
    },
  };
}

/**
 * Decoupe la sortie en tranches de `step` metres (1 km par defaut).
 *
 * Les bornes sont interpolees a la distance exacte, de sorte qu'un segment
 * plein mesure exactement `step`. Le dernier est presque toujours partiel : on
 * le renvoie avec sa distance reelle pour que son allure reste juste.
 */
export function computeSplits(track: ComputedTrack, step = 1000): Split[] {
  const { points, cumDist, elevations } = track;
  if (points.length < 2 || step <= 0) return [];

  /**
   * Etat de la trace a une distance donnee, interpole entre deux points.
   *
   * Sans interpolation, un segment se fermerait au premier point au-dela du
   * kilometre, soit jusqu'a 10 m de trop a 36 km/h : l'allure affichee serait
   * faussee de 1 % et les bornes ne tomberaient jamais rondes.
   */
  const at = (target: number) => {
    let i = 1;
    while (i < points.length - 1 && cumDist[i] < target) i++;
    const d0 = cumDist[i - 1];
    const d1 = cumDist[i];
    const f = d1 > d0 ? Math.min(1, Math.max(0, (target - d0) / (d1 - d0))) : 0;
    return {
      index: i,
      dist: target,
      time: points[i - 1].t + f * (points[i].t - points[i - 1].t),
      ele: elevations.length ? elevations[i - 1] + f * (elevations[i] - elevations[i - 1]) : 0,
    };
  };

  const total = cumDist[cumDist.length - 1];
  const splits: Split[] = [];
  let from = { index: 0, dist: 0, time: points[0].t, ele: elevations[0] ?? 0 };

  for (let mark = step; ; mark += step) {
    const isLast = mark >= total;
    const to = isLast
      ? {
          index: points.length - 1,
          dist: total,
          time: points[points.length - 1].t,
          ele: elevations[elevations.length - 1] ?? 0,
        }
      : at(mark);

    const distance = to.dist - from.dist;
    if (distance > 1) {
      const duration = to.time - from.time;
      // Les altitudes sont deja lissees : on applique l'hysteresis seule, sans
      // relisser une serie courte qui perdrait son relief.
      const slice = [from.ele, ...elevations.slice(from.index, to.index), to.ele];
      const { ascent, descent } = elevationProfile(slice, {
        medianWindow: 1,
        smoothWindow: 1,
        threshold: 1,
      });
      splits.push({
        index: splits.length + 1,
        distance,
        duration,
        speed: duration > 0 ? distance / (duration / 1000) : 0,
        ascent,
        descent,
      });
    }
    from = to;
    if (isLast) break;
  }
  return splits;
}
