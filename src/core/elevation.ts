import type { RoutePoint } from './types';

/**
 * Résolution d'altitude pour les circuits traces à la main.
 *
 * Un circuit dessiné sur la carte n'a aucune altitude : il faut interroger un
 * modèle numérique de terrain. Le service public par défaut est limite en
 * debit (voir `PROVIDERS`), donc on met en cache, on regroupe les requêtes par
 * lots et on échantillonne : interroger le DEM tous les 25 m n'apporte rien,
 * la résolution du SRTM étant de 30 m.
 */

export interface ElevationProvider {
  name: string;
  /** Nombre maximal de coordonnées par requête. */
  batchSize: number;
  /** Délai minimal entre deux requêtes, en ms. */
  minInterval: number;
  buildUrl(batch: Array<{ lat: number; lon: number }>): string;
  parse(json: unknown): Array<number | null>;
}

export const PROVIDERS: Record<string, ElevationProvider> = {
  /** SRTM 30 m. API publique plafonnee a 1000 appels/jour et 1 appel/s. */
  opentopodata: {
    name: 'OpenTopoData (SRTM 30m)',
    batchSize: 100,
    minInterval: 1100,
    buildUrl(batch) {
      const locs = batch.map((p) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`).join('|');
      return `https://api.opentopodata.org/v1/srtm30m?locations=${encodeURIComponent(locs)}`;
    },
    parse(json) {
      const results = (json as { results?: Array<{ elevation: number | null }> }).results ?? [];
      return results.map((r) => (typeof r.elevation === 'number' ? r.elevation : null));
    },
  },
  open_elevation: {
    name: 'Open-Élévation',
    batchSize: 100,
    minInterval: 500,
    buildUrl(batch) {
      const locs = batch.map((p) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`).join('|');
      return `https://api.open-élévation.com/api/v1/lookup?locations=${encodeURIComponent(locs)}`;
    },
    parse(json) {
      const results = (json as { results?: Array<{ elevation: number | null }> }).results ?? [];
      return results.map((r) => (typeof r.elevation === 'number' ? r.elevation : null));
    },
  },
};

/** Clé de cache : ~11 m de résolution, en phase avec celle du DEM. */
function cacheKey(lat: number, lon: number): string {
  return `${lat.toFixed(4)},${lon.toFixed(4)}`;
}

const memoryCache = new Map<string, number>();

export interface LookupOptions {
  provider?: ElevationProvider;
  /** Un point sur `sampleEvery` est interrogé, les autres sont interpolés. */
  sampleEvery?: number;
  signal?: AbortSignal;
  /** Progression dans [0, 1], appelée après chaque lot. */
  onProgress?: (done: number, total: number) => void;
}

/**
 * Complète les altitudes manquantes d'une liste de points.
 *
 * Renvoie une nouvelle liste ; en cas d'échec réseau les points concernés
 * gardent `ele: null` plutôt que de propager une valeur inventée — un
 * dénivelé faux est pire qu'un dénivelé absent.
 */
export async function fillElevations(
  points: RoutePoint[],
  opts: LookupOptions = {},
): Promise<RoutePoint[]> {
  const provider = opts.provider ?? PROVIDERS.opentopodata;
  const sampleEvery = Math.max(1, opts.sampleEvery ?? 4);

  const sampleIdx: number[] = [];
  for (let i = 0; i < points.length; i += sampleEvery) sampleIdx.push(i);
  const lastIdx = points.length - 1;
  if (lastIdx >= 0 && sampleIdx[sampleIdx.length - 1] !== lastIdx) sampleIdx.push(lastIdx);

  const missing = sampleIdx.filter((i) => !memoryCache.has(cacheKey(points[i].lat, points[i].lon)));

  for (let start = 0; start < missing.length; start += provider.batchSize) {
    if (opts.signal?.aborted) break;
    const slice = missing.slice(start, start + provider.batchSize);
    const batch = slice.map((i) => ({ lat: points[i].lat, lon: points[i].lon }));
    try {
      const res = await fetch(provider.buildUrl(batch), { signal: opts.signal });
      if (!res.ok) throw new Error(`${provider.name}: HTTP ${res.status}`);
      const values = provider.parse(await res.json());
      slice.forEach((idx, k) => {
        const v = values[k];
        if (v != null && Number.isFinite(v)) memoryCache.set(cacheKey(points[idx].lat, points[idx].lon), v);
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') break;
      console.warn('Altitude indisponible pour un lot', err);
    }
    opts.onProgress?.(Math.min(start + provider.batchSize, missing.length), missing.length);
    if (start + provider.batchSize < missing.length) {
      await new Promise((r) => setTimeout(r, provider.minInterval));
    }
  }

  // Les points échantillonnés prennent la valeur du DEM, les autres sont
  // interpolés linéairement entre leurs deux voisins échantillonnés.
  const out = points.map((p) => ({ ...p }));
  const known: Array<[number, number]> = [];
  for (const i of sampleIdx) {
    const v = memoryCache.get(cacheKey(points[i].lat, points[i].lon));
    if (v != null) {
      out[i].ele = v;
      known.push([i, v]);
    }
  }
  for (let k = 1; k < known.length; k++) {
    const [i0, v0] = known[k - 1];
    const [i1, v1] = known[k];
    for (let i = i0 + 1; i < i1; i++) {
      out[i].ele = v0 + ((v1 - v0) * (i - i0)) / (i1 - i0);
    }
  }
  return out;
}

/** Vide le cache mémoire des altitudes (tests, changement de fournisseur). */
export function clearElevationCache(): void {
  memoryCache.clear();
}
