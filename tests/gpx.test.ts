import { describe, expect, it } from 'vitest';
import { buildRouteGpx, buildTrackGpx, parseGpx } from '../src/core/gpx';
import { syntheticTrack } from './helpers';

const SAMPLE = `<?xml version="1.0"?>
<gpx version="1.1" creator="Garmin">
  <metadata><name>Col de la Madone</name></metadata>
  <trk><name>Col de la Madone</name><trkseg>
    <trkpt lat="43.7500000" lon="7.4500000"><ele>120.5</ele><time>2026-04-12T08:00:00Z</time></trkpt>
    <trkpt lat="43.7510000" lon="7.4510000"><ele>135.0</ele><time>2026-04-12T08:00:10Z</time></trkpt>
    <trkpt lat="43.7520000" lon="7.4520000"><ele>150.0</ele><time>2026-04-12T08:00:20Z</time></trkpt>
  </trkseg></trk>
</gpx>`;

describe('parseGpx', () => {
  it('lit le nom, les coordonnées, l altitude et l heure', () => {
    const g = parseGpx(SAMPLE);
    expect(g.name).toBe('Col de la Madone');
    expect(g.trackPoints).toHaveLength(3);
    expect(g.trackPoints[0].lat).toBeCloseTo(43.75, 6);
    expect(g.trackPoints[0].ele).toBe(120.5);
    expect(g.trackPoints[2].t).toBe(Date.parse('2026-04-12T08:00:20Z'));
  });

  it('accepte les prefixes de namespace', () => {
    const g = parseGpx(
      `<gpx:gpx><gpx:trkpt lat="45" lon="3"><gpx:ele>200</gpx:ele><gpx:time>2026-04-12T08:00:00Z</gpx:time></gpx:trkpt></gpx:gpx>`,
    );
    expect(g.trackPoints).toHaveLength(1);
    expect(g.trackPoints[0].ele).toBe(200);
  });

  it('range les points sans horodatage en circuit plutôt qu en trace', () => {
    const g = parseGpx(`<gpx><trk><trkseg>
      <trkpt lat="45" lon="3"><ele>200</ele></trkpt>
      <trkpt lat="45.001" lon="3.001"><ele>210</ele></trkpt>
    </trkseg></trk></gpx>`);
    expect(g.trackPoints).toHaveLength(0);
    expect(g.routePoints).toHaveLength(2);
  });

  it('lit les rtept et ignore les waypoints isolés', () => {
    const g = parseGpx(`<gpx>
      <wpt lat="44" lon="5"><name>Parking</name></wpt>
      <rte><rtept lat="45" lon="3"/><rtept lat="45.01" lon="3.01"/></rte>
    </gpx>`);
    expect(g.routePoints).toHaveLength(2);
    expect(g.routePoints[0].ele).toBeNull();
  });

  it('accepte une altitude absente ou vide', () => {
    const g = parseGpx(`<gpx><rte><rtept lat="45" lon="3"><ele></ele></rtept></rte></gpx>`);
    expect(g.routePoints[0].ele).toBeNull();
  });

  it('decode les entites XML du nom', () => {
    expect(parseGpx(`<gpx><metadata><name>Bois &amp; Combes</name></metadata></gpx>`).name).toBe('Bois & Combes');
  });

  it('ignore les coordonnées invalides', () => {
    const g = parseGpx(`<gpx><rte><rtept lat="abc" lon="3"/><rtept lat="45" lon="3"/></rte></gpx>`);
    expect(g.routePoints).toHaveLength(1);
  });

  it('ne plante pas sur une entrée vide', () => {
    expect(parseGpx('').trackPoints).toEqual([]);
  });
});

describe('aller-retour GPX', () => {
  it('conserve les points d une trace a l ecriture puis à la relecture', () => {
    const pts = syntheticTrack({ count: 50, speed: 5, elevationGain: 80 });
    const reparsed = parseGpx(buildTrackGpx('Sortie test', pts));

    expect(reparsed.name).toBe('Sortie test');
    expect(reparsed.trackPoints).toHaveLength(50);
    expect(reparsed.trackPoints[10].lat).toBeCloseTo(pts[10].lat, 6);
    expect(reparsed.trackPoints[10].ele).toBeCloseTo(pts[10].ele!, 1);
    expect(reparsed.trackPoints[10].t).toBe(pts[10].t);
  });

  it('conserve les points d un circuit', () => {
    const route = [
      { lat: 45.1, lon: 3.1, ele: 300 },
      { lat: 45.2, lon: 3.2, ele: 420 },
    ];
    const back = parseGpx(buildRouteGpx('Boucle du lac', route));
    expect(back.routePoints).toHaveLength(2);
    expect(back.routePoints[1].ele).toBe(420);
  });

  it('echappe les caracteres speciaux du nom', () => {
    const xml = buildRouteGpx('Bois & <Combes>', [{ lat: 45, lon: 3, ele: null }]);
    expect(xml).toContain('Bois &amp; &lt;Combes&gt;');
    expect(parseGpx(xml).name).toBe('Bois & <Combes>');
  });
});
