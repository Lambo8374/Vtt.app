/*
 * Service worker : coquille applicative et cache de tuiles.
 *
 * Le hors-ligne n'est pas un confort ici. Un circuit VTT se roule le plus
 * souvent sans réseau : sans cache, la carte serait grise exactement la ou on
 * en a besoin.
 *
 * Les tuiles proviennent de services communautaires dont les conditions
 * d'usage interdisent le téléchargement en masse. On ne met donc en cache que
 * les tuiles réellement affichées, et le cache est plafonné.
 */

const SHELL_CACHE = 'vtt-shell-v1';
const TILE_CACHE = 'vtt-tiles-v1';

/** Plafond du cache de tuiles : environ 40 a 60 Mo selon les fonds. */
const MAX_TILES = 3000;

const TILE_HOSTS = [
  'tile.openstreetmap.org',
  'tile.opentopomap.org',
  'tile-cyclosm.openstreetmap.fr',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(['./', './index.html', './manifest.webmanifest'])),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== TILE_CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (TILE_HOSTS.some((h) => url.hostname.endsWith(h))) {
    event.respondWith(tileStrategy(request));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(shellStrategy(request));
  }
});

/**
 * Tuiles : cache d'abord.
 *
 * Une tuile de carte ne change pratiquement jamais ; la servir depuis le cache
 * économise la batterie et le forfait, et c'est ce qui rend la carte utilisable
 * sans réseau.
 */
async function tileStrategy(request) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  try {
    const res = await fetch(request);
    if (res.ok) {
      await cache.put(request, res.clone());
      void trimTiles(cache);
    }
    return res;
  } catch {
    // Hors ligne et tuile absente : Leaflet affichera une case vide, ce qui
    // vaut mieux qu'une erreur remontant dans la console a chaque déplacement.
    return new Response('', { status: 504, statusText: 'Tuile indisponible hors ligne' });
  }
}

/**
 * Coquille applicative : réseau d'abord, repli sur le cache.
 *
 * L'inverse servirait indefiniment une version obsolète après un déploiement.
 */
async function shellStrategy(request) {
  try {
    const res = await fetch(request);
    if (res.ok) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(request, res.clone());
    }
    return res;
  } catch {
    const hit = await caches.match(request);
    if (hit) return hit;
    // Navigation hors ligne vers une URL non mise en cache : on rend la page
    // d'accueil, l'application étant entièrement cote client.
    if (request.mode === 'navigate') {
      const index = await caches.match('./index.html');
      if (index) return index;
    }
    throw new Error('Ressource indisponible hors ligne');
  }
}

/** Purge les tuiles les plus anciennes au-dela du plafond. */
async function trimTiles(cache) {
  const keys = await cache.keys();
  if (keys.length <= MAX_TILES) return;
  // Les clés sont renvoyées dans l'ordre d'insertion : les premières sont les
  // plus anciennes.
  await Promise.all(keys.slice(0, keys.length - MAX_TILES).map((k) => cache.delete(k)));
}
