import { useEffect, useMemo, useRef, useState } from 'react';
import { ElevationChart } from '../components/ElevationChart';
import { BASEMAPS, MapView } from '../components/MapView';
import type { BasemapKey } from '../components/MapView';
import { Hero, MetricTiles, Tile } from '../components/Stats';
import { RouteFollower, distanceToNextTurn } from '../core/follow';
import type { FollowState } from '../core/follow';
import { formatDistance, formatDuration, formatElevation } from '../core/format';
import { useGeolocation } from '../hooks/useGeolocation';
import { useRecorder } from '../hooks/useRecorder';
import { useWakeLock } from '../hooks/useWakeLock';
import type { WakeLockState } from '../hooks/useWakeLock';
import { buildRoute } from '../core/route';
import { simplify } from '../core/simplify';
import type { Route, Track } from '../core/types';

const KEEP_SCREEN_ON_KEY = 'vtt-app.keepScreenOn';

/** Le maintien de l'ecran est actif par defaut : c'est le reglage utile a velo. */
function readKeepScreenOn(): boolean {
  try {
    return localStorage.getItem(KEEP_SCREEN_ON_KEY) !== '0';
  } catch {
    return true;
  }
}

export interface RecordScreenProps {
  routes: Route[];
  /** Sorties déjà enregistrées, proposées au suivi au même titre qu'un circuit. */
  tracks: Track[];
  basemap: BasemapKey;
  onBasemapChange: (k: BasemapKey) => void;
  onSaved: (id: string) => void;
}

