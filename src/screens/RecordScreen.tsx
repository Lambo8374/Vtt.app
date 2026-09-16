import { useEffect, useMemo, useRef, useState } from 'react';
import { ElevationChart } from '../components/ElevationChart';
import { BASEMAPS, MapView } from '../components/MapView';
import type { BasemapKey } from '../components/MapView';
import { Hero, MetricTiles, Tile } from '../components/Stats';
import { RouteFollower, distanceToNextTurn } from '../core/follow';
import type { FollowState } from '../core/follow';
import { formatDistance, formatElevation } from '../core/format';
import { useGeolocation } from '../hooks/useGeolocation';
import { useRecorder } from '../hooks/useRecorder';
import { useWakeLock } from '../hooks/useWakeLock';
import type { Route } from '../core/types';

export interface RecordScreenProps {
  routes: Route[];
  basemap: BasemapKey;
  onBasemapChange: (k: BasemapKey) => void;
  onSaved: (id: string) => void;
}

export function RecordScreen({ routes, basemap, onBasemapChange, onSaved }: RecordScreenProps) {
  const [armed, setArmed] = useState(false);
  const [followId, setFollowId] = useState<string>('');
  const [name, setName] = useState('');
  const [askName, setAskName] = useState(false);
  const geo = useGeolocation(armed);
  const recorder = useRecorder(geo.point);
  const wake = useWakeLock(recorder.status === 'recording');

  const followedRoute = useMemo(() => routes.find((r) => r.id === followId) ?? null, [routes, followId]);
  const follower = useRef<RouteFollower | null>(null);
  const [followState, setFollowState] = useState<FollowState | null>(null);

  useEffect(() => {
    follower.current = followedRoute ? new RouteFollower(followedRoute) : null;
    setFollowState(null);
  }, [followedRoute]);

  useEffect(() => {
    if (!follower.current || !geo.point) return;
    setFollowState(follower.current.update(geo.point));
  }, [geo.point]);

  const { computed, status } = recorder;
  const live = computed.metrics;
  const currentSpeed = computed.speeds.length ? computed.speeds[computed.speeds.length - 1] : 0;

  const nextTurn =
    followedRoute && followState ? distanceToNextTurn(followedRoute, followState.segment) : null;

  const handleStop = () => {
    if (computed.points.length < 2) {
      void recorder.discard();
      setArmed(false);
      return;
    }
    setAskName(true);
  };

  const confirmSave = async () => {
    const id = await recorder.save(name);
    setAskName(false);
    setName('');
    setArmed(false);
    if (id) onSaved(id);
  };

  return (
    <>
      <div className="map-wrap">
        <MapView
          basemap={basemap}
          track={computed.points}
          route={followedRoute?.points}
          position={geo.point}
          heading={geo.heading}
          accuracy={geo.point?.acc ?? null}
          followPosition={status === 'recording'}
          fitKey={followedRoute?.id}
        />
      </div>

      <div className="app__body">
        {geo.message && (
          <div className={`notice notice--${geo.status === 'denied' || geo.status === 'insecure' ? 'error' : 'warn'}`}>
            {geo.message}
          </div>
        )}

        {recorder.recovered && (
          <div className="notice notice--info">
            Une sortie interrompue a ete retrouvee ({recorder.recovered.segments.reduce((a, s) => a + s.length, 0)}{' '}
            points). La reprendre ?
            <div className="row row--end" style={{ marginTop: 10 }}>
              <button className="btn btn--small btn--ghost" onClick={() => void recorder.dismissRecovered()}>
                Jeter
              </button>
              <button
                className="btn btn--small btn--primary"
                onClick={() => {
                  setArmed(true);
                  recorder.resumeRecovered();
                }}
              >
                Reprendre
              </button>
            </div>
          </div>
        )}

        {status === 'recording' && !wake.held && wake.supported && (
          <div className="notice notice--warn">
            L’écran risque de s’éteindre. Sur une application web, l’extinction de l’écran interrompt le relevé
            GPS : gardez l’écran allumé pendant la sortie.
          </div>
        )}

        <div className="panel">
          <div className="row" style={{ marginBottom: 6 }}>
            <GpsBadge status={geo.status} accuracy={geo.point?.acc ?? null} />
            <span className="spacer" />
            <span className="badge">{recorder.pointCount} points</span>
          </div>

          <Hero value={(currentSpeed * 3.6).toFixed(1)} unit="km/h" />
          <MetricTiles metrics={live} compact />
        </div>

        {followState && followedRoute && (
          <div className="panel">
            <h2 className="panel__title">Suivi de « {followedRoute.name} »</h2>
            {!followState.onRoute && (
              <div className="notice notice--warn" style={{ margin: '0 0 10px' }}>
                Hors trace : {formatDistance(followState.deviation)} de la trace prévue.
              </div>
            )}
            {followState.wrongWay && followState.onRoute && (
              <div className="notice notice--warn" style={{ margin: '0 0 10px' }}>
                Vous semblez revenir en arrière sur la trace.
              </div>
            )}
            <div className="tiles">
              <Tile label="Avancement" value={`${Math.round(followState.progress * 100)} %`} />
              <Tile label="Restant" title="Distance restante" value={formatDistance(followState.distanceRemaining)} />
              <Tile label="D+ restant" title="Dénivelé positif restant" value={formatElevation(followState.ascentRemaining)} />
              <Tile
                label="Prochain virage"
                value={nextTurn != null ? formatDistance(nextTurn) : 'Tout droit'}
                muted={nextTurn == null}
              />
            </div>
          </div>
        )}

        <div className="panel">
          <h2 className="panel__title">Profil de la sortie</h2>
          <ElevationChart distances={computed.cumDist} elevations={computed.elevations} />
        </div>

        <div className="panel">
          <label className="field">
            <span>Suivre un circuit</span>
            <select value={followId} onChange={(e) => setFollowId(e.target.value)}>
              <option value="">Aucun</option>
              {routes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} — {formatDistance(r.distance)}
                </option>
              ))}
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

        {askName && (
          <div className="panel">
            <h2 className="panel__title">Enregistrer la sortie</h2>
            <label className="field">
              <span>Nom</span>
              <input
                type="text"
                value={name}
                placeholder={`Sortie du ${new Date().toLocaleDateString('fr-FR')}`}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <div className="row">
              <button
                className="btn btn--ghost"
                onClick={() => {
                  setAskName(false);
                  void recorder.discard();
                  setArmed(false);
                }}
              >
                Supprimer
              </button>
              <button className="btn btn--primary" onClick={() => void confirmSave()}>
                Enregistrer ({formatDistance(live.distance)})
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="controls">
        {status === 'idle' && (
          <button
            className="btn btn--primary"
            onClick={() => {
              setArmed(true);
              recorder.start();
            }}
          >
            Démarrer
          </button>
        )}
        {status === 'recording' && (
          <>
            <button className="btn" onClick={recorder.pause}>
              Pause
            </button>
            <button className="btn btn--danger" onClick={handleStop}>
              Terminer
            </button>
          </>
        )}
        {status === 'paused' && (
          <>
            <button className="btn btn--primary" onClick={recorder.resume}>
              Reprendre
            </button>
            <button className="btn btn--danger" onClick={handleStop}>
              Terminer
            </button>
          </>
        )}
      </div>
    </>
  );
}

