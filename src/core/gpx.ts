import type { RoutePoint, TrackPoint } from './types';

export interface ParsedGpx {
  name: string | null;
  /** Points de `<trkpt>`, avec horodatage quand il est présent. */
  trackPoints: TrackPoint[];
  /** Points de `<rtept>`, sans horodatage. */
  routePoints: RoutePoint[];
}

/**
 * Analyse un fichier GPX.
 *
 * On n'utilise pas `DOMParser` : le même code doit tourner cote navigateur, en
 * test sous Node et, a terme, dans un worker. Le GPX est assez régulier pour
 * qu'un balayage suffise, a condition de tolérer les prefixes de namespace
 * (`<gpx:trkpt>`) que produisent certains exportateurs.
 */
export function parseGpx(xml: string): ParsedGpx {
  const nameMatch = xml.match(/<(?:\w+:)?name>([\s\S]*?)<\/(?:\w+:)?name>/);
  const name = nameMatch ? decodeXml(nameMatch[1].trim()) : null;

  const trackPoints: TrackPoint[] = [];
  const routePoints: RoutePoint[] = [];

  const ptRe = /<(?:\w+:)?(trkpt|rtept|wpt)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?\1>)/g;
  let m: RegExpExecArray | null;
  // Les traces exportées sans horodatage restent exploitables pour le trace ;
  // on ne leur invente pas de date, on les range en points de circuit.
  while ((m = ptRe.exec(xml)) !== null) {
    const [, tag, attrs, body = ''] = m;
    const lat = Number(attrs.match(/\blat\s*=\s*["']([^"']+)["']/)?.[1]);
    const lon = Number(attrs.match(/\blon\s*=\s*["']([^"']+)["']/)?.[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const eleRaw = body.match(/<(?:\w+:)?ele>([\s\S]*?)<\/(?:\w+:)?ele>/)?.[1];
    const ele = eleRaw != null && eleRaw.trim() !== '' ? Number(eleRaw) : null;
    const timeRaw = body.match(/<(?:\w+:)?time>([\s\S]*?)<\/(?:\w+:)?time>/)?.[1];
    const t = timeRaw ? Date.parse(timeRaw.trim()) : NaN;

    if (tag === 'trkpt' && Number.isFinite(t)) {
      trackPoints.push({ lat, lon, ele: ele != null && Number.isFinite(ele) ? ele : null, t });
    } else if (tag !== 'wpt') {
      routePoints.push({ lat, lon, ele: ele != null && Number.isFinite(ele) ? ele : null });
    }
  }

  return { name, trackPoints, routePoints };
}

/** Sérialise une sortie enregistrée en GPX 1.1 (`<trk>`). */
export function buildTrackGpx(name: string, points: TrackPoint[]): string {
  const body = points
    .map((p) => {
      const ele = p.ele != null ? `<ele>${p.ele.toFixed(1)}</ele>` : '';
      return `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">${ele}<time>${new Date(
        p.t,
      ).toISOString()}</time></trkpt>`;
    })
    .join('\n');
  return header(name) + `  <trk>\n    <name>${escapeXml(name)}</name>\n    <trkseg>\n${body}\n    </trkseg>\n  </trk>\n</gpx>\n`;
}

/** Sérialise un circuit en GPX 1.1 (`<rte>`). */
export function buildRouteGpx(name: string, points: RoutePoint[]): string {
  const body = points
    .map((p) => {
      const ele = p.ele != null ? `<ele>${p.ele.toFixed(1)}</ele>` : '';
      return `    <rtept lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">${ele}</rtept>`;
    })
    .join('\n');
  return header(name) + `  <rte>\n    <name>${escapeXml(name)}</name>\n${body}\n  </rte>\n</gpx>\n`;
}

function header(name: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx version="1.1" creator="Vtt.app" xmlns="http://www.topografix.com/GPX/1/1">\n` +
    `  <metadata><name>${escapeXml(name)}</name><time>${new Date().toISOString()}</time></metadata>\n`
  );
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
