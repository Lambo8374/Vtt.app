import { useCallback, useEffect, useState } from 'react';
import type { BasemapKey } from './components/MapView';
import { routeStore, trackStore } from './core/db';
import type { Route, Track } from './core/types';
import { LibraryScreen } from './screens/LibraryScreen';
import { RecordScreen } from './screens/RecordScreen';
import { RouteEditorScreen } from './screens/RouteEditorScreen';
import { TrackDetailScreen } from './screens/TrackDetailScreen';

type Tab = 'record' | 'create' | 'library';

const BASEMAP_KEY = 'vtt-app.basemap';

export function App() {
  const [tab, setTab] = useState<Tab>('record');
  const [tracks, setTracks] = useState<Track[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [openTrack, setOpenTrack] = useState<Track | null>(null);
  const [editingRoute, setEditingRoute] = useState<Route | null>(null);
  const [basemap, setBasemap] = useState<BasemapKey>(
    () => (localStorage.getItem(BASEMAP_KEY) as BasemapKey) || 'topo',
  );

  const refresh = useCallback(async () => {
    const [t, r] = await Promise.all([trackStore.all(), routeStore.all()]);
    setTracks(t);
    setRoutes(r);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    localStorage.setItem(BASEMAP_KEY, basemap);
  }, [basemap]);

  // L'écran de detail se superposé aux onglets : il a son propre bouton retour.
  if (openTrack) {
    return (
      <div className="app">
        <TrackDetailScreen track={openTrack} basemap={basemap} onBack={() => setOpenTrack(null)} />
      </div>
    );
  }

  return (
    <div className="app">
      {tab === 'record' && (
        <RecordScreen
          routes={routes}
          basemap={basemap}
          onBasemapChange={setBasemap}
          onSaved={() => {
            void refresh();
            setTab('library');
          }}
        />
      )}

      {tab === 'create' && (
        <RouteEditorScreen
          basemap={basemap}
          onBasemapChange={setBasemap}
          editing={editingRoute}
          onCancelEdit={() => {
            setEditingRoute(null);
            setTab('library');
          }}
          onSaved={() => {
            setEditingRoute(null);
            void refresh();
            setTab('library');
          }}
        />
      )}

      {tab === 'library' && (
        <LibraryScreen
          tracks={tracks}
          routes={routes}
          onRefresh={() => void refresh()}
          onOpenTrack={(id) => setOpenTrack(tracks.find((t) => t.id === id) ?? null)}
          onEditRoute={(r) => {
            setEditingRoute(r);
            setTab('create');
          }}
        />
      )}

      <nav className="tabbar">
        <TabButton current={tab} value="record" icon="⏱" label="Rouler" onSelect={setTab} />
        <TabButton
          current={tab}
          value="create"
          icon="✎"
          label="Créer"
          onSelect={(v) => {
            setEditingRoute(null);
            setTab(v);
          }}
        />
        <TabButton current={tab} value="library" icon="☰" label="Mes traces" onSelect={setTab} />
      </nav>
    </div>
  );
}

function TabButton({
  current,
  value,
  icon,
  label,
  onSelect,
}: {
  current: Tab;
  value: Tab;
  icon: string;
  label: string;
  onSelect: (t: Tab) => void;
}) {
  return (
    <button
      className="tabbar__item"
      aria-current={current === value ? 'page' : undefined}
      onClick={() => onSelect(value)}
    >
      <span className="tabbar__icon" aria-hidden="true">
        {icon}
      </span>
      {label}
    </button>
  );
}
