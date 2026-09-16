import { describe, expect, it } from 'vitest';
import { cleanPoints, elevationProfile, freezeStops, kalmanSmooth, medianFilter, movingAverage } from '../src/core/filters';
import { pathLength } from '../src/core/geo';
import { naiveAscent, noise, rng, syntheticTrack } from './helpers';

describe('medianFilter', () => {
  it('supprime un pic isole sans deplacer les voisins', () => {
    const out = medianFilter([100, 100, 180, 100, 100], 3);
    expect(out[2]).toBe(100);
    expect(out[1]).toBe(100);
  });

  it('preserve une marche reelle', () => {
    const out = medianFilter([100, 100, 100, 200, 200, 200], 3);
    expect(out[0]).toBe(100);
    expect(out[5]).toBe(200);
  });
});

describe('movingAverage', () => {
  it('conserve la moyenne globale sur une serie constante', () => {
    expect(movingAverage([5, 5, 5, 5], 3)).toEqual([5, 5, 5, 5]);
  });
});

describe('elevationProfile', () => {
  it('annule le denivele fantome sur un parcours plat bruite', () => {
    const rand = rng(7);
    const eles = Array.from({ length: 3600 }, () => 200 + noise(rand, 8));

    // Temoin : la methode naive fabrique des centaines de metres inexistants.
    expect(naiveAscent(eles)).toBeGreaterThan(5000);

    const { ascent, descent } = elevationProfile(eles);
    expect(ascent).toBeLessThan(60);
    expect(descent).toBeLessThan(60);
  });

  it('retrouve une montee reelle malgre le bruit', () => {
    const rand = rng(11);
    const eles = Array.from({ length: 1200 }, (_, i) => 200 + (i * 400) / 1199 + noise(rand, 8));
    const { ascent, descent } = elevationProfile(eles);
    expect(ascent).toBeGreaterThan(380);
    expect(ascent).toBeLessThan(430);
    expect(descent).toBeLessThan(25);
  });

  it('equilibre montee et descente sur un aller-retour', () => {
    const up = Array.from({ length: 600 }, (_, i) => 200 + (i * 300) / 599);
    const down = [...up].reverse();
    const { ascent, descent } = elevationProfile([...up, ...down]);
    expect(ascent).toBeCloseTo(descent, 0);
    expect(ascent).toBeGreaterThan(290);
  });

  it('repartit la distance entre montee et descente', () => {
    const eles = [...Array.from({ length: 100 }, (_, i) => i), ...Array.from({ length: 100 }, (_, i) => 99 - i)];
    const cum = eles.map((_, i) => i * 10);
    const prof = elevationProfile(eles, { threshold: 1 }, cum);
    expect(prof.ascentDistance).toBeGreaterThan(800);
    expect(prof.descentDistance).toBeGreaterThan(800);
  });

  it('renvoie un profil vide sans altitude', () => {
    expect(elevationProfile([])).toEqual({ smoothed: [], ascent: 0, descent: 0, ascentDistance: 0, descentDistance: 0 });
  });
});

describe('cleanPoints', () => {

  it('rejette les points trop imprecis', () => {
    const pts = syntheticTrack({ count: 10 });
    pts[5].acc = 120;
    expect(cleanPoints(pts)).toHaveLength(9);
  });

  it('rejette un saut a vitesse impossible', () => {
    const pts = syntheticTrack({ count: 10, speed: 5 });
    pts[5] = { ...pts[5], lat: 46.5 };
    const cleaned = cleanPoints(pts);
    expect(cleaned.some((p) => p.lat > 46)).toBe(false);
  });
});

describe('freezeStops', () => {
  it('annule la derive de distance a l arret', () => {
    // Recepteur immobile pendant 10 minutes avec 6 m de bruit : sans traitement
    // la trace "parcourt" plusieurs kilometres sans bouger.
    const still = syntheticTrack({ count: 600, speed: 0, posNoise: 6, seed: 3 });
    expect(pathLength(still)).toBeGreaterThan(2000);
    expect(pathLength(freezeStops(kalmanSmooth(cleanPoints(still))))).toBeLessThan(20);
  });

  it('ne fige pas un deplacement reel', () => {
    const riding = syntheticTrack({ count: 300, speed: 5, posNoise: 4, accuracy: 5, seed: 9 });
    const frozen = freezeStops(kalmanSmooth(cleanPoints(riding)));
    const truth = 5 * 299;
    expect(pathLength(frozen)).toBeGreaterThan(truth * 0.9);
  });

  it('isole une pause au milieu d une sortie', () => {
    const before = syntheticTrack({ count: 200, speed: 5, posNoise: 4, seed: 21 });
    const lastPt = before[before.length - 1];
    const pause = syntheticTrack({ count: 300, speed: 0, posNoise: 6, seed: 22 }).map((p, i) => ({
      ...p,
      lat: lastPt.lat + (p.lat - 45),
      lon: lastPt.lon + (p.lon - 3),
      t: lastPt.t + (i + 1) * 1000,
    }));
    const merged = [...before, ...pause];
    const frozen = freezeStops(kalmanSmooth(cleanPoints(merged)));
    const pauseLength = pathLength(frozen.slice(before.length + 20));
    expect(pauseLength).toBeLessThan(20);
  });
});

describe('kalmanSmooth', () => {
  it('reduit le bruit de position sans raccourcir le trajet reel', () => {
    const noisy = syntheticTrack({ count: 300, speed: 5, posNoise: 7, accuracy: 7, seed: 5 });
    const cleanLen = pathLength(cleanPoints(noisy));
    const smoothLen = pathLength(kalmanSmooth(cleanPoints(noisy)));
    const truth = 5 * 299;
    expect(Math.abs(smoothLen - truth)).toBeLessThan(Math.abs(cleanLen - truth));
  });

  it('laisse passer une trace deja propre', () => {
    const clean = syntheticTrack({ count: 100, speed: 5, posNoise: 0, accuracy: 3 });
    const out = kalmanSmooth(clean);
    expect(pathLength(out)).toBeCloseTo(pathLength(clean), -1);
  });
});
