import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { draftStore, trackStore } from '../core/db';
import { newId } from '../core/id';
import { computeSegments } from '../core/metrics';
import type { ComputedTrack } from '../core/metrics';
import type { Track, TrackPoint } from '../core/types';

export type RecorderStatus = 'idle' | 'recording' | 'paused';

export interface Draft {
  id: string;
  name: string;
  startedAt: number;
  segments: TrackPoint[][];
}

/**
 * Recalcul complet au plus toutes les `RECOMPUTE_MS`.
 *
 * Le calcul est en O(n) : sur une sortie de trois heures à 1 Hz, soit environ
 * 10 000 points, il coûte quelques dizaines de millisecondes. Le refaire a
 * chaque point rendrait l'affichage saccadé en fin de sortie, alors qu'une
 * actualisation toutes les deux secondes est imperceptible à vélo.
 */
const RECOMPUTE_MS = 2000;

/** Sauvegarde de secours : au-delà, une coupure ferait perdre trop de trace. */
const AUTOSAVE_MS = 15_000;

export interface Recorder {
  status: RecorderStatus;
  computed: ComputedTrack;
  pointCount: number;
  start: () => void;
  pause: () => void;
  resume: () => void;
  /** Enregistre la sortie et renvoie son identifiant, ou null si elle est vide. */
  save: (name: string) => Promise<string | null>;
  discard: () => Promise<void>;
  /** Brouillon retrouvé au démarrage, à reprendre ou à jeter. */
  recovered: Draft | null;
  resumeRecovered: () => void;
  dismissRecovered: () => Promise<void>;
}

export function useRecorder(incoming: TrackPoint | null): Recorder {
  const [status, setStatus] = useState<RecorderStatus>('idle');
  const [segments, setSegments] = useState<TrackPoint[][]>([]);
  const [version, setVersion] = useState(0);
  const [recovered, setRecovered] = useState<Draft | null>(null);
  const draftId = useRef<string>(newId());
  const startedAt = useRef<number>(0);
  const lastTimestamp = useRef<number>(0);
  const lastRecompute = useRef(0);
  const lastAutosave = useRef(0);

  // Un brouillon subsiste après une fermeture inopinée : on propose de reprendre
  // plutôt que de perdre la sortie en cours.
  useEffect(() => {
    void draftStore.load<Draft>().then((d) => {
      if (d && d.segments.some((s) => s.length > 0)) setRecovered(d);
    });
  }, []);

  useEffect(() => {
    if (status !== 'recording' || !incoming) return;
    // Le même point peut être re-émis : sans ce garde-fou il serait compte deux
    // fois et gonflerait la durée à l'arrêt.
    if (incoming.t <= lastTimestamp.current) return;
    lastTimestamp.current = incoming.t;

    setSegments((prev) => {
      const next = prev.length === 0 ? [[]] : prev.slice();
      next[next.length - 1] = [...next[next.length - 1], incoming];
      return next;
    });

    const now = Date.now();
    if (now - lastRecompute.current > RECOMPUTE_MS) {
      lastRecompute.current = now;
      setVersion((v) => v + 1);
    }
  }, [incoming, status]);

  useEffect(() => {
    if (status === 'idle' || segments.length === 0) return;
    const now = Date.now();
    if (now - lastAutosave.current < AUTOSAVE_MS) return;
    lastAutosave.current = now;
    void draftStore
      .save({ id: draftId.current, name: '', startedAt: startedAt.current, segments })
      .catch(() => undefined);
  }, [segments, status]);

  const computed = useMemo(
    () => computeSegments(segments),
    // `version` cadence le recalcul ; `segments` change à chaque point reçu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, status],
  );

  const start = useCallback(() => {
    draftId.current = newId();
    startedAt.current = Date.now();
    lastTimestamp.current = 0;
    setSegments([[]]);
    setStatus('recording');
    setVersion((v) => v + 1);
  }, []);

  const pause = useCallback(() => {
    setStatus('paused');
    setVersion((v) => v + 1);
  }, []);

  const resume = useCallback(() => {
    // Un nouveau tronçon isolé le déplacement éventuel pendant la pause.
    setSegments((prev) => [...prev, []]);
    lastTimestamp.current = 0;
    setStatus('recording');
  }, []);

  const save = useCallback(
    async (name: string) => {
      const result = computeSegments(segments);
      if (result.points.length < 2) return null;
      const track: Track = {
        id: draftId.current,
        name: name.trim() || `Sortie du ${new Date(startedAt.current).toLocaleDateString('fr-FR')}`,
        startedAt: startedAt.current || result.points[0].t,
        points: result.points,
        metrics: result.metrics,
        source: 'recorded',
      };
      await trackStore.put(track);
      await draftStore.clear();
      setSegments([]);
      setStatus('idle');
      return track.id;
    },
    [segments],
  );

  const discard = useCallback(async () => {
    await draftStore.clear();
    setSegments([]);
    setStatus('idle');
  }, []);

  const resumeRecovered = useCallback(() => {
    if (!recovered) return;
    draftId.current = recovered.id;
    startedAt.current = recovered.startedAt;
    lastTimestamp.current = 0;
    // Le brouillon repris ouvre son propre tronçon : la coupure est une pause.
    setSegments([...recovered.segments, []]);
    setStatus('paused');
    setRecovered(null);
    setVersion((v) => v + 1);
  }, [recovered]);

  const dismissRecovered = useCallback(async () => {
    await draftStore.clear();
    setRecovered(null);
  }, []);

  return {
    status,
    computed,
    pointCount: segments.reduce((a, s) => a + s.length, 0),
    start,
    pause,
    resume,
    save,
    discard,
    recovered,
    resumeRecovered,
    dismissRecovered,
  };
}
