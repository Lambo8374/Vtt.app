import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import type { LatLon } from '../core/geo';
import { boundsOf } from '../core/geo';

/**
 * Fonds de carte disponibles.
 *
 * Les tuiles proviennent de services communautaires dont les conditions
 * d'usage interdisent le téléchargement massif : le cache hors-ligne ne
 * conserve que les tuiles réellement affichées, et le préchargement d'une zone
 * est plafonné (voir `src/core/tiles.ts`).
 */
export const BASEMAPS = {
  osm: {
    label: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; contributeurs OpenStreetMap',
    maxZoom: 19,
  },
  topo: {
    label: 'OpenTopoMap (relief)',
    url: 'https://tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap, SRTM | rendu OpenTopoMap (CC-BY-SA)',
    maxZoom: 17,
  },
  cyclosm: {
    label: 'CyclOSM (vélo)',
    url: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
    attribution: '&copy; contributeurs OpenStreetMap | rendu CyclOSM',
    maxZoom: 18,
  },
} as const;

export type BasemapKey = keyof typeof BASEMAPS;

export interface MapViewProps {
  basemap: BasemapKey;
  /** Trace enregistrée, dessinée en rouge. */
  track?: LatLon[];
  /** Circuit à suivre ou en cours d’édition, dessiné en bleu. */
  route?: LatLon[];
  /** Sommets manipulables du circuit en edition. */
  vertices?: LatLon[];
  position?: LatLon | null;
  /** Cap du cycliste, en degrés, pour orienter le marqueur. */
  heading?: number | null;
  /** Rayon de précision affiché autour de la position, en mètres. */
  accuracy?: number | null;
  /** Recentre la carte sur la trace à chaque changement de cette clé. */
  fitKey?: string | number;
  /** Suit la position au lieu de laisser la carte libre. */
  followPosition?: boolean;
  onMapClick?: (p: LatLon) => void;
  onVertexDrag?: (index: number, p: LatLon) => void;
  onVertexClick?: (index: number) => void;
  /** Affiche un bouton de recentrage sur la position actuelle. */
  showLocate?: boolean;
}

