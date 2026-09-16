/** Un point brut issu du GPS ou d'un fichier GPX. */
export interface TrackPoint {
  /** Latitude en degres decimaux (WGS84). */
  lat: number;
  /** Longitude en degres decimaux (WGS84). */
  lon: number;
  /** Altitude ellipsoidale ou barometrique en metres. `null` si inconnue. */
  ele: number | null;
  /** Horodatage epoch en millisecondes. */
  t: number;
  /** Precision horizontale annoncee par le GPS, en metres. */
  acc?: number;
  /** Vitesse instantanee en m/s fournie par le recepteur (effet Doppler). */
  speed?: number | null;
}

/** Point d'un circuit dessine a la main : pas d'horodatage, altitude optionnelle. */
export interface RoutePoint {
  lat: number;
  lon: number;
  ele: number | null;
}

/** Une sortie enregistree. */
export interface Track {
  id: string;
  name: string;
  /** Date de depart (epoch ms). */
  startedAt: number;
  points: TrackPoint[];
  /** Metriques figees au moment de la sauvegarde, pour ne pas recalculer a chaque affichage. */
  metrics: TrackMetrics;
  source: 'recorded' | 'imported';
}

/** Un circuit cree ou importe, destine a etre suivi. */
export interface Route {
  id: string;
  name: string;
  createdAt: number;
  points: RoutePoint[];
  /** Distance cumulee a chaque point, en metres. Longueur identique a `points`. */
  cumDist: number[];
  distance: number;
  ascent: number;
  descent: number;
  /** true si le dernier point rejoint le premier (boucle). */
  loop: boolean;
}

export interface TrackMetrics {
  /** Distance totale en metres. */
  distance: number;
  /** Denivele positif filtre, en metres. */
  ascent: number;
  /** Denivele negatif filtre, en metres (valeur positive). */
  descent: number;
  /** Duree totale entre le premier et le dernier point, en ms. */
  duration: number;
  /** Duree en mouvement (vitesse au-dessus du seuil d'arret), en ms. */
  movingTime: number;
  /** Vitesse moyenne sur la duree totale, en m/s. */
  avgSpeed: number;
  /** Vitesse moyenne sur le temps en mouvement, en m/s. */
  avgMovingSpeed: number;
  /** Vitesse maximale retenue apres filtrage des aberrations, en m/s. */
  maxSpeed: number;
  /** Altitude minimale et maximale apres lissage, en metres. */
  minEle: number | null;
  maxEle: number | null;
  /** Pente moyenne des sections en montee, en pourcentage. */
  avgClimbGrade: number;
}

/** Un kilometre (ou mile) decoupe, pour le tableau des temps intermediaires. */
export interface Split {
  index: number;
  /** Distance reelle du segment, en metres (le dernier peut etre partiel). */
  distance: number;
  /** Duree du segment en ms. */
  duration: number;
  /** Vitesse moyenne du segment en m/s. */
  speed: number;
  ascent: number;
  descent: number;
}
