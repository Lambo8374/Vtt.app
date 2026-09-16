import { cumulativeDistances, haversine } from './geo';
import { DEFAULT_ELEVATION_OPTIONS, cleanPoints, elevationProfile, freezeStops, kalmanSmooth } from './filters';
import type { CleanOptions, ElevationOptions, StopOptions } from './filters';
import type { Split, TrackMetrics, TrackPoint } from './types';

export interface MetricsOptions extends CleanOptions, ElevationOptions, StopOptions {
  /** Seuil sous lequel on considère le vélo à l'arrêt, en m/s (défaut 0,8 = 2,9 km/h). */
  stoppedSpeed?: number;
  /** Fenêtre de lissage de la vitesse instantanée, en secondes. */
  speedWindow?: number;
  /** Désactive le lissage de Kalman (utile pour une trace GPX déjà propre). */
  skipSmoothing?: boolean;
  /** Désactive la détection d'arrêt (utile pour inspecter une trace brute). */
  skipStopDetection?: boolean;
}

/**
 * Convertit les fenêtres de lissage d'altitude, calibrées à 1 Hz, vers la
 * cadence réelle de la trace.
 *
 * Sans cette conversion, un GPX enregistre toutes les 5 secondes verrait sa
 * fenêtre de 15 échantillons couvrir 75 secondes de trajet et perdrait tout le
 * relief ; à l'inverse, un enregistrement a 5 Hz ne serait pas assez lisse.
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
  /** Points après nettoyage et lissage : c'est cette série qu'il faut afficher. */
  points: TrackPoint[];
  /** Distance cumulée à chaque point, en mètres. */
  cumDist: number[];
  /** Altitudes lissées, alignées sur `points`. */
  elevations: number[];
  /** Vitesse lissée à chaque point, en m/s. */
  speeds: number[];
  /** Distance horizontale parcourue en montée, en mètres. */
  ascentDistance: number;
  /** Gain d'altitude attribué à chaque point, pour ventiler le D+ par tranche. */
  ascentSteps: number[];
  /** Perte d'altitude attribuée à chaque point. */
  descentSteps: number[];
  /**
   * Index de debut de chaque tronçon. Un tronçon commence après une pause :
   * la distance et la durée separant deux tronçons ne comptent pas.
   */
  segmentStarts: number[];
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
 * Vitesse lissée sur une fenêtre temporelle.
 *
 * On privilégie la vitesse fournie par le récepteur quand elle existe : elle
 * vient du décalage Doppler et reste bien plus juste qu'une dérivée de
 * positions bruitées. La dérivée ne sert que de repli, lissée sur `window`
 * secondes pour éviter les pics à chaque oscillation du signal.
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
    // Fenêtre centrée : on cherche les bornes couvrant +/- window/2 secondes.
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

