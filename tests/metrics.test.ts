import { describe, expect, it } from 'vitest';
import { computeSegments, computeSplits, computeTrack, scaleElevationWindows, speedSeries } from '../src/core/metrics';
import type { TrackPoint } from '../src/core/types';
import { pathLength } from '../src/core/geo';
import { syntheticTrack } from './helpers';

/** Colle deux traces bout a bout en recalant position et horodatage. */
function concat(a: TrackPoint[], b: TrackPoint[]): TrackPoint[] {
  const last = a[a.length - 1];
  const shifted = b.map((p, i) => ({
    ...p,
    lat: last.lat + (p.lat - b[0].lat),
    lon: last.lon + (p.lon - b[0].lon),
    t: last.t + (i + 1) * 1000,
  }));
  return [...a, ...shifted];
}

describe('speedSeries', () => {
  it('privilégie la vitesse annoncée par le récepteur', () => {
    const pts: TrackPoint[] = [
      { lat: 45, lon: 3, ele: 200, t: 0, speed: 7 },
      { lat: 45.001, lon: 3, ele: 200, t: 1000, speed: 7 },
    ];
    expect(speedSeries(pts)).toEqual([7, 7]);
  });

  it('dérive la vitesse quand le récepteur ne la donne pas', () => {
    const pts = syntheticTrack({ count: 60, speed: 6, posNoise: 0 });
    const speeds = speedSeries(pts);
    expect(speeds[30]).toBeCloseTo(6, 1);
  });

  it('renvoie des zeros sur un point unique', () => {
    expect(speedSeries([{ lat: 45, lon: 3, ele: null, t: 0 }])).toEqual([0]);
  });
});

describe('computeTrack', () => {
  it('ramène le gonflement de distance de +24 % à moins de 5 %', () => {
    const pts = syntheticTrack({ count: 600, speed: 5, posNoise: 4, accuracy: 5, seed: 31 });
    const truth = 5 * 599;

    // Témoin : la somme des segments bruts surestime massivement la distance,
    // chaque oscillation du signal ajoutant de la longueur.
    expect(pathLength(pts) / truth).toBeGreaterThan(1.2);

    const { metrics } = computeTrack(pts);
    expect(Math.abs(metrics.distance - truth) / truth).toBeLessThan(0.05);
  });

  it('est exacte sur une trace sans bruit quand le lissage est désactive', () => {
    const pts = syntheticTrack({ count: 300, speed: 5, posNoise: 0, accuracy: 3 });
    const exact = computeTrack(pts, { skipSmoothing: true, skipStopDetection: true });
    expect(exact.metrics.distance).toBeCloseTo(5 * 299, 0);
  });

  it('ne raccourcit une trace propre que de façon marginale avec le lissage', () => {
    // Un filtre de Kalman en position seule traine derrière le mouvement réel :
    // il raccourcit légèrement la trace. Le déficit doit rester sous 0,5 %,
    // sans commune mesure avec les 24 % de gonflement qu'il supprime.
    const pts = syntheticTrack({ count: 300, speed: 5, posNoise: 0, accuracy: 3 });
    const truth = 5 * 299;
    const d = computeTrack(pts).metrics.distance;
    expect(d).toBeLessThan(truth);
    expect((truth - d) / truth).toBeLessThan(0.005);
  });

  it('distingue le temps total du temps en mouvement', () => {
    const ride = syntheticTrack({ count: 300, speed: 5, posNoise: 3, seed: 41 });
    const pause = syntheticTrack({ count: 300, speed: 0, posNoise: 5, seed: 42 });
    const { metrics } = computeTrack(concat(ride, pause));

    expect(metrics.duration).toBeGreaterThan(590_000);
    expect(metrics.movingTime).toBeLessThan(metrics.duration * 0.65);
    expect(metrics.avgMovingSpeed).toBeGreaterThan(metrics.avgSpeed * 1.4);
  });

  it('calcule le dénivelé et la pente moyenne en montée', () => {
    // 600 points a 5 m/s = 3000 m de développé pour 150 m de D+, soit 5 %.
    const pts = syntheticTrack({ count: 600, speed: 5, elevationGain: 150, eleNoise: 3, seed: 51 });
    const { metrics } = computeTrack(pts);
    expect(metrics.ascent).toBeGreaterThan(130);
    expect(metrics.ascent).toBeLessThan(170);
    expect(metrics.avgClimbGrade).toBeGreaterThan(3);
    expect(metrics.avgClimbGrade).toBeLessThan(8);
  });

  it('ne retient pas une vitesse maximale aberrante', () => {
    const pts = syntheticTrack({ count: 200, speed: 5, posNoise: 3, seed: 61 });
    // Point aberrant : 400 m en une seconde, soit 1440 km/h.
    pts[100] = { ...pts[100], lat: pts[100].lat + 0.0036 };
    const { metrics } = computeTrack(pts);
    expect(metrics.maxSpeed).toBeLessThan(12);
  });

  it('reste cohérent sans altitude', () => {
    const pts = syntheticTrack({ count: 100, speed: 5 }).map((p) => ({ ...p, ele: null }));
    const { metrics } = computeTrack(pts);
    expect(metrics.ascent).toBe(0);
    expect(metrics.minEle).toBeNull();
    expect(metrics.distance).toBeGreaterThan(400);
  });

  it('renvoie des métriques nulles sur une entrée vide', () => {
    const { metrics, points } = computeTrack([]);
    expect(points).toEqual([]);
    expect(metrics.distance).toBe(0);
    expect(metrics.avgSpeed).toBe(0);
  });
});

