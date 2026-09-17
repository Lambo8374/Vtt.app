import { useEffect, useRef, useState } from 'react';
import type { TrackPoint } from '../core/types';

export type GeoStatus =
  | 'idle'
  | 'unsupported'
  | 'insecure'
  | 'acquiring'
  | 'active'
  | 'denied'
  | 'error';

export interface GeoState {
  status: GeoStatus;
  /** Dernière position reçue, déjà convertie au format interne. */
  point: TrackPoint | null;
  /** Cap fourni par le récepteur, en degrés, quand il est disponible. */
  heading: number | null;
  message: string | null;
}

/**
 * Abonnement continu à la position.
 *
 * `watchPosition` est utilise plutôt qu'un `getCurrentPosition` périodique :
 * le récepteur reste alors alimenté entre deux mesures, ce qui évite de payer
 * une réacquisition de plusieurs secondes à chaque point et donne une cadence
 * regulière.
 *
 * Limite structurelle : sur iOS, le suivi s'interrompt des que l'écran se
 * verrouille. Aucune API web ne permet de la contourner ; seul un portage natif
 * (Capacitor, plugin de géolocalisation en arrière-plan) y répond.
 */
export function useGeolocation(active: boolean): GeoState {
  const [state, setState] = useState<GeoState>({
    status: 'idle',
    point: null,
    heading: null,
    message: null,
  });
  // Évite de recréer le callback à chaque rendu, ce qui relancerait le watch.
  const watchId = useRef<number | null>(null);

  useEffect(() => {
    if (!active) {
      if (watchId.current != null) {
        navigator.geolocation.clearWatch(watchId.current);
        watchId.current = null;
      }
      setState((s) => ({ ...s, status: 'idle' }));
      return;
    }

    if (!('geolocation' in navigator)) {
      setState({ status: 'unsupported', point: null, heading: null, message: 'Géolocalisation indisponible sur cet appareil.' });
      return;
    }
    // La géolocalisation exige une origine sécurisée : sans ce message, l'échec
    // en test sur réseau local serait incompréhensible.
    if (!window.isSecureContext) {
      setState({
        status: 'insecure',
        point: null,
        heading: null,
        message: "La géolocalisation exige HTTPS (ou localhost). L'application doit être servie en HTTPS.",
      });
      return;
    }

    setState((s) => ({ ...s, status: 'acquiring', message: null }));
    watchId.current = navigator.geolocation.watchPosition(
      (pos) => {
        const c = pos.coords;
        setState({
          status: 'active',
          point: {
            lat: c.latitude,
            lon: c.longitude,
            ele: c.altitude != null && Number.isFinite(c.altitude) ? c.altitude : null,
            t: pos.timestamp,
            acc: c.accuracy,
            speed: c.speed != null && Number.isFinite(c.speed) ? c.speed : null,
          },
          heading: c.heading != null && Number.isFinite(c.heading) ? c.heading : null,
          message: null,
        });
      },
      (err) => {
        const denied = err.code === err.PERMISSION_DENIED;
        setState((s) => ({
          ...s,
          status: denied ? 'denied' : 'error',
          message: denied
            ? "Acces à la position refuse. Autorisez-le dans les réglages du navigateur."
            : `Position indisponible : ${err.message}`,
        }));
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 },
    );

    return () => {
      if (watchId.current != null) {
        navigator.geolocation.clearWatch(watchId.current);
        watchId.current = null;
      }
    };
  }, [active]);

  return state;
}
