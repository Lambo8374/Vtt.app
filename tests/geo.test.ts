import { describe, expect, it } from 'vitest';
import { bearing, cumulativeDistances, haversine, pathLength, projectOnSegment } from '../src/core/geo';

describe('haversine', () => {
  it('retrouve la distance Paris - Lyon à moins de 1 %', () => {
    const paris = { lat: 48.8566, lon: 2.3522 };
    const lyon = { lat: 45.764, lon: 4.8357 };
    const d = haversine(paris, lyon);
    expect(d).toBeGreaterThan(388_000);
    expect(d).toBeLessThan(396_000);
  });

  it('est symetrique et nulle sur un point identique', () => {
    const a = { lat: 44.5, lon: 6.1 };
    const b = { lat: 44.51, lon: 6.11 };
    expect(haversine(a, b)).toBeCloseTo(haversine(b, a), 9);
    expect(haversine(a, a)).toBe(0);
  });

  it('mesure un degré de latitude a environ 111 km', () => {
    expect(haversine({ lat: 45, lon: 3 }, { lat: 46, lon: 3 })).toBeCloseTo(111_195, -2);
  });
});

describe('bearing', () => {
  it('donne 0 vers le nord', () => {
    expect(bearing({ lat: 45, lon: 3 }, { lat: 46, lon: 3 })).toBeCloseTo(0, 5);
  });

  it('donne 90 vers l est sur un pas court', () => {
    expect(bearing({ lat: 45, lon: 3 }, { lat: 45, lon: 3.001 })).toBeCloseTo(90, 2);
  });

  it('incline le cap initial vers le pôle sur un long trajet est-ouest', () => {
    // Une orthodromie plein est s'incurve vers le pôle : son cap initial est
    // inférieur a 90 degrés. Ce n'est pas une erreur de calcul.
    const b = bearing({ lat: 45, lon: 3 }, { lat: 45, lon: 4 });
    expect(b).toBeLessThan(90);
    expect(b).toBeGreaterThan(89.5);
  });
});

describe('projectOnSegment', () => {
  const a = { lat: 45.0, lon: 3.0 };
  const b = { lat: 45.0, lon: 3.01 };

  it('projette au milieu du segment', () => {
    const r = projectOnSegment({ lat: 45.001, lon: 3.005 }, a, b);
    expect(r.t).toBeCloseTo(0.5, 2);
    expect(r.distance).toBeGreaterThan(100);
    expect(r.distance).toBeLessThan(120);
  });

  it('borne la projection aux extrémités', () => {
    expect(projectOnSegment({ lat: 45, lon: 2.9 }, a, b).t).toBe(0);
    expect(projectOnSegment({ lat: 45, lon: 3.1 }, a, b).t).toBe(1);
  });
});

describe('cumulativeDistances', () => {
  it('commence à zéro et finit sur la longueur totale', () => {
    const pts = [
      { lat: 45, lon: 3 },
      { lat: 45.001, lon: 3 },
      { lat: 45.002, lon: 3 },
    ];
    const cum = cumulativeDistances(pts);
    expect(cum[0]).toBe(0);
    expect(cum[2]).toBeCloseTo(pathLength(pts), 6);
    expect(cum[1]).toBeCloseTo(cum[2] / 2, 1);
  });
});
