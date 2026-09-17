import { EARTH_RADIUS } from '../src/core/geo';
import type { TrackPoint } from '../src/core/types';

/**
 * Mètres par degré sur la sphère de référence utilisée par `geo.ts`.
 *
 * Il est essentiel de partager cette constante avec le code teste : une
 * approximation différente (111 132 m au lieu de 111 195) introduirait un
 * écart de 0,06 % qu'on prendrait à tort pour un défaut de l'algorithme.
 */
export const M_PER_DEG_LAT = (EARTH_RADIUS * Math.PI) / 180;

/** Générateur pseudo-aléatoire déterministe (mulberry32), pour des tests reproductibles. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bruit uniforme dans [-amplitude, +amplitude]. */
export function noise(rand: () => number, amplitude: number): number {
  return (rand() - 0.5) * 2 * amplitude;
}

export interface SyntheticOptions {
  /** Nombre de points. */
  count: number;
  /** Intervalle entre deux points, en secondes. */
  interval?: number;
  /** Vitesse de déplacement, en m/s. */
  speed?: number;
  /** Altitude au départ, en mètres. */
  startEle?: number;
  /** Dénivelé total a répartir linéairement, en mètres. */
  elevationGain?: number;
  /** Amplitude du bruit d'altitude, en mètres. */
  eleNoise?: number;
  /** Amplitude du bruit de position, en mètres. */
  posNoise?: number;
  /** Précision annoncée, en mètres. */
  accuracy?: number;
  seed?: number;
}

/**
 * Fabrique une trace synthétique : trajet plein nord a vitesse constante,
 * avec bruit contrôle sur la position et l'altitude.
 */
export function syntheticTrack(opts: SyntheticOptions): TrackPoint[] {
  const {
    count,
    interval = 1,
    speed = 5,
    startEle = 200,
    elevationGain = 0,
    eleNoise = 0,
    posNoise = 0,
    accuracy = 5,
    seed = 42,
  } = opts;
  const rand = rng(seed);
  const t0 = Date.UTC(2026, 3, 12, 8, 0, 0);
  const mPerDegLat = M_PER_DEG_LAT;
  const out: TrackPoint[] = [];
  for (let i = 0; i < count; i++) {
    const travelled = speed * interval * i;
    out.push({
      lat: 45 + (travelled + noise(rand, posNoise)) / mPerDegLat,
      lon: 3 + noise(rand, posNoise) / (M_PER_DEG_LAT * Math.cos((45 * Math.PI) / 180)),
      ele: startEle + (elevationGain * i) / Math.max(1, count - 1) + noise(rand, eleNoise),
      t: t0 + i * interval * 1000,
      acc: accuracy,
    });
  }
  return out;
}

/** Somme naïve des deltas positifs : la méthode incorrecte, gardée comme témoin. */
export function naiveAscent(eles: number[]): number {
  let sum = 0;
  for (let i = 1; i < eles.length; i++) {
    const d = eles[i] - eles[i - 1];
    if (d > 0) sum += d;
  }
  return sum;
}