describe('scaleElevationWindows', () => {
  it('laisse les fenêtres inchangees à 1 Hz', () => {
    const pts = syntheticTrack({ count: 50, interval: 1 });
    expect(scaleElevationWindows(pts, {})).toEqual({ medianWindow: 5, smoothWindow: 15, threshold: 7 });
  });

  it('rétrécit les fenêtres quand l échantillonnage est lent', () => {
    const pts = syntheticTrack({ count: 50, interval: 5 });
    const w = scaleElevationWindows(pts, {});
    expect(w.smoothWindow).toBe(3);
    expect(w.medianWindow).toBe(1);
  });

  it('respecte une fenêtre imposee explicitement', () => {
    const pts = syntheticTrack({ count: 50, interval: 5 });
    expect(scaleElevationWindows(pts, { smoothWindow: 21 }).smoothWindow).toBe(21);
  });
});

describe('computeSplits', () => {
  it('découpe par kilomètre et boucle sur la distance totale', () => {
    const pts = syntheticTrack({ count: 1000, speed: 5, posNoise: 2, seed: 71 });
    const track = computeTrack(pts);
    const splits = computeSplits(track, 1000);

    expect(splits.length).toBeGreaterThanOrEqual(4);
    const total = splits.reduce((s, x) => s + x.distance, 0);
    expect(total).toBeCloseTo(track.metrics.distance, 0);
    // Tous les segments pleins font 1 km, seul le dernier peut être partiel.
    for (const s of splits.slice(0, -1)) expect(s.distance).toBeCloseTo(1000, 0);
    expect(splits[0].speed).toBeGreaterThan(4);
  });

  it('ne renvoie rien sur une trace trop courte', () => {
    expect(computeSplits(computeTrack(syntheticTrack({ count: 1 })))).toEqual([]);
  });
});

