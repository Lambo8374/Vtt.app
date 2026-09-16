import { useEffect, useRef, useState } from 'react';
import { routeStore, storageEstimate, trackStore } from '../core/db';
import { buildRouteGpx, buildTrackGpx, parseGpx } from '../core/gpx';
import { formatBytes, formatDate, formatDistance, formatDuration, formatElevation } from '../core/format';
import { newId } from '../core/id';
import { computeTrack } from '../core/metrics';
import { buildRoute } from '../core/route';
import { simplify } from '../core/simplify';
import type { Route, Track } from '../core/types';

export interface LibraryProps {
  tracks: Track[];
  routes: Route[];
  onRefresh: () => void;
  onOpenTrack: (id: string) => void;
  onEditRoute: (route: Route) => void;
}

/** Déclenche le téléchargement d'un fichier généré côté client. */
function download(filename: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/gpx+xml' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Libérer immédiatement révoquerait l'URL avant que le téléchargement ne
  // démarre sur certains navigateurs.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeName(name: string): string {
  return name.replace(/[^\w\-. ]+/g, '_').slice(0, 60) || 'circuit';
}

export function LibraryScreen({ tracks, routes, onRefresh, onOpenTrack, onEditRoute }: LibraryProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null);

  useEffect(() => {
    void storageEstimate().then(setUsage);
  }, [tracks, routes]);

  const importGpx = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    let imported = 0;
    const problems: string[] = [];

    for (const file of Array.from(files)) {
      try {
        const parsed = parseGpx(await file.text());
        const label = parsed.name ?? file.name.replace(/\.gpx$/i, '');

        if (parsed.trackPoints.length >= 2) {
          // Une trace importée vient d'un autre appareil, souvent déjà filtrée :
          // relancer le lissage de Kalman la déformerait sans rien corriger.
          const computed = computeTrack(parsed.trackPoints, { skipSmoothing: true });
          await trackStore.put({
            id: newId(),
            name: label,
            startedAt: parsed.trackPoints[0].t,
            points: computed.points,
            metrics: computed.metrics,
            source: 'imported',
          });
          imported++;
        } else if (parsed.routePoints.length >= 2) {
          await routeStore.put(buildRoute(label, simplify(parsed.routePoints, 3), newId()));
          imported++;
        } else {
          problems.push(`${file.name} : aucun point exploitable.`);
        }
      } catch (err) {
        problems.push(`${file.name} : ${(err as Error).message}`);
      }
    }

    setMessage(
      [imported > 0 ? `${imported} fichier(s) importe(s).` : null, ...problems].filter(Boolean).join(' '),
    );
    onRefresh();
    if (fileInput.current) fileInput.current.value = '';
  };

  const removeTrack = async (t: Track) => {
    if (!confirm(`Supprimer définitivement « ${t.name} » ?`)) return;
    await trackStore.remove(t.id);
    onRefresh();
  };

  const removeRoute = async (r: Route) => {
    if (!confirm(`Supprimer définitivement « ${r.name} » ?`)) return;
    await routeStore.remove(r.id);
    onRefresh();
  };

  return (
    <div className="app__body">
      {message && <div className="notice notice--info">{message}</div>}

      <div className="panel">
        <h2 className="panel__title">Importer</h2>
        <input
          ref={fileInput}
          type="file"
          accept=".gpx,application/gpx+xml"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => void importGpx(e.target.files)}
        />
        <button className="btn" onClick={() => fileInput.current?.click()}>
          Ouvrir un fichier GPX
        </button>
        {usage && (
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '10px 0 0' }}>
            Stockage local utilise : {formatBytes(usage.usage)}
            {usage.quota > 0 ? ` sur ${formatBytes(usage.quota)} disponibles` : ''}. Les données restent sur cet
            appareil ; exportez en GPX pour les conserver ailleurs.
          </p>
        )}
      </div>

      <div className="panel">
        <h2 className="panel__title">Sorties enregistrées ({tracks.length})</h2>
        {tracks.length === 0 ? (
          <p className="empty">Aucune sortie pour l’instant.</p>
        ) : (
          <ul className="list">
            {tracks.map((t) => (
              <li key={t.id} className="list__item" onClick={() => onOpenTrack(t.id)}>
                <div className="list__main">
                  <div className="list__name">{t.name}</div>
                  <div className="list__meta">
                    {formatDate(t.startedAt)} · {formatDistance(t.metrics.distance)} ·{' '}
                    {formatElevation(t.metrics.ascent)} D+ · {formatDuration(t.metrics.movingTime)}
                    {t.source === 'imported' ? ' · importée' : ''}
                  </div>
                </div>
                <button
                  className="btn btn--small btn--ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    download(`${safeName(t.name)}.gpx`, buildTrackGpx(t.name, t.points));
                  }}
                >
                  Exporter
                </button>
                <button
                  className="btn btn--small btn--ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    void removeTrack(t);
                  }}
                >
                  Supprimer
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="panel">
        <h2 className="panel__title">Circuits ({routes.length})</h2>
        {routes.length === 0 ? (
          <p className="empty">Aucun circuit. Créez-en un dans l’onglet Créer.</p>
        ) : (
          <ul className="list">
            {routes.map((r) => (
              <li key={r.id} className="list__item" onClick={() => onEditRoute(r)}>
                <div className="list__main">
                  <div className="list__name">
                    {r.name} {r.loop ? '· boucle' : ''}
                  </div>
                  <div className="list__meta">
                    {formatDistance(r.distance)} · {formatElevation(r.ascent)} D+ · {r.points.length} points
                  </div>
                </div>
                <button
                  className="btn btn--small btn--ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    download(`${safeName(r.name)}.gpx`, buildRouteGpx(r.name, r.points));
                  }}
                >
                  Exporter
                </button>
                <button
                  className="btn btn--small btn--ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    void removeRoute(r);
                  }}
                >
                  Supprimer
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
