import { useMemo } from 'react';
import { ElevationChart } from '../components/ElevationChart';
import { MapView } from '../components/MapView';
import type { BasemapKey } from '../components/MapView';
import { MetricTiles, SplitsTable } from '../components/Stats';
import { buildTrackGpx } from '../core/gpx';
import { formatDate } from '../core/format';
import { computeSplits, computeTrack } from '../core/metrics';
import type { Track } from '../core/types';

export interface TrackDetailProps {
  track: Track;
  basemap: BasemapKey;
  onBack: () => void;
}

export function TrackDetailScreen({ track, basemap, onBack }: TrackDetailProps) {
  // Les points stockés sont déjà nettoyés : on recalcule sans relisser, pour
  // obtenir les séries (altitudes, distances cumulées) nécessaires a
  // l'affichage sans altérer les métriques enregistrées.
  const computed = useMemo(
    () => computeTrack(track.points, { skipSmoothing: true, skipStopDetection: true }),
    [track.points],
  );
  const splits = useMemo(() => computeSplits(computed, 1000), [computed]);

  return (
    <>
      <div className="map-wrap">
        <MapView basemap={basemap} track={track.points} fitKey={track.id} />
      </div>

      <div className="app__body">
        <div className="panel">
          <div className="row">
            <div>
              <h2 style={{ margin: 0, fontSize: 18 }}>{track.name}</h2>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{formatDate(track.startedAt)}</div>
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <MetricTiles metrics={track.metrics} />
          </div>
        </div>

        <div className="panel">
          <h2 className="panel__title">Profil altimétrique</h2>
          <ElevationChart distances={computed.cumDist} elevations={computed.elevations} height={170} />
        </div>

        <div className="panel">
          <h2 className="panel__title">Temps par kilomètre</h2>
          <SplitsTable splits={splits} />
        </div>
      </div>

      <div className="controls">
        <button className="btn btn--ghost" onClick={onBack}>
          Retour
        </button>
        <button
          className="btn"
          onClick={() => {
            const url = URL.createObjectURL(
              new Blob([buildTrackGpx(track.name, track.points)], { type: 'application/gpx+xml' }),
            );
            const a = document.createElement('a');
            a.href = url;
            a.download = `${track.name.replace(/[^\w\-. ]+/g, '_').slice(0, 60) || 'sortie'}.gpx`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        >
          Exporter en GPX
        </button>
      </div>
    </>
  );
}
