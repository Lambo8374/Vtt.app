import { useCallback, useMemo, useRef, useState } from 'react';
import { ElevationChart } from '../components/ElevationChart';
import { BASEMAPS, MapView } from '../components/MapView';
import type { BasemapKey } from '../components/MapView';
import { Tile } from '../components/Stats';
import { routeStore } from '../core/db';
import { fillElevations } from '../core/elevation';
import { formatDistance, formatElevation, formatGrade } from '../core/format';
import type { LatLon } from '../core/geo';
import { buildRoute, densify } from '../core/route';
import { PROFILES, RoutingError, snapToPaths } from '../core/routing';
import type { ProfileKey } from '../core/routing';
import { simplify } from '../core/simplify';
import type { Route, RoutePoint } from '../core/types';

export interface RouteEditorProps {
  basemap: BasemapKey;
  onBasemapChange: (k: BasemapKey) => void;
  onSaved: () => void;
  /** Circuit ouvert en modification, ou null pour en créer un nouveau. */
  editing: Route | null;
  onCancelEdit: () => void;
}

/** Un tronçon relie deux sommets : soit calé sur les chemins, soit en ligne droite. */
interface Leg {
  vertex: RoutePoint;
  path: RoutePoint[];
  snapped: boolean;
}

export function RouteEditorScreen({ basemap, onBasemapChange, onSaved, editing, onCancelEdit }: RouteEditorProps) {
  const [legs, setLegs] = useState<Leg[]>(() =>
    editing
      ? // Le sommet d'un tronçon est son extrémité : en reprenant un circuit,
        // c'est son dernier point, sans quoi le point suivant repartirait du
        // départ au lieu de prolonger le tracé.
        [{ vertex: editing.points[editing.points.length - 1], path: editing.points, snapped: false }]
      : [],
  );
  const [name, setName] = useState(editing?.name ?? '');
  const [profile, setProfile] = useState<ProfileKey>('mtb');
  const [snap, setSnap] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const points = useMemo(() => legs.flatMap((l, i) => (i === 0 ? l.path : l.path.slice(1))), [legs]);
  const vertices = useMemo(() => legs.map((l) => l.vertex), [legs]);
  const route = useMemo(() => (points.length >= 2 ? buildRoute(name || 'Circuit', points, 'preview') : null), [points, name]);
  const hasElevation = useMemo(() => points.some((p) => p.ele != null), [points]);

  const addPoint = useCallback(
    async (p: LatLon) => {
      const vertex: RoutePoint = { lat: p.lat, lon: p.lon, ele: null };
      if (legs.length === 0) {
        setLegs([{ vertex, path: [vertex], snapped: false }]);
        return;
      }
      const from = legs[legs.length - 1].vertex;

      if (!snap) {
        setLegs((prev) => [...prev, { vertex, path: densify([from, vertex], 25), snapped: false }]);
        return;
      }

      setBusy('Calcul du tracé sur les chemins…');
      setWarning(null);
      abort.current?.abort();
      abort.current = new AbortController();
      try {
        const path = await snapToPaths(from, vertex, profile, abort.current.signal);
        // Le sommet devient l'extrémité réelle du chemin trouvé, sinon le
        // prochain tronçon repartirait d'un point situé hors sentier.
        setLegs((prev) => [...prev, { vertex: path[path.length - 1], path, snapped: true }]);
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        const why = err instanceof RoutingError ? err.message : 'Calcul d’itinéraire indisponible.';
        setWarning(`${why} Segment tracé en ligne droite.`);
        setLegs((prev) => [...prev, { vertex, path: densify([from, vertex], 25), snapped: false }]);
      } finally {
        setBusy(null);
      }
    },
    [legs, snap, profile],
  );

  const undo = () => setLegs((prev) => prev.slice(0, -1));

  const closeLoop = async () => {
    if (legs.length < 3) return;
    await addPoint(legs[0].vertex);
  };

  const moveVertex = useCallback(
    (index: number, p: LatLon) => {
      // Un sommet déplacé invalide les deux tronçons qui l'encadrent. On les
      // retracé en ligne droite : relancer deux calculs réseau à chaque
      // déplacement rendrait la manipulation inutilisable.
      setLegs((prev) => {
        const next = prev.slice();
        const vertex: RoutePoint = { lat: p.lat, lon: p.lon, ele: null };
        next[index] = { vertex, path: [vertex], snapped: false };
        if (index > 0) next[index] = { ...next[index], path: densify([next[index - 1].vertex, vertex], 25) };
        if (index + 1 < next.length) {
          next[index + 1] = { ...next[index + 1], path: densify([vertex, next[index + 1].vertex], 25), snapped: false };
        }
        return next;
      });
      setWarning('Sommet déplacé : les segments voisins sont repassés en ligne droite.');
    },
    [],
  );

  const loadElevations = async () => {
    if (points.length < 2) return;
    setBusy('Récupération des altitudes…');
    setWarning(null);
    try {
      const filled = await fillElevations(points, {
        onProgress: (done, total) => setBusy(`Altitudes : ${done}/${total}`),
      });
      if (filled.every((p) => p.ele == null)) {
        setWarning('Aucune altitude récupérée : le service de modèle de terrain est injoignable.');
        return;
      }
      // Les altitudes sont réinjectées tronçon par tronçon : aplatir le circuit
      // en un seul tronçon supprimerait les sommets et rendrait toute
      // modification ultérieure impossible.
      setLegs((prev) => {
        let cursor = 0;
        return prev.map((leg, i) => {
          // Seul le premier tronçon inclut son point de départ : les suivants
          // partagent leur première extrémité avec le tronçon précédent.
          const take = i === 0 ? leg.path.length : leg.path.length - 1;
          const slice = filled.slice(i === 0 ? 0 : cursor - 1, cursor + take);
          cursor += take;
          return { ...leg, path: slice, vertex: slice[slice.length - 1] ?? leg.vertex };
        });
      });
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (points.length < 2) return;
    // On allège avant de stocker : un circuit calé sur les chemins peut compter
    // des milliers de points dont la majorité n'apporte aucune information.
    const cleaned = simplify(points, 3);
    const built = buildRoute(name.trim() || `Circuit du ${new Date().toLocaleDateString('fr-FR')}`, cleaned, editing?.id);
    await routeStore.put(built);
    setLegs([]);
    setName('');
    onSaved();
  };

  return (
    <>
      <div className="map-wrap map-wrap--tall">
        <MapView
          basemap={basemap}
          route={points}
          vertices={vertices}
          onMapClick={(p) => void addPoint(p)}
          onVertexDrag={moveVertex}
          fitKey={editing?.id}
          showLocate
        />
      </div>

      <div className="app__body">
        {busy && <div className="notice notice--info">{busy}</div>}
        {warning && <div className="notice notice--warn">{warning}</div>}

        {legs.length === 0 && (
          <div className="notice notice--info">
            Touchez la carte pour poser le départ, puis chaque point de passage. Le tracé se cale automatiquement
            sur les chemins existants ; désactivez cette option pour relier les points en ligne droite.
          </div>
        )}

        <div className="panel">
          <div className="tiles">
            <Tile label="Distance" value={route ? formatDistance(route.distance) : '--'} />
            <Tile
              label="D+" title="Dénivelé positif"
              value={route && route.ascent > 0 ? formatElevation(route.ascent) : '--'}
              muted={!route || route.ascent === 0}
            />
            <Tile
              label="D−" title="Dénivelé négatif"
              value={route && route.descent > 0 ? formatElevation(route.descent) : '--'}
              muted={!route || route.descent === 0}
            />
            <Tile
              label="Pente moyenne"
              value={
                route && route.ascent > 0 && route.distance > 0
                  ? formatGrade((route.ascent / route.distance) * 100)
                  : '--'
              }
              muted={!route || route.ascent === 0}
            />
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn btn--small" onClick={undo} disabled={legs.length === 0}>
              Annuler le dernier point
            </button>
            <button className="btn btn--small" onClick={() => void closeLoop()} disabled={legs.length < 3}>
              Fermer la boucle
            </button>
            <button className="btn btn--small" onClick={() => void loadElevations()} disabled={points.length < 2}>
              Charger les altitudes
            </button>
          </div>
        </div>

        <div className="panel">
          <h2 className="panel__title">Profil du circuit</h2>
          {/* La condition porte sur la présence d'altitude, pas sur un dénivelé
              nul : un circuit réellement plat a bien ses altitudes. */}
          {route && !hasElevation && (
            <div className="notice notice--warn" style={{ margin: '0 0 10px' }}>
              Ce circuit n’a pas encore d’altitude. Sans elle, le dénivelé ne peut pas être calculé.
            </div>
          )}
          <ElevationChart
            distances={route?.cumDist ?? []}
            elevations={hasElevation ? points.map((p) => p.ele ?? 0) : []}
          />
        </div>

        <div className="panel">
          <label className="field">
            <span>Nom du circuit</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Boucle des cretes" />
          </label>
          <label className="field">
            <span>Calage sur les chemins</span>
            <select value={snap ? profile : 'none'} onChange={(e) => {
              const v = e.target.value;
              if (v === 'none') setSnap(false);
              else {
                setSnap(true);
                setProfile(v as ProfileKey);
              }
            }}>
              {Object.entries(PROFILES).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
              <option value="none">Ligne droite (hors connexion)</option>
            </select>
          </label>
          <label className="field">
            <span>Fond de carte</span>
            <select value={basemap} onChange={(e) => onBasemapChange(e.target.value as BasemapKey)}>
              {Object.entries(BASEMAPS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="controls">
        {editing && (
          <button className="btn btn--ghost" onClick={onCancelEdit}>
            Annuler
          </button>
        )}
        <button className="btn btn--primary" onClick={() => void save()} disabled={points.length < 2}>
          {editing ? 'Mettre à jour' : 'Enregistrer le circuit'}
        </button>
      </div>
    </>
  );
}
