import type { Route, Track } from './types';

/**
 * Stockage local via IndexedDB.
 *
 * On evite `localStorage` : une sortie de trois heures a 1 Hz represente
 * environ 10 000 points, soit plusieurs mega-octets, bien au-dela du quota de
 * 5 Mo et surtout serialisee de facon synchrone, ce qui figerait l'interface
 * pendant l'enregistrement.
 */

const DB_NAME = 'vtt-app';
const DB_VERSION = 1;
const STORE_TRACKS = 'tracks';
const STORE_ROUTES = 'routes';
/** Sauvegarde de secours de l'enregistrement en cours, en cas de crash. */
const STORE_STATE = 'state';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_TRACKS)) {
        db.createObjectStore(STORE_TRACKS, { keyPath: 'id' }).createIndex('startedAt', 'startedAt');
      }
      if (!db.objectStoreNames.contains(STORE_ROUTES)) {
        db.createObjectStore(STORE_ROUTES, { keyPath: 'id' }).createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains(STORE_STATE)) {
        db.createObjectStore(STORE_STATE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export const trackStore = {
  put: (track: Track) => tx(STORE_TRACKS, 'readwrite', (s) => s.put(track)),
  get: (id: string) => tx<Track | undefined>(STORE_TRACKS, 'readonly', (s) => s.get(id)),
  remove: (id: string) => tx(STORE_TRACKS, 'readwrite', (s) => s.delete(id)),
  all: async (): Promise<Track[]> => {
    const list = await tx<Track[]>(STORE_TRACKS, 'readonly', (s) => s.getAll());
    return list.sort((a, b) => b.startedAt - a.startedAt);
  },
};

export const routeStore = {
  put: (route: Route) => tx(STORE_ROUTES, 'readwrite', (s) => s.put(route)),
  get: (id: string) => tx<Route | undefined>(STORE_ROUTES, 'readonly', (s) => s.get(id)),
  remove: (id: string) => tx(STORE_ROUTES, 'readwrite', (s) => s.delete(id)),
  all: async (): Promise<Route[]> => {
    const list = await tx<Route[]>(STORE_ROUTES, 'readonly', (s) => s.getAll());
    return list.sort((a, b) => b.createdAt - a.createdAt);
  },
};

/** Sauvegarde/reprise de l'enregistrement en cours apres fermeture accidentelle. */
export const draftStore = {
  save: (value: unknown) => tx(STORE_STATE, 'readwrite', (s) => s.put(value, 'draft')),
  load: <T>() => tx<T | undefined>(STORE_STATE, 'readonly', (s) => s.get('draft')),
  clear: () => tx(STORE_STATE, 'readwrite', (s) => s.delete('draft')),
};

/** Espace disque utilise et quota accorde par le navigateur, en octets. */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null;
  const e = await navigator.storage.estimate();
  return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
}