export function MapView(props: MapViewProps) {
  const holder = useRef<HTMLDivElement>(null);
  const [locating, setLocating] = useState(false);
  const map = useRef<L.Map | null>(null);
  const tiles = useRef<L.TileLayer | null>(null);
  const trackLine = useRef<L.Polyline | null>(null);
  const routeLine = useRef<L.Polyline | null>(null);
  const vertexLayer = useRef<L.LayerGroup | null>(null);
  const marker = useRef<L.Marker | null>(null);
  const accuracyRing = useRef<L.Circle | null>(null);
  // Les callbacks sont lus via une référence : les réabonner à chaque rendu
  // provoquerait des fuites d'écouteurs sur la carte Leaflet.
  const handlers = useRef(props);
  handlers.current = props;

  useEffect(() => {
    if (!holder.current || map.current) return;
    const m = L.map(holder.current, { zoomControl: true, attributionControl: true }).setView([46.6, 2.5], 6);
    m.on('click', (e: L.LeafletMouseEvent) => {
      handlers.current.onMapClick?.({ lat: e.latlng.lat, lon: e.latlng.lng });
    });
    map.current = m;
    vertexLayer.current = L.layerGroup().addTo(m);
    // Leaflet mesure mal son conteneur quand il est monté masqué (onglet non
    // actif) : sans ce recalcul, la carte n'occupe qu'un coin de l'écran.
    setTimeout(() => m.invalidateSize(), 0);
    return () => {
      m.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const def = BASEMAPS[props.basemap];
    tiles.current?.remove();
    tiles.current = L.tileLayer(def.url, {
      attribution: def.attribution,
      maxZoom: def.maxZoom,
      crossOrigin: true,
    }).addTo(m);
  }, [props.basemap]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const latlngs = (props.track ?? []).map((p) => [p.lat, p.lon] as [number, number]);
    if (!trackLine.current) {
      trackLine.current = L.polyline(latlngs, { color: '#e2483d', weight: 4, opacity: 0.9 }).addTo(m);
    } else {
      trackLine.current.setLatLngs(latlngs);
    }
  }, [props.track]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const latlngs = (props.route ?? []).map((p) => [p.lat, p.lon] as [number, number]);
    if (!routeLine.current) {
      routeLine.current = L.polyline(latlngs, { color: '#2563eb', weight: 4, opacity: 0.85, dashArray: '1 0' }).addTo(m);
    } else {
      routeLine.current.setLatLngs(latlngs);
    }
  }, [props.route]);

  useEffect(() => {
    const group = vertexLayer.current;
    if (!group) return;
    group.clearLayers();
    (props.vertices ?? []).forEach((v, i) => {
      const handle = L.circleMarker([v.lat, v.lon], {
        radius: 7,
        color: '#1d4ed8',
        fillColor: '#ffffff',
        fillOpacity: 1,
        weight: 3,
      });
      handle.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        handlers.current.onVertexClick?.(i);
      });
      // `circleMarker` n'est pas déplaçable : on suit le pointeur à la main
      // pour éviter d'ajouter une dépendance de glisser-déposer.
      handle.on('mousedown', () => {
        const m = map.current;
        if (!m || !handlers.current.onVertexDrag) return;
        m.dragging.disable();
        const move = (ev: L.LeafletMouseEvent) => handle.setLatLng(ev.latlng);
        const up = (ev: L.LeafletMouseEvent) => {
          m.off('mousemove', move);
          m.off('mouseup', up);
          m.dragging.enable();
          handlers.current.onVertexDrag?.(i, { lat: ev.latlng.lat, lon: ev.latlng.lng });
        };
        m.on('mousemove', move);
        m.on('mouseup', up);
      });
      group.addLayer(handle);
    });
  }, [props.vertices]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const p = props.position;
    if (!p) {
      marker.current?.remove();
      marker.current = null;
      accuracyRing.current?.remove();
      accuracyRing.current = null;
      return;
    }
    const icon = L.divIcon({
      className: 'position-marker',
      html: `<div class="position-arrow" style="transform: rotate(${props.heading ?? 0}deg)"></div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    });
    if (!marker.current) marker.current = L.marker([p.lat, p.lon], { icon, interactive: false }).addTo(m);
    else {
      marker.current.setLatLng([p.lat, p.lon]);
      marker.current.setIcon(icon);
    }

    // Le cercle de précision évite d'interpréter une position approximative
    // comme une position exacte, notamment sous couvert forestier.
    if (props.accuracy != null && props.accuracy > 0) {
      if (!accuracyRing.current) {
        accuracyRing.current = L.circle([p.lat, p.lon], {
          radius: props.accuracy,
          color: '#2563eb',
          weight: 1,
          fillOpacity: 0.08,
          interactive: false,
        }).addTo(m);
      } else {
        accuracyRing.current.setLatLng([p.lat, p.lon]);
        accuracyRing.current.setRadius(props.accuracy);
      }
    }
    if (props.followPosition) m.setView([p.lat, p.lon], Math.max(m.getZoom(), 15), { animate: true });
  }, [props.position, props.heading, props.accuracy, props.followPosition]);

  useEffect(() => {
    const m = map.current;
    if (!m || props.fitKey === undefined) return;
    const all = [...(props.track ?? []), ...(props.route ?? [])];
    const b = boundsOf(all);
    if (!b) return;
    m.fitBounds(
      [
        [b.minLat, b.minLon],
        [b.maxLat, b.maxLon],
      ],
      { padding: [30, 30], maxZoom: 16 },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.fitKey]);

  /**
   * Recentre la carte sur la position actuelle.
   *
   * Sans ce bouton, creer un circuit commence par une vue du monde entier :
   * retrouver son point de depart a la main est le premier obstacle de
   * l'application, et le plus inutile.
   */
  const locate = () => {
    if (!('geolocation' in navigator)) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        map.current?.setView([pos.coords.latitude, pos.coords.longitude], 15);
      },
      () => setLocating(false),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 30_000 },
    );
  };

  return (
    <div className="map-holder">
      <div ref={holder} className="map" />
      {props.showLocate && (
        <button
          type="button"
          className="map-locate"
          onClick={locate}
          disabled={locating}
          aria-label="Centrer la carte sur ma position"
          title="Centrer sur ma position"
        >
          {locating ? '…' : '◎'}
        </button>
      )}
    </div>
  );
}
