import { useEffect, useRef, useState } from 'react';

/**
 * Maintient l'écran allumé pendant l'enregistrement.
 *
 * Ce n'est pas un confort mais une nécessité : sur une PWA, l'extinction de
 * l'écran suspend `watchPosition` et troue la trace. Le verrou est perdu a
 * chaque passage en arrière-plan, d’où la réacquisition au retour de
 * visibilité.
 */
export function useWakeLock(active: boolean): { held: boolean; supported: boolean } {
  const sentinel = useRef<WakeLockSentinel | null>(null);
  const [held, setHeld] = useState(false);
  const supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;

  useEffect(() => {
    if (!active || !supported) {
      setHeld(false);
      return;
    }
    let cancelled = false;

    const acquire = async () => {
      try {
        const lock = await navigator.wakeLock.request('screen');
        if (cancelled) {
          void lock.release();
          return;
        }
        sentinel.current = lock;
        setHeld(true);
        lock.addEventListener('release', () => setHeld(false));
      } catch {
        // Refus possible si la batterie est faible : l'enregistrement continue.
        setHeld(false);
      }
    };

    const onVisible = () => {
      if (document.visibilityState === 'visible' && sentinel.current?.released !== false) void acquire();
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void sentinel.current?.release().catch(() => undefined);
      sentinel.current = null;
      setHeld(false);
    };
  }, [active, supported]);

  return { held, supported };
}