describe('computeSegments', () => {
  it('ignore le déplacement effectue pendant une pause', () => {
    // Cas de la navette : on descend, on met en pause, on remonte 5 km en
    // voiture, on repart. Les 5 km ne doivent pas être comptes.
    const run1 = syntheticTrack({ count: 200, speed: 5, posNoise: 2, seed: 81 });
    const shuttleAway = { lat: 45.05, lon: 3.02 };
    const run2 = syntheticTrack({ count: 200, speed: 5, posNoise: 2, seed: 82 }).map((p, i) => ({
      ...p,
      lat: shuttleAway.lat + (p.lat - 45),
      lon: shuttleAway.lon + (p.lon - 3),
      t: run1[run1.length - 1].t + 900_000 + i * 1000,
    }));

    const merged = computeTrack([...run1, ...run2]);
    const split = computeSegments([run1, run2]);

    // En concatenant naïvement, le déplacement de la navette est facture.
    expect(merged.metrics.distance).toBeGreaterThan(split.metrics.distance + 4000);
    expect(split.metrics.distance).toBeCloseTo(2 * 5 * 199, -2);
  });

  it('ne compte pas la durée de la pause', () => {
    const a = syntheticTrack({ count: 100, speed: 5, seed: 83 });
    const b = syntheticTrack({ count: 100, speed: 5, seed: 84 }).map((p, i) => ({
      ...p,
      t: a[a.length - 1].t + 600_000 + i * 1000,
    }));
    const split = computeSegments([a, b]);
    expect(split.metrics.duration).toBeLessThan(210_000);
    expect(split.segmentStarts).toEqual([0, 100]);
  });

  it('somme les dénivelés des tronçons', () => {
    const a = syntheticTrack({ count: 300, speed: 5, elevationGain: 100, eleNoise: 2, seed: 85 });
    const b = syntheticTrack({ count: 300, speed: 5, elevationGain: 100, eleNoise: 2, seed: 86 }).map((p, i) => ({
      ...p,
      t: a[a.length - 1].t + 600_000 + i * 1000,
    }));
    expect(computeSegments([a, b]).metrics.ascent).toBeGreaterThan(170);
  });

  it('se comporte comme computeTrack sur un seul tronçon', () => {
    const a = syntheticTrack({ count: 100, speed: 5, seed: 87 });
    expect(computeSegments([a]).metrics).toEqual(computeTrack(a).metrics);
  });

  it('tolère des tronçons vides', () => {
    expect(computeSegments([[], []]).metrics.distance).toBe(0);
  });

  it('ne facture pas la pause au kilomètre a cheval sur elle', () => {
    const a = syntheticTrack({ count: 300, speed: 5, seed: 88 });
    const b = syntheticTrack({ count: 300, speed: 5, seed: 89 }).map((p, i) => ({
      ...p,
      t: a[a.length - 1].t + 1_800_000 + i * 1000,
    }));
    const splits = computeSplits(computeSegments([a, b]), 1000);
    for (const s of splits) expect(s.speed).toBeGreaterThan(3);
  });
});

describe('cohérence entre le total et les tranches', () => {
  it('fait correspondre la somme des D+ par kilomètre au D+ total', () => {
    // Un utilisateur additionne les colonnes du tableau : l'écart se voit
    // immédiatement si les deux chiffres sont calculés séparément.
    const pts = syntheticTrack({ count: 1500, speed: 5, elevationGain: 400, eleNoise: 6, seed: 91 });
    const track = computeTrack(pts);
    const splits = computeSplits(track, 1000);

    const sumAscent = splits.reduce((a, s) => a + s.ascent, 0);
    const sumDescent = splits.reduce((a, s) => a + s.descent, 0);
    expect(sumAscent).toBeCloseTo(track.metrics.ascent, 6);
    expect(sumDescent).toBeCloseTo(track.metrics.descent, 6);
  });

  it('reste cohérent sur un parcours accidenté', () => {
    const rough = syntheticTrack({ count: 2000, speed: 5, eleNoise: 4, seed: 92 }).map((p, i) => ({
      ...p,
      ele: 800 + 40 * Math.sin(i / 90) + (p.ele! - 200),
    }));
    const track = computeTrack(rough);
    const splits = computeSplits(track, 1000);
    expect(splits.reduce((a, s) => a + s.ascent, 0)).toBeCloseTo(track.metrics.ascent, 6);
  });

  it('conserve la correspondance après une pause', () => {
    const a = syntheticTrack({ count: 800, speed: 5, elevationGain: 150, eleNoise: 4, seed: 93 });
    const b = syntheticTrack({ count: 800, speed: 5, elevationGain: 150, eleNoise: 4, seed: 94 }).map((p, i) => ({
      ...p,
      t: a[a.length - 1].t + 900_000 + i * 1000,
    }));
    const track = computeSegments([a, b]);
    const splits = computeSplits(track, 1000);
    expect(splits.reduce((s, x) => s + x.ascent, 0)).toBeCloseTo(track.metrics.ascent, 6);
  });
});