export function RecordScreen({ routes, tracks, basemap, onBasemapChange, onSaved }: RecordScreenProps) {
  const [armed, setArmed] = useState(false);
  const [followId, setFollowId] = useState<string>('');
  const [name, setName] = useState('');
  const [askName, setAskName] = useState(false);
  const [keepScreenOn, setKeepScreenOn] = useState(readKeepScreenOn);
  const geo = useGeolocation(armed);
  const recorder = useRecorder(geo.point);
  // Le maintien couvre aussi la pause : une pause au sommet est justement un
  // moment ou l'ecran s'eteindrait, et la reprise se ferait alors sans releve.
  const wake = useWakeLock(keepScreenOn && recorder.status !== 'idle');

  useEffect(() => {
    try {
      localStorage.setItem(KEEP_SCREEN_ON_KEY, keepScreenOn ? '1' : '0');
    } catch {
      // Stockage indisponible (navigation privee) : le reglage vaut pour la
      // session en cours, ce qui n'empeche pas de rouler.
    }
  }, [keepScreenOn]);

  /**
   * Circuit suivi, qu'il vienne de l'onglet « Créer » ou d'une sortie déjà
   * roulée.
   *
   * Refaire une trace qu'on a enregistrée est l'usage le plus courant : exiger
   * de la redessiner à la main dans l'éditeur n'aurait aucun sens. La trace est
   * allégée avant conversion — une sortie de trois heures compte des milliers de
   * points dont la quasi-totalité n'apporte rien au recalage, et les garder
   * ralentirait chaque mise à jour de position.
   */
  const followedRoute = useMemo(() => {
    if (!followId) return null;
    const [kind, id] = followId.split(':');
    if (kind === 'route') return routes.find((r) => r.id === id) ?? null;
    const track = tracks.find((t) => t.id === id);
    if (!track || track.points.length < 2) return null;
    const points = simplify(
      track.points.map((p) => ({ lat: p.lat, lon: p.lon, ele: p.ele })),
      3,
    );
    return buildRoute(track.name, points, track.id);
  }, [routes, tracks, followId]);
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
  // Le moteur refuse d'enregistrer sous deux points : autant le dire dans la
  // boîte plutôt que de laisser un bouton qui ne ferait rien.
  const canSave = computed.points.length >= 2;
  // Une sortie d'un seul point ne constitue pas une trace à suivre.
  const followableTracks = useMemo(() => tracks.filter((t) => t.points.length >= 2), [tracks]);
  const currentSpeed = computed.speeds.length ? computed.speeds[computed.speeds.length - 1] : 0;

  const nextTurn =
    followedRoute && followState ? distanceToNextTurn(followedRoute, followState.segment) : null;

  /**
   * Fin de sortie.
   *
   * Le relevé est arrêté avant toute chose : tant que la boîte de dialogue est
   * ouverte, le cycliste a décidé que la sortie était finie, et chaque point
   * supplémentaire fausserait la distance qu'il vient de lire. Une sortie trop
   * courte n'est pas jetée en silence — la boîte s'ouvre quand même et explique
   * pourquoi elle ne peut pas être enregistrée.
   */
  const handleStop = () => {
    recorder.pause();
    setAskName(true);
  };

  /** Annule une fin de sortie déclenchée par erreur. */
  const resumeRide = () => {
    setAskName(false);
    recorder.resume();
  };

  const discardRide = () => {
    setAskName(false);
    void recorder.discard();
    setArmed(false);
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

        {status !== 'idle' && keepScreenOn && !wake.held && (
          <div className="notice notice--warn">
            <strong>L’écran risque de s’éteindre.</strong> {wake.reason ?? ''} L’extinction de l’écran interrompt
            le relevé GPS et troue la trace. Sur Android : désactivez l’économiseur de batterie pour ce
            navigateur et allongez le délai de mise en veille de l’écran.
          </div>
        )}

        {status !== 'idle' && !keepScreenOn && (
          <div className="notice notice--warn">
            Le maintien de l’écran est désactivé. Si l’écran s’éteint, l’enregistrement s’interrompt.
          </div>
        )}

        {/* Le suivi passe avant les mesures : à vélo on ne fait pas défiler la
            page. Sous le bloc des mesures, la distance restante et l'alerte de
            sortie de trace tombaient hors écran, c'est-à-dire exactement là où
            elles ne servent plus à rien. */}
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
          <div className="row" style={{ marginBottom: 6 }}>
            <GpsBadge status={geo.status} accuracy={geo.point?.acc ?? null} />
            {status !== 'idle' && <ScreenBadge wake={wake} enabled={keepScreenOn} />}
            <span className="spacer" />
            <span className="badge">
              {recorder.pointCount} point{recorder.pointCount > 1 ? 's' : ''}
            </span>
          </div>

          <Hero value={(currentSpeed * 3.6).toFixed(1)} unit="km/h" />
          <MetricTiles metrics={live} compact />
        </div>

        <div className="panel">
          <h2 className="panel__title">Profil de la sortie</h2>
          <ElevationChart distances={computed.cumDist} elevations={computed.elevations} />
        </div>

        <div className="panel">
          <label className="field">
            <span>Suivre une trace</span>
            <select value={followId} onChange={(e) => setFollowId(e.target.value)}>
              <option value="">Aucune</option>
              {routes.length > 0 && (
                <optgroup label="Circuits créés">
                  {routes.map((r) => (
                    <option key={r.id} value={`route:${r.id}`}>
                      {r.name} — {formatDistance(r.distance)}
                    </option>
                  ))}
                </optgroup>
              )}
              {followableTracks.length > 0 && (
                <optgroup label="Sorties enregistrées">
                  {followableTracks.map((t) => (
                    <option key={t.id} value={`track:${t.id}`}>
                      {t.name} — {formatDistance(t.metrics.distance)}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            {/* Une liste vide doit dire pourquoi : « Aucune » seul laisse croire
                à un défaut alors qu'il n'y a simplement rien à suivre. */}
            {routes.length === 0 && followableTracks.length === 0 && (
              <span className="field__hint">
                Rien à suivre pour l’instant. Enregistrez une sortie, ou créez un circuit dans l’onglet
                Créer — les deux apparaîtront ici.
              </span>
            )}
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
          <label className="switch">
            <input type="checkbox" checked={keepScreenOn} onChange={(e) => setKeepScreenOn(e.target.checked)} />
            <span>
              <span className="switch__label">Garder l’écran allumé pendant la sortie</span>
              <span className="switch__hint">
                Indispensable au relevé GPS. À désactiver seulement si vous acceptez que l’enregistrement
                s’interrompe quand l’écran s’éteint.
              </span>
            </span>
          </label>
        </div>

      </div>

      {/* Boîte de dialogue plutôt que bloc en fin de page : ajouté à la suite
          des autres blocs, le formulaire s'affichait sous la carte et sous
          toutes les mesures, hors écran. L'appui sur « Terminer » restait donc
          sans effet visible. */}
      {askName && (
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby="fin-titre">
          <div className="modal__card">
            <h2 className="modal__title" id="fin-titre">
              Sortie terminée
            </h2>
            <p className="modal__summary">
              {formatDistance(live.distance)} · {formatElevation(live.ascent)} D+ ·{' '}
              {formatDuration(live.movingTime)} en mouvement
            </p>

            {canSave ? (
              <label className="field">
                <span>Nom de la sortie</span>
                <input
                  type="text"
                  value={name}
                  autoFocus
                  placeholder={`Sortie du ${new Date().toLocaleDateString('fr-FR')}`}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
            ) : (
              <p className="modal__warning">
                Cette sortie est trop courte pour être enregistrée : il n’y a pas assez de points GPS
                exploitables.
              </p>
            )}

            <div className="modal__actions">
              {canSave && (
                <button className="btn btn--primary" onClick={() => void confirmSave()}>
                  Enregistrer
                </button>
              )}
              <button className="btn" onClick={resumeRide}>
                Continuer la sortie
              </button>
              <button className="btn btn--ghost modal__discard" onClick={discardRide}>
                Supprimer sans enregistrer
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Les commandes du bas sont masquées pendant la boîte de dialogue :
          laisser « Pause » et « Terminer » actifs derrière elle donnerait deux
          jeux d'actions contradictoires. */}
      {!askName && (
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
      )}
    </>
  );
}

/**
 * État du maintien de l'écran.
 *
 * L'indicateur annonce le moyen réellement actif, jamais l'intention : un
 * verrou refusé par le système doit se voir pendant qu'il est encore possible
 * d'y remédier, et non se découvrir à l'arrivée devant une trace coupée.
 */
function ScreenBadge({ wake, enabled }: { wake: WakeLockState; enabled: boolean }) {
  if (!enabled || !wake.held) {
    return (
      <span className={enabled ? 'badge badge--bad' : 'badge'}>
        <span className="badge__dot" />
        Écran non maintenu
      </span>
    );
  }
  return (
    <span className="badge badge--good">
      <span className="badge__dot" />
      {wake.method === 'video' ? 'Écran maintenu (secours)' : 'Écran maintenu'}
    </span>
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
