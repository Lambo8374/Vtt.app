import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { formatDistance, formatElevation, formatGrade } from '../core/format';

export interface ElevationChartProps {
  /** Distances cumulées, en mètres. */
  distances: number[];
  /** Altitudes, en mètres, alignées sur `distances`. */
  elevations: number[];
  /** Position courante sur le profil, en mètres, marquée d'un repère. */
  marker?: number | null;
  height?: number;
}

const PAD = { top: 10, right: 10, bottom: 22, left: 42 };

/**
 * Profil altimétrique : aire sous la courbe, série unique.
 *
 * Une série unique ne prend pas de légende : le titre du bloc la nomme. La
 * vitesse n'y est pas superposée — deux échelles verticales sur un même
 * graphique se lisent systématiquement de travers.
 */
export function ElevationChart({ distances, elevations, marker, height = 150 }: ElevationChartProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(200, entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const model = useMemo(() => {
    const n = Math.min(distances.length, elevations.length);
    if (n < 2) return null;
    const total = distances[n - 1];
    if (!(total > 0)) return null;

    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < n; i++) {
      if (elevations[i] < min) min = elevations[i];
      if (elevations[i] > max) max = elevations[i];
    }
    // Une plage trop étroite exagérerait le moindre ressaut : on impose un
    // minimum de 40 m pour que le profil d'un parcours plat reste plat.
    if (max - min < 40) {
      const mid = (max + min) / 2;
      min = mid - 20;
      max = mid + 20;
    }
    const pad = (max - min) * 0.08;
    return { n, total, min: min - pad, max: max + pad };
  }, [distances, elevations]);

  const innerW = Math.max(10, width - PAD.left - PAD.right);
  const innerH = Math.max(10, height - PAD.top - PAD.bottom);

  const x = useCallback(
    (d: number) => PAD.left + (model ? (d / model.total) * innerW : 0),
    [model, innerW],
  );
  const y = useCallback(
    (e: number) => PAD.top + (model ? innerH - ((e - model.min) / (model.max - model.min)) * innerH : 0),
    [model, innerH],
  );

  const path = useMemo(() => {
    if (!model) return { line: '', area: '' };
    // Un point par pixel suffit : tracer 10 000 segments sur 300 px coûte cher
    // et n'ajoute rien de visible.
    const step = Math.max(1, Math.floor(model.n / innerW));
    const pts: string[] = [];
    for (let i = 0; i < model.n; i += step) pts.push(`${x(distances[i]).toFixed(1)},${y(elevations[i]).toFixed(1)}`);
    const last = model.n - 1;
    pts.push(`${x(distances[last]).toFixed(1)},${y(elevations[last]).toFixed(1)}`);
    const line = `M${pts.join('L')}`;
    const base = PAD.top + innerH;
    return { line, area: `${line}L${x(distances[last]).toFixed(1)},${base}L${PAD.left},${base}Z` };
  }, [model, distances, elevations, x, y, innerW, innerH]);

  const ticks = useMemo(() => {
    if (!model) return { xs: [] as number[], ys: [] as number[] };
    const niceStep = (range: number, count: number) => {
      const raw = range / count;
      const mag = 10 ** Math.floor(Math.log10(raw));
      return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
    };
    const xStep = niceStep(model.total, 4);
    const yStep = niceStep(model.max - model.min, 3);
    const xs: number[] = [];
    for (let v = 0; v <= model.total + 1; v += xStep) xs.push(v);
    const ys: number[] = [];
    for (let v = Math.ceil(model.min / yStep) * yStep; v <= model.max; v += yStep) ys.push(v);
    return { xs, ys };
  }, [model]);

  /** Index du point le plus proche de l'abscisse pointee. */
  const indexAt = useCallback(
    (clientX: number) => {
      if (!model || !wrap.current) return null;
      const rect = wrap.current.getBoundingClientRect();
      const ratio = (clientX - rect.left - PAD.left) / innerW;
      if (ratio < -0.02 || ratio > 1.02) return null;
      const target = Math.min(model.total, Math.max(0, ratio * model.total));
      let lo = 0;
      let hi = model.n - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (distances[mid] < target) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    },
    [model, distances, innerW],
  );

  if (!model) {
    return (
      <div ref={wrap} className="chart-wrap">
        <svg className="chart" width="100%" height={height} role="img" aria-label="Profil altimétrique indisponible">
          <text className="chart__empty" x="50%" y={height / 2} textAnchor="middle">
            Pas encore de données d’altitude
          </text>
        </svg>
      </div>
    );
  }

  const hoverIdx = hover;
  const gradeAt = (i: number) => {
    const a = Math.max(0, i - 5);
    const b = Math.min(model.n - 1, i + 5);
    const dd = distances[b] - distances[a];
    return dd > 0 ? ((elevations[b] - elevations[a]) / dd) * 100 : 0;
  };

  return (
    <div ref={wrap} className="chart-wrap">
      <svg
        className="chart"
        width="100%"
        height={height}
        role="img"
        aria-label={`Profil altimétrique sur ${formatDistance(model.total)}, de ${formatElevation(
          model.min,
        )} a ${formatElevation(model.max)}`}
        onMouseMove={(e) => setHover(indexAt(e.clientX))}
        onMouseLeave={() => setHover(null)}
        onTouchStart={(e) => setHover(indexAt(e.touches[0].clientX))}
        onTouchMove={(e) => setHover(indexAt(e.touches[0].clientX))}
        onTouchEnd={() => setHover(null)}
      >
        {/* L'unité n'est portée que par la graduation extrême : la répéter sur
            chacune surchargerait l'axe sans rien apprendre. */}
        {ticks.ys.map((v, i) => (
          <g key={`y${v}`}>
            <line className="chart__grid" x1={PAD.left} x2={PAD.left + innerW} y1={y(v)} y2={y(v)} />
            <text className="chart__axis-text" x={PAD.left - 6} y={y(v) + 3} textAnchor="end">
              {Math.round(v)}
              {i === ticks.ys.length - 1 ? ' m' : ''}
            </text>
          </g>
        ))}
        {ticks.xs.map((v, i) => (
          <text
            key={`x${v}`}
            className="chart__axis-text"
            x={x(v)}
            y={height - 2}
            textAnchor={i === ticks.xs.length - 1 ? 'end' : 'middle'}
          >
            {(v / 1000).toFixed(v < 10_000 ? 1 : 0)}
            {i === ticks.xs.length - 1 ? ' km' : ''}
          </text>
        ))}

        <path className="chart__area" d={path.area} />
        <path className="chart__line" d={path.line} />

        {marker != null && marker >= 0 && marker <= model.total && (
          <line className="chart__crosshair" x1={x(marker)} x2={x(marker)} y1={PAD.top} y2={PAD.top + innerH} />
        )}

        {hoverIdx != null && (
          <>
            <line
              className="chart__crosshair"
              x1={x(distances[hoverIdx])}
              x2={x(distances[hoverIdx])}
              y1={PAD.top}
              y2={PAD.top + innerH}
            />
            <circle className="chart__dot" cx={x(distances[hoverIdx])} cy={y(elevations[hoverIdx])} r={4.5} />
          </>
        )}
      </svg>

      {hoverIdx != null && (
        <div
          className="tooltip"
          style={{
            // Bascule a gauche du curseur près du bord droit, sinon l'infobulle
            // déborderait du cadre.
            left: Math.min(x(distances[hoverIdx]) + 10, width - 130),
            top: 6,
          }}
        >
          <div className="tooltip__row">
            <span className="tooltip__key">Distance</span>
            <span className="tooltip__val">{formatDistance(distances[hoverIdx])}</span>
          </div>
          <div className="tooltip__row">
            <span className="tooltip__key">Altitude</span>
            <span className="tooltip__val">{formatElevation(elevations[hoverIdx])}</span>
          </div>
          <div className="tooltip__row">
            <span className="tooltip__key">Pente</span>
            <span className="tooltip__val">{formatGrade(gradeAt(hoverIdx))}</span>
          </div>
        </div>
      )}
    </div>
  );
}
