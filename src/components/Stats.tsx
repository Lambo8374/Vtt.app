import {
  formatDistance,
  formatDuration,
  formatElevation,
  formatGrade,
  formatPaceValue,
  formatSpeedValue,
} from '../core/format';
import type { Split, TrackMetrics } from '../core/types';

export function Tile({
  label,
  value,
  muted,
  title,
}: {
  label: string;
  value: string;
  muted?: boolean;
  /** Libelle complet, quand `label` est une abreviation comme « D+ ». */
  title?: string;
}) {
  return (
    <div className="tile">
      <div className="tile__label" title={title}>
        {label}
      </div>
      <div className={muted ? 'tile__value tile__value--muted' : 'tile__value'}>{value}</div>
    </div>
  );
}

/**
 * Chiffre principal d'un écran.
 *
 * Un seul par vue : c'est la valeur que l'on doit pouvoir lire d'un coup d'oeil
 * sans quitter la piste des yeux. Les chiffres proportionnels par défaut, et non
 * tabulaires, évitent l'aspect trop espace à cette taille.
 */
export function Hero({ value, unit }: { value: string; unit: string }) {
  return (
    <div className="hero">
      <span className="hero__value">{value}</span>
      <span className="hero__unit">{unit}</span>
    </div>
  );
}

export function MetricTiles({ metrics, compact = false }: { metrics: TrackMetrics; compact?: boolean }) {
  return (
    <div className="tiles">
      <Tile label="Distance" value={formatDistance(metrics.distance)} />
      <Tile label="D+" title="Dénivelé positif" value={formatElevation(metrics.ascent)} />
      <Tile label="D−" title="Dénivelé négatif" value={formatElevation(metrics.descent)} />
      <Tile label="En mouvement" value={formatDuration(metrics.movingTime)} />
      {!compact && (
        <>
          <Tile label="Temps total" value={formatDuration(metrics.duration)} />
          <Tile label="Vitesse moy. (km/h)" title="Vitesse moyenne en mouvement" value={formatSpeedValue(metrics.avgMovingSpeed)} />
          <Tile label="Vitesse max. (km/h)" value={formatSpeedValue(metrics.maxSpeed)} />
          <Tile label="Allure (min/km)" title="Allure moyenne en mouvement" value={formatPaceValue(metrics.avgMovingSpeed)} />
          <Tile label="Altitude max." value={metrics.maxEle == null ? '--' : String(Math.round(metrics.maxEle))} title="Altitude maximale, en mètres" />
          <Tile label="Pente en montée" title="Pente moyenne des sections en montée" value={formatGrade(metrics.avgClimbGrade)} />
        </>
      )}
    </div>
  );
}

/**
 * Tableau des temps intermédiaires.
 *
 * Il double le profil altimétrique en données chiffrées : le graphique seul
 * n'est pas lisible au lecteur d'écran ni exploitable pour comparer deux
 * kilomètres précis.
 */
export function SplitsTable({ splits }: { splits: Split[] }) {
  if (splits.length === 0) return null;
  return (
    <table className="splits">
      <thead>
        <tr>
          <th scope="col">Km</th>
          <th scope="col">Temps</th>
          <th scope="col">Vitesse (km/h)</th>
          <th scope="col">Allure (min/km)</th>
          <th scope="col">D+ (m)</th>
          <th scope="col">D− (m)</th>
        </tr>
      </thead>
      <tbody>
        {splits.map((s) => (
          <tr key={s.index}>
            <th scope="row">
              {s.index}
              {s.distance < 950 ? ` (${Math.round(s.distance)} m)` : ''}
            </th>
            <td>{formatDuration(s.duration)}</td>
            <td>{formatSpeedValue(s.speed)}</td>
            <td>{formatPaceValue(s.speed)}</td>
            <td>{Math.round(s.ascent)}</td>
            <td>{Math.round(s.descent)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
