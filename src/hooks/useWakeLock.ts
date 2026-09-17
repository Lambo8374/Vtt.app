import { useCallback, useEffect, useRef, useState } from 'react';

export type WakeLockMethod = 'none' | 'wakeLock' | 'video';

export interface WakeLockState {
  /** true quand l'ecran est effectivement maintenu allume. */
  held: boolean;
  /** Moyen reellement utilise, pour ne pas annoncer plus que ce qui est actif. */
  method: WakeLockMethod;
  /** true si l'API native Screen Wake Lock existe sur cet appareil. */
  supported: boolean;
  /** Raison lisible du dernier echec, a afficher telle quelle. */
  reason: string | null;
}

/**
 * Intervalle du chien de garde qui verifie que le verrou tient toujours.
 *
 * Il ne sert que de filet : une perte du verrou declenche une reprise
 * immediate. Il rattrape les cas ou le systeme reprend le verrou sans emettre
 * d'evenement ni changer la visibilite.
 */
const WATCHDOG_MS = 10_000;

/**
 * Maintient l'ecran allume pendant la sortie.
 *
 * Sur une application web, l'extinction de l'ecran suspend `watchPosition` et
 * troue la trace : le maintien n'est pas un confort mais la condition pour que
 * l'enregistrement soit exploitable.
 *
 * Aucune API web ne permet de *forcer* l'ecran allume. Le navigateur peut
 * refuser le verrou — batterie faible, economiseur d'energie — et le systeme
 * peut le reprendre a tout moment. Ce module fait donc trois choses : demander
 * le verrou, le reprendre des qu'il est perdu, et exposer un etat exact pour
 * que l'interface n'affirme jamais un maintien qui n'a pas lieu.
 *
 * Le verrou est systematiquement perdu au passage en arriere-plan. La
 * reacquisition au retour de visibilite ne suffit pas : certains systemes le
 * revoquent sans changer la visibilite, d'ou le chien de garde periodique.
 *
 * Sur Android, l'API native couvre Chrome, Edge, Samsung Internet et Firefox
 * recents. Le repli video ne sert que sur les navigateurs plus anciens.
 */
export function useWakeLock(active: boolean): WakeLockState {
  const sentinel = useRef<WakeLockSentinel | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const painter = useRef<number | null>(null);
  // References lues depuis l'ecouteur de perte, qui survit au rendu courant.
  const activeRef = useRef(active);
  activeRef.current = active;
  const acquireRef = useRef<(() => Promise<void>) | null>(null);
  const [state, setState] = useState<WakeLockState>({
    held: false,
    method: 'none',
    supported: typeof navigator !== 'undefined' && 'wakeLock' in navigator,
    reason: null,
  });

  const stopVideo = useCallback(() => {
    if (painter.current != null) {
      clearInterval(painter.current);
      painter.current = null;
    }
    const el = video.current;
    if (el) {
      el.pause();
      (el.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop());
      el.srcObject = null;
      el.remove();
      video.current = null;
    }
  }, []);

  /**
   * Repli pour les navigateurs sans API : une video en lecture empeche la mise
   * en veille sur la plupart des systemes mobiles. Le flux provient d'un canevas
   * redessine en continu, ce qui evite d'embarquer un fichier video et garantit
   * que le flux reste actif.
   */
  const startVideoFallback = useCallback(async (): Promise<boolean> => {
    if (video.current) return true;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 2;
      canvas.height = 2;
      const ctx = canvas.getContext('2d');
      if (!ctx || typeof canvas.captureStream !== 'function') return false;

      let tick = 0;
      const paint = () => {
        // Un flux parfaitement statique peut etre suspendu par le navigateur :
        // on alterne la couleur pour qu'il continue de produire des trames.
        ctx.fillStyle = tick++ % 2 ? '#000' : '#010101';
        ctx.fillRect(0, 0, 2, 2);
      };
      paint();
      painter.current = window.setInterval(paint, 1000);

      const el = document.createElement('video');
      el.muted = true;
      el.defaultMuted = true;
      el.playsInline = true;
      el.loop = true;
      el.setAttribute('aria-hidden', 'true');
      // Une video en `display: none` n'est pas consideree comme lue : elle doit
      // rester dans le rendu, mais reduite a un pixel invisible.
      el.style.cssText =
        'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:-1';
      el.srcObject = canvas.captureStream(1);
      document.body.appendChild(el);
      video.current = el;

      await el.play();
      return !el.paused;
    } catch {
      stopVideo();
      return false;
    }
  }, [stopVideo]);

  const acquire = useCallback(async () => {
    if (document.visibilityState !== 'visible') return;

    if ('wakeLock' in navigator) {
      try {
        const lock = await navigator.wakeLock.request('screen');
        sentinel.current = lock;
        // Le systeme peut relacher le verrou de lui-meme : on enregistre la
        // perte pour que l'interface cesse aussitot d'annoncer le maintien.
        lock.addEventListener('release', () => {
          if (sentinel.current !== lock) return;
          sentinel.current = null;
          setState((s) => (s.method === 'wakeLock' ? { ...s, held: false } : s));
          // Reprise immediate plutot qu'a la prochaine passe du chien de garde :
          // laisser passer dix secondes suffit a ce que l'ecran s'eteigne. Si la
          // page vient de passer en arriere-plan, `acquire` renonce de lui-meme
          // et c'est le retour de visibilite qui prendra le relais.
          if (activeRef.current) void acquireRef.current?.();
        });
        stopVideo();
        setState((s) => ({ ...s, held: true, method: 'wakeLock', reason: null }));
        return;
      } catch (err) {
        const message = (err as Error).message || 'refus du navigateur';
        setState((s) => ({
          ...s,
          held: false,
          reason: `Maintien de l’écran refusé (${message}).`,
        }));
      }
    }

    const ok = await startVideoFallback();
    setState((s) => ({
      ...s,
      held: ok,
      method: ok ? 'video' : 'none',
      reason: ok ? null : 'Cet appareil ne permet pas de maintenir l’écran allumé.',
    }));
  }, [startVideoFallback, stopVideo]);

  acquireRef.current = acquire;

  useEffect(() => {
    if (!active) {
      void sentinel.current?.release().catch(() => undefined);
      sentinel.current = null;
      stopVideo();
      setState((s) => ({ ...s, held: false, method: 'none', reason: null }));
      return;
    }

    void acquire();

    // Le verrou est perdu a chaque passage en arriere-plan ; il faut le
    // reprendre au retour, y compris apres une restauration depuis le cache de
    // navigation (`pageshow`).
    const reacquire = () => {
      if (document.visibilityState !== 'visible') return;
      if (sentinel.current && !sentinel.current.released) return;
      if (video.current && !video.current.paused) return;
      void acquire();
    };

    document.addEventListener('visibilitychange', reacquire);
    window.addEventListener('pageshow', reacquire);
    window.addEventListener('focus', reacquire);
    const watchdog = window.setInterval(reacquire, WATCHDOG_MS);

    return () => {
      document.removeEventListener('visibilitychange', reacquire);
      window.removeEventListener('pageshow', reacquire);
      window.removeEventListener('focus', reacquire);
      clearInterval(watchdog);
      void sentinel.current?.release().catch(() => undefined);
      sentinel.current = null;
      stopVideo();
    };
  }, [active, acquire, stopVideo]);

  return state;
}