/** Calcule toutes les métriques d'une série de points GPS bruts. */
export function computeTrack(raw: TrackPoint[], opts: MetricsOptions = {}): ComputedTrack {
  const { stoppedSpeed = 0.8, speedWindow = 5, skipSmoothing = false, skipStopDetection = false } = opts;

  // Ordre impose : on rejette d'abord l'inexploitable, on lisse ensuite ce qui
  // reste, puis on neutralise les arrêts. Détecter les arrêts avant le lissage
  // reviendrait a chercher un signal faible dans le bruit maximal.
  const cleaned = cleanPoints(raw, opts);
  const smoothed = skipSmoothing ? cleaned : kalmanSmooth(cleaned);
  const points = skipStopDetection ? smoothed : freezeStops(smoothed, opts);
  if (points.length === 0) {
    return {
      points: [],
      cumDist: [],
      elevations: [],
      speeds: [],
      ascentDistance: 0,
      ascentSteps: [],
      descentSteps: [],
      segmentStarts: [],
      metrics: { ...EMPTY_METRICS },
    };
  }

  const cumDist = cumulativeDistances(points);
  // La distance est la somme de tous les segments, sans base minimale.
  // Accumuler sur une base de 10 a 30 m corrigerait bien le gonflement du
  // rectiligne (+3,9 % ramène a +0,2 % en mesure) mais dégraderait les lacets
  // serrés de -7 % a -16 %, le lissage rognant déjà les virages : le pire cas
  // empire. Le biais résiduel mesure est de +2 a +4 % selon la qualité du
  // signal, ce qui reste le meilleur compromis disponible ici.
  const distance = cumDist[cumDist.length - 1];

  // Les points sans altitude sont remplacés par la dernière connue : une série
  // trouée ferait sauter le filtre médian.
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
    : {
        smoothed: rawEles.map(() => 0),
        ascent: 0,
        descent: 0,
        ascentDistance: 0,
        descentDistance: 0,
        ascentSteps: rawEles.map(() => 0),
        descentSteps: rawEles.map(() => 0),
      };

  const speeds = speedSeries(points, speedWindow);

  let movingTime = 0;
  for (let i = 1; i < points.length; i++) {
    const dt = points[i].t - points[i - 1].t;
    if (dt <= 0) continue;
    // Un segment compte comme roule si la vitesse à l'une de ses bornes dépasse
    // le seuil : sinon les redémarrages seraient systématiquement tronqués.
    if (Math.max(speeds[i], speeds[i - 1]) > stoppedSpeed) movingTime += dt;
  }

  const duration = points[points.length - 1].t - points[0].t;
  const maxSpeed = speeds.reduce((m, s) => (s > m ? s : m), 0);

  return {
    points,
    cumDist,
    elevations: profile.smoothed,
    speeds,
    ascentDistance: profile.ascentDistance,
    ascentSteps: profile.ascentSteps,
    descentSteps: profile.descentSteps,
    segmentStarts: [0],
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
 * Découpe la sortie en tranches de `step` mètres (1 km par défaut).
 *
 * Les bornes sont interpolees à la distance exacte, de sorte qu'un segment
 * plein mesure exactement `step`. Le dernier est presque toujours partiel : on
 * le renvoie avec sa distance réelle pour que son allure reste juste.
 */
export function computeSplits(track: ComputedTrack, step = 1000): Split[] {
  const { points, cumDist, elevations } = track;
  if (points.length < 2 || step <= 0) return [];

  /**
   * État de la trace à une distance donnée, interpolé entre deux points.
   *
   * Sans interpolation, un segment se fermerait au premier point au-delà du
   * kilomètre, soit jusqu’à 10 m de trop a 36 km/h : l'allure affichée serait
   * faussée de 1 % et les bornes ne tomberaient jamais rondes.
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

  /**
   * Durée des pauses comprises entre deux index.
   *
   * Une tranche a cheval sur une pause afficherait sinon une allure absurde,
   * la durée de la pause étant imputée au kilomètre en cours.
   */
  const pausedBetween = (from: number, to: number) => {
    let paused = 0;
    for (const start of track.segmentStarts) {
      if (start > from && start <= to) paused += points[start].t - points[start - 1].t;
    }
    return paused;
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
      const duration = to.time - from.time - pausedBetween(from.index, to.index);
      // On ventile les incréments issus de l'unique passe d'hystérésis du
      // calcul global. Relancer une hystérésis par kilomètre repartirait d'une
      // altitude de référence neuve à chaque borne : la somme des tranches ne
      // retomberait pas sur le D+ total affiché juste au-dessus, écart que
      // l'utilisateur constate immédiatement.
      let ascent = 0;
      let descent = 0;
      for (let i = from.index; i < to.index; i++) {
        ascent += track.ascentSteps[i] ?? 0;
        descent += track.descentSteps[i] ?? 0;
      }
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

/**
 * Agrege plusieurs tronçons enregistres en une seule sortie.
 *
 * Une pause coupe la trace en tronçons. Concaténer simplement les points
 * ferait compter le déplacement effectué pendant la pause : sur une journee de
 * navette, la remontée en voiture ajouterait plusieurs dizaines de kilomètres
 * et un dénivelé qui n'a pas ete pédalé. Chaque tronçon est donc calculé
 * séparément, puis les totaux sont sommes.
 */
export function computeSegments(segments: TrackPoint[][], opts: MetricsOptions = {}): ComputedTrack {
  const usable = segments.filter((s) => s.length > 0);
  if (usable.length === 0) return computeTrack([], opts);
  if (usable.length === 1) return computeTrack(usable[0], opts);

  const parts = usable.map((s) => computeTrack(s, opts)).filter((p) => p.points.length > 0);
  if (parts.length === 0) return computeTrack([], opts);

  const points: TrackPoint[] = [];
  const cumDist: number[] = [];
  const elevations: number[] = [];
  const speeds: number[] = [];
  const ascentSteps: number[] = [];
  const descentSteps: number[] = [];
  const segmentStarts: number[] = [];
  let offset = 0;

  for (const part of parts) {
    segmentStarts.push(points.length);
    for (let i = 0; i < part.points.length; i++) {
      points.push(part.points[i]);
      cumDist.push(offset + part.cumDist[i]);
      elevations.push(part.elevations[i] ?? 0);
      speeds.push(part.speeds[i]);
      ascentSteps.push(part.ascentSteps[i] ?? 0);
      descentSteps.push(part.descentSteps[i] ?? 0);
    }
    offset += part.metrics.distance;
  }

  const sum = (f: (m: TrackMetrics) => number) => parts.reduce((a, p) => a + f(p.metrics), 0);
  const distance = sum((m) => m.distance);
  const duration = sum((m) => m.duration);
  const movingTime = sum((m) => m.movingTime);
  const ascent = sum((m) => m.ascent);
  const ascentDistance = parts.reduce((a, p) => a + p.ascentDistance, 0);
  const eles = parts.flatMap((p) => (p.metrics.minEle != null ? [p.metrics.minEle, p.metrics.maxEle!] : []));

  return {
    points,
    cumDist,
    elevations,
    speeds,
    ascentDistance,
    ascentSteps,
    descentSteps,
    segmentStarts,
    metrics: {
      distance,
      ascent,
      descent: sum((m) => m.descent),
      duration,
      movingTime,
      avgSpeed: duration > 0 ? distance / (duration / 1000) : 0,
      avgMovingSpeed: movingTime > 0 ? distance / (movingTime / 1000) : 0,
      maxSpeed: parts.reduce((a, p) => Math.max(a, p.metrics.maxSpeed), 0),
      minEle: eles.length ? Math.min(...eles) : null,
      maxEle: eles.length ? Math.max(...eles) : null,
      avgClimbGrade: ascentDistance > 0 ? (ascent / ascentDistance) * 100 : 0,
    },
  };
}