/**
 * Qualité du signal.
 *
 * La précision annoncée est affichée telle quelle : c'est elle qui explique un
 * dénivelé ou une distance douteux, et la masquer reviendrait a laisser croire
 * que toutes les sorties se valent.
 */
function GpsBadge({ status, accuracy }: { status: string; accuracy: number | null }) {
  if (status !== 'active') {
    const labels: Record<string, string> = {
      idle: 'GPS en veille',
      acquiring: 'Recherche du signal',
      denied: 'Position refusée',
      insecure: 'HTTPS requis',
      unsupported: 'GPS indisponible',
      error: 'Erreur GPS',
    };
    return (
      <span className={`badge ${status === 'denied' || status === 'error' ? 'badge--bad' : ''}`}>
        <span className="badge__dot" />
        {labels[status] ?? status}
      </span>
    );
  }
  const good = accuracy != null && accuracy <= 10;
  const fair = accuracy != null && accuracy <= 25;
  return (
    <span className={`badge ${good ? 'badge--good' : fair ? 'badge--warn' : 'badge--bad'}`}>
      <span className="badge__dot" />
      {good ? 'Signal bon' : fair ? 'Signal moyen' : 'Signal faible'}
      {accuracy != null ? ` · ±${Math.round(accuracy)} m` : ''}
    </span>
  );
}
