/** Un point brut issu du GPS ou d'un fichier GPX. */
export interface TrackPoint {
  /** Latitude en degrés décimaux (WGS84). */
  lat: number;
  /** Longitude en degrés décimaux (WGS84). */
  lon: number;
  /** Altitude ellipsoïdale ou barométrique en mètres. `null` si inconnue. */
  ele: number | null;
  /** Horodatage epoch en millisecondes. */
  t: number;
  /** Précision horizontale annoncée par le GPS, en mètres. */
  acc?: number;
  /** Vitesse instantanée en m/s fournie par le récepteur (effet Doppler). */
  speed?: number | null;
}

/** Point d'un circuit dessiné à la main : pas d'horodatage, altitude optionnelle. */
export interface RoutePoint {
  lat: number;
  lon: number;
  ele: number | null;
}

/** Une sortie enregistrée. */
export interface Track {
  id: string;
  name: string;
  /** Date de départ (epoch ms). */
  startedAt: number;
  points: TrackPoint[];
  /** Métriques figées au moment de la sauvegarde, pour ne pas recalculer à chaque affichage. */
  metrics: TrackMetrics;
  source: 'recorded' | 'imported';
}

/** Un circuit créé ou importé, destiné à être suivi. */
export interface Route {
  id: string;
  name: string;
  createdAt: number;
  points: RoutePoint[];
  /** Distance cumulée à chaque point, en mètres. Longueur identique à `points`. */
  cumDist: number[];
  distance: number;
  ascent: number;
  descent: number;
  /** true si le dernier point rejoint le premier (boucle). */
  loop: boolean;
}

export interface TrackMetrics {
  /** Distance totale en mètres. */
  distance: number;
  /** Dénivelé positif filtré, en mètres. */
  ascent: number;
  /** Dénivelé négatif filtré, en mètres (valeur positive). */
  descent: number;
  /** Durée totale entre le premier et le dernier point, en ms. */
  duration: number;
  /** Durée en mouvement (vitesse au-dessus du seuil d'arrêt), en ms. */
  movingTime: number;
  /** Vitesse moyenne sur la durée totale, en m/s. */
  avgSpeed: number;
  /** Vitesse moyenne sur le temps en mouvement, en m/s. */
  avgMovingSpeed: number;
  /** Vitesse maximale retenue après filtrage des aberrations, en m/s. */
  maxSpeed: number;
  /** Altitude minimale et maximale après lissage, en mètres. */
  minEle: number | null;
  maxEle: number | null;
  /** Pente moyenne des sections en montée, en pourcentage. */
  avgClimbGrade: number;
}

/** Un kilomètre (ou mile) découpé, pour le tableau des temps intermédiaires. */
export interface Split {
  index: number;
  /** Distance réelle du segment, en mètres (le dernier peut être partiel). */
  distance: number;
  /** Durée du segment en ms. */
  duration: number;
  /** Vitesse moyenne du segment en m/s. */
  speed: number;
  ascent: number;
  descent: number;
}
