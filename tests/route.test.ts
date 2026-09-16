import { describe, expect, it } from 'vitest';
import { RouteFollower, distanceToNextTurn } from '../src/core/follow';
import { pathLength } from '../src/core/geo';
import { buildRoute, densify } from '../src/core/route';
import { simplify } from '../src/core/simplify';
import type { RoutePoint } from '../src/core/types';
import { M_PER_DEG_LAT } from './helpers';

/** Ligne droite plein nord de `n` points espaces de `step` metres. */
function straight(n: number, step: number, gain = 0): RoutePoint[] {
  return Array.from({ length: n }, (_, i) => ({
    lat: 45 + (i * step) / M_PER_DEG_LAT,
    lon: 3,
    ele: 200 + (gain * i) / Math.max(1, n - 1),
  }));
}

describe('simplify', () => {
  it('reduit une ligne droite a ses deux extremites', () => {
    expect(simplify(straight(100, 10), 5)).toHaveLength(2);
  });

  it('conserve un angle marque', () => {
    const pts = [
      { lat: 45, lon: 3 },
      { lat: 45.01, lon: 3 },
      { lat: 45.01, lon: 3.01 },
    ];
    expect(simplify(pts, 5)).toHaveLength(3);
  });

  it('ne modifie pas une trace de moins de trois points', () => {
    const pts = [{ lat: 45, lon: 3 }];
    expect(simplify(pts)).toEqual(pts);
  });

  it('allege fortement une trace bruitee en preservant sa longueur', () => {
    const pts = straight(2000, 5).map((p, i) => ({ ...p, lon: 3 + Math.sin(i / 7) * 0.00002 }));
    const out = simplify(pts, 10);
    expect(out.length).toBeLessThan(pts.length / 10);
    expect(pathLength(out)).toBeCloseTo(pathLength(pts), -2);
  });
});

describe('densify', () => {
  it('insere des points intermediaires sous le pas demande', () => {
    const out = densify([{ lat: 45, lon: 3, ele: 100 }, { lat: 45.009, lon: 3, ele: 200 }], 25);
    expect(out.length).toBeGreaterThan(38);
    for (let i = 1; i < out.length; i++) {
      expect(out[i].lat).toBeGreaterThan(out[i - 1].lat);
    }
  });

  it('interpole l altitude lineairement', () => {
    const out = densify([{ lat: 45, lon: 3, ele: 100 }, { lat: 45.0018, lon: 3, ele: 300 }], 25);
    const mid = out[Math.floor(out.length / 2)];
    expect(mid.ele).toBeGreaterThan(150);
    expect(mid.ele).toBeLessThan(250);
  });

  it('laisse l altitude nulle si une extremite est inconnue', () => {
    const out = densify([{ lat: 45, lon: 3, ele: null }, { lat: 45.002, lon: 3, ele: 300 }], 25);
    expect(out[1].ele).toBeNull();
  });
});

describe('buildRoute', () => {
  it('calcule distance et denivele', () => {
    const r = buildRoute('Montee test', straight(100, 20, 200), 'r1');
    expect(r.distance).toBeCloseTo(1980, 0);
    expect(r.ascent).toBeGreaterThan(190);
    expect(r.descent).toBeLessThan(5);
    expect(r.cumDist).toHaveLength(100);
  });

  it('detecte une boucle', () => {
    const half = straight(50, 20);
    const loop = [...half, ...[...half].reverse().slice(1)];
    expect(buildRoute('Boucle', loop, 'r2').loop).toBe(true);
  });

  it('ne declare pas boucle un aller simple', () => {
    expect(buildRoute('Aller', straight(50, 20), 'r3').loop).toBe(false);
  });
});

