import type { RoutePoint } from './types';

/**
 * Calage du tracé sur les chemins existants.
 *
 * Relier deux clics en ligne droite donne un circuit inutilisable : la distance
 * et le dénivelé annoncés n'ont alors rien a voir avec le parcours réel, qui
 * suit des sentiers. On interroge donc BRouter, moteur libre dont les profils
 * couvrent le VTT, et qui renvoie l'altitude dans la troisième coordonnée — ce
 * qui évite en prime un appel séparé au modèle de terrain.
 *
 * Le service est public et sans garantie : chaque appel peut échouer. L'appelant
 * doit toujours pouvoir revenir au segment droit, sans quoi la création de
 * circuit deviendrait impossible hors connexion.
 */

export const PROFILES = {
  'mtb': 'VTT',
  'trekking': 'Randonnee / gravel',
  'fastbike': 'Route',
  'shortest': 'Le plus court',
} as const;

export type ProfileKey = keyof typeof PROFILES;

export class RoutingError extends Error {}

/**
 * Calculé l'itinéraire entre deux points en suivant les chemins.
 *
 * @throws {RoutingError} si le service est injoignable ou ne trouvé pas d'itinéraire.
 */
export async function snapToPaths(
  from: RoutePoint,
  to: RoutePoint,
  profile: ProfileKey = 'mtb',
  signal?: AbortSignal,
): Promise<RoutePoint[]> {
  const lonlats = `${from.lon.toFixed(6)},${from.lat.toFixed(6)}|${to.lon.toFixed(6)},${to.lat.toFixed(6)}`;
  const url =
    `https://brouter.de/brouter?lonlats=${encodeURIComponent(lonlats)}` +
    `&profile=${profile}&alternativeidx=0&format=geojson`;

  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new RoutingError('Service de calcul d’itinéraire injoignable.');
  }
  if (!res.ok) throw new RoutingError(`Le service a repondu ${res.status}.`);

  const geo = (await res.json()) as {
    features?: Array<{ geometry?: { coordinates?: number[][] } }>;
  };
  const coords = geo.features?.[0]?.geometry?.coordinates;
  if (!coords || coords.length < 2) throw new RoutingError('Aucun chemin trouvé entre ces deux points.');

  return coords.map(([lon, lat, ele]) => ({
    lat,
    lon,
    ele: typeof ele === 'number' && Number.isFinite(ele) ? ele : null,
  }));
}