describe('RouteFollower', () => {
  const route = buildRoute('Ligne', straight(200, 10, 400), 'r4');

  it('suit la progression et decompte la distance restante', () => {
    const f = new RouteFollower(route);
    const s = f.update({ lat: route.points[100].lat, lon: 3 });
    expect(s.distanceAlong).toBeCloseTo(1000, 0);
    expect(s.distanceRemaining).toBeCloseTo(990, 0);
    expect(s.progress).toBeCloseTo(0.5, 2);
    expect(s.onRoute).toBe(true);
  });

  it('decompte le denivele restant', () => {
    const f = new RouteFollower(route);
    expect(f.update({ lat: route.points[0].lat, lon: 3 }).ascentRemaining).toBeCloseTo(400, 0);
    expect(f.update({ lat: route.points[199].lat, lon: 3 }).ascentRemaining).toBeCloseTo(0, 0);
  });

  it('signale une sortie de trace', () => {
    const f = new RouteFollower(route, { offRouteThreshold: 40 });
    const s = f.update({ lat: route.points[50].lat, lon: 3.002 });
    expect(s.onRoute).toBe(false);
    expect(s.deviation).toBeGreaterThan(100);
  });

  it('ne saute pas au retour sur un aller-retour', () => {
    // Piege classique : a mi-parcours du retour, le point le plus proche dans
    // l'absolu appartient a l'aller. Sans fenetre de recherche, la progression
    // reculerait brutalement et l'arrivee ne serait jamais atteinte.
    const out = straight(100, 10);
    const back = [...out].reverse().slice(1);
    const ar = buildRoute('Aller-retour', [...out, ...back], 'r5');
    const f = new RouteFollower(ar);

    let last = 0;
    for (const p of ar.points) {
      const s = f.update({ lat: p.lat, lon: p.lon });
      expect(s.distanceAlong).toBeGreaterThanOrEqual(last - 1);
      last = s.distanceAlong;
    }
    expect(last).toBeCloseTo(ar.distance, 0);
  });

  it('detecte un demi-tour', () => {
    const f = new RouteFollower(route);
    f.update({ lat: route.points[100].lat, lon: 3 });
    expect(f.update({ lat: route.points[90].lat, lon: 3 }).wrongWay).toBe(true);
  });

  it('ne signale pas un demi-tour sur une oscillation a l arret', () => {
    const f = new RouteFollower(route);
    f.update({ lat: route.points[100].lat, lon: 3 });
    expect(f.update({ lat: route.points[100].lat - 0.00005, lon: 3 }).wrongWay).toBe(false);
  });

  it('se recale apres une sortie de trace prolongee', () => {
    const f = new RouteFollower(route);
    f.update({ lat: route.points[10].lat, lon: 3 });
    f.update({ lat: route.points[10].lat, lon: 3.02 });
    const back = f.update({ lat: route.points[180].lat, lon: 3 });
    expect(back.onRoute).toBe(true);
    expect(back.distanceAlong).toBeCloseTo(1800, 0);
  });

  it('tolere un circuit reduit a un point', () => {
    const s = new RouteFollower(buildRoute('Point', [{ lat: 45, lon: 3, ele: null }], 'r6')).update({ lat: 45, lon: 3 });
    expect(s.distanceRemaining).toBe(0);
  });
});

describe('distanceToNextTurn', () => {
  it('trouve le prochain virage marque', () => {
    const pts: RoutePoint[] = [
      ...straight(20, 10),
      ...Array.from({ length: 20 }, (_, i) => ({
        lat: 45 + (19 * 10) / M_PER_DEG_LAT,
        lon: 3 + ((i + 1) * 10) / (M_PER_DEG_LAT * Math.cos((45 * Math.PI) / 180)),
        ele: 200,
      })),
    ];
    const r = buildRoute('Coude', pts, 'r7');
    const d = distanceToNextTurn(r, 0);
    expect(d).toBeCloseTo(190, 0);
  });

  it('renvoie null sur une ligne droite', () => {
    expect(distanceToNextTurn(buildRoute('Droite', straight(50, 10), 'r8'), 0)).toBeNull();
  });
});
