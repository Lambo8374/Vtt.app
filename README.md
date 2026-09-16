# Vtt.app

Application web de circuits VTT : enregistrer une sortie, suivre une trace
existante, créer un circuit. Distance, vitesse et dénivelé sont calculés à
partir du signal GPS du téléphone.

Elle fonctionne hors connexion une fois installée, et ne transmet aucune donnée :
les sorties restent dans le navigateur de l'appareil.

## Démarrer

```bash
npm install
npm run dev        # développement
npm test           # 95 tests unitaires sur le moteur de calcul
npm run build      # bundle de production dans dist/
npm run test:e2e   # maintien de l'écran, dans un vrai navigateur
```

**Cible : Android.** Voir « Installer sur Android » ci-dessous.

La géolocalisation exige une origine sécurisée : `localhost` en développement,
**HTTPS** en production. Servi en HTTP sur une IP de réseau local, le navigateur
refuse l'accès à la position — l'application le signale explicitement plutôt que
de rester muette.

## Installer sur Android

L'application est publiée automatiquement sur GitHub Pages à chaque poussée, à
l'adresse **https://lambo8374.github.io/Vtt.app/**

### La publication

Le déploiement se lance à chaque poussée et prend deux à trois minutes. Il
construit, lance les 95 tests unitaires et vérifie le maintien de l'écran dans
un vrai navigateur avant de publier : une régression n'est jamais mise en ligne.
Pages est activé automatiquement au premier passage.

Pour relancer une publication sans rien modifier : onglet `Actions` →
`Déploiement` → `Run workflow`.

### Sur le téléphone

1. Ouvrir **https://lambo8374.github.io/Vtt.app/** dans **Chrome**.
2. Menu `⋮` → **Ajouter à l'écran d'accueil** (ou **Installer l'application**).
3. Lancer l'application depuis l'icône : elle s'ouvre en plein écran, sans
   barre d'adresse.
4. Onglet **Rouler** → `Démarrer` : Chrome demande l'accès à la position.
   Choisir **Pendant l'utilisation de l'application**.

### Vérifier que tout est en place

Au démarrage d'une sortie, deux pastilles doivent être vertes en haut du
panneau : **Signal bon** et **Écran maintenu**. Si la seconde est rouge, voir
« Maintien de l'écran ».

### Réglages Android recommandés

Ces deux réglages conditionnent la qualité des traces :

- **Économiseur de batterie** : `Paramètres` → `Applications` → `Chrome` →
  `Batterie` → **Sans restriction**. C'est de loin la cause la plus fréquente
  d'un verrou d'écran refusé.
- **Position** : `Paramètres` → `Localisation` → `Services de localisation` →
  **Précision de la position Google** activée. Sans cela, la précision se
  dégrade nettement sous couvert forestier.

### Avant la première sortie hors réseau

Le cache ne contient que les fonds de carte déjà affichés. Parcourez la zone de
votre circuit sur la carte, en zoomant aux niveaux que vous utiliserez, pendant
que vous avez du réseau. Les tuiles consultées restent ensuite disponibles hors
connexion.

### Vos données

Tout reste sur le téléphone, dans le stockage du navigateur : rien n'est envoyé
à un serveur. Exportez vos sorties en GPX pour les conserver ailleurs. Effacer
les données de site de Chrome, ou désinstaller l'application, supprime les
sorties enregistrées.

Le site publié est public, mais il ne contient que l'application : aucune trace
n'y transite.

## Ce que fait l'application

**Rouler** — enregistrement en direct avec vitesse instantanée, distance,
dénivelé et temps en mouvement. L'écran est maintenu allumé pendant toute la
sortie, pause comprise. Un circuit peut être suivi en parallèle :
avancement, distance et dénivelé restants, alerte de sortie de trace et de
demi-tour. Une pause ouvre un nouveau tronçon, de sorte qu'un retour en navette
n'est pas comptabilisé.

**Créer** — le circuit se dessine en touchant la carte. Les segments se calent
sur les chemins existants via BRouter (profils VTT, randonnée, route), qui
fournit aussi l'altitude. En cas d'échec, le segment est tracé en ligne droite
et l'application le dit. Les altitudes manquantes peuvent être complétées depuis
un modèle numérique de terrain.

**Mes traces** — import et export GPX, profil altimétrique interactif, temps
par kilomètre.

## La fiabilité des chiffres

C'est le cœur du problème, et la raison d'être du dossier `src/core/`. Les
mesures ci-dessous proviennent de traces synthétiques bruitées à ±8 m, l'ordre
de grandeur d'un téléphone ; elles sont reproductibles par `npm test`.

### Dénivelé

Sommer naïvement les écarts d'altitude positifs donne **9 400 m de D+ sur un
parcours plat d'une heure**. Le signal oscille, et chaque oscillation est
comptée comme une montée.

Le traitement applique un filtre médian (qui supprime les pics isolés sans les
étaler), puis une moyenne glissante, puis une hystérésis : une variation n'est
comptée qu'au-delà d'un seuil. Résultat : **moins de 25 m de D+ fantôme par
heure sur le plat**, et une montée réelle de 400 m restituée à 3 % près.

Les réglages par défaut viennent d'une recherche sur grille arbitrant entre
trois scénarios — plat, montée longue, bosses courtes. Ils sous-estiment les
bosses courtes d'environ 25 %. Ce compromis est structurel : à ±8 m de bruit,
une bosse de 15 m d'amplitude n'est pas séparable du bruit sans perdre de
l'amplitude. **Seul un baromètre le lève vraiment** — c'est la raison pour
laquelle les montres GPS en embarquent un.

### Distance

La somme brute des segments **surestime de 24 %** : deux mesures successives
distantes de 5 m avec 4 m de bruit décrivent un zigzag, pas une ligne droite.

Le traitement enchaîne trois étapes : rejet des points trop imprécis ou
impossibles, lissage de Kalman pondéré par la précision annoncée par le
récepteur, puis détection d'arrêt. L'écart tombe à **+2 à +4 %**.

Une base d'accumulation minimale a été essayée pour corriger le reste. Elle
ramène l'erreur du rectiligne de +3,9 % à +0,2 %, mais **dégrade les lacets
serrés de −7 % à −16 %** : le pire cas empire. Elle a donc été écartée, et la
mesure est consignée dans `src/core/metrics.ts` pour éviter qu'on la
réintroduise.

### Arrêts

Un récepteur immobile pendant dix minutes « parcourt » plus de 2 km. Un seuil
sur la longueur d'un segment ne suffit pas : à l'arrêt sous couvert forestier,
deux mesures peuvent être distantes de 8 m.

Le critère retenu est le rapport entre le déplacement net sur une fenêtre et le
chemin parcouru dans cette fenêtre. À l'arrêt il s'effondre ; en mouvement il
reste proche de 1. C'est insensible à l'amplitude du bruit, contrairement à un
seuil absolu.

### Cohérence

La somme des dénivelés par kilomètre est **exactement** égale au dénivelé total.
Ce n'est pas automatique : relancer l'hystérésis sur chaque tranche repart d'une
altitude de référence neuve et produit un écart que l'utilisateur constate en
additionnant la colonne. Les deux chiffres partagent la même passe de calcul.

## Suivi de trace

Chercher naïvement le point le plus proche du circuit fait sauter la progression
dès qu'une portion en croise une autre. Le recalage se limite donc à une fenêtre
autour de la position précédente.

Sur un aller-retour emprunté dans les deux sens, les deux branches se
superposent exactement : l'écart latéral ne les distingue pas. Le cap de
déplacement sert alors à départager, par une pénalité appliquée au choix du
segment — jamais à l'écart renvoyé, pour ne pas déclencher de fausse alerte de
sortie de trace.

## Maintien de l'écran

Si l'écran s'éteint, le navigateur suspend `watchPosition` et la trace est
coupée. Le maintien de l'écran n'est donc pas un confort mais la condition pour
que l'enregistrement soit exploitable.

**Aucune API web ne permet de forcer l'écran allumé.** Le navigateur peut
refuser le verrou — batterie faible, économiseur d'énergie — et le système peut
le reprendre à tout moment. Ce qui est fait, et qui suffit en pratique sur
Android :

- le verrou est demandé dès le départ et **maintenu pendant les pauses**, une
  pause au sommet étant justement un moment où l'écran s'éteindrait ;
- il est **repris immédiatement** dès qu'il est perdu, sans attendre : le
  système le révoque régulièrement, et laisser passer dix secondes suffit à ce
  que l'écran s'éteigne ;
- il est repris au retour de visibilité — il est systématiquement perdu quand on
  change d'application — et un chien de garde toutes les dix secondes rattrape
  les révocations silencieuses ;
- sur un navigateur sans l'API (Android ancien), un repli par lecture vidéo
  prend le relais. Il est annoncé comme secours, sans prétendre à la même
  fiabilité ;
- l'état réel est affiché en permanence à côté de la qualité du signal. **Un
  verrou refusé se voit pendant qu'il est encore possible d'y remédier**, et non
  à l'arrivée devant une trace coupée en deux.

Le réglage se désactive dans l'onglet Rouler, avec un avertissement explicite.

Sur Android, l'API Screen Wake Lock couvre Chrome, Edge, Samsung Internet et
Firefox récents. Si le verrou est malgré tout refusé, la cause est presque
toujours l'économiseur de batterie : il faut l'exclure pour le navigateur et
allonger le délai de mise en veille de l'écran.

Ces comportements sont vérifiés dans un vrai navigateur par `npm run test:e2e`,
qui simule une révocation par le système et un refus — deux cas impossibles à
provoquer autrement, et invisibles aux tests unitaires.

## Limites connues

**L'enregistrement dépend de l'écran allumé.** C'est la contrainte d'une
application web : le relevé GPS s'arrête si l'écran s'éteint malgré le verrou.
Sur Android le verrou tient en pratique, mais un économiseur de batterie agressif
peut le reprendre — d'où l'indicateur permanent. Sur iOS, le suivi s'arrête de
toute façon au verrouillage, sans recours. S'affranchir complètement de cette
contrainte suppose un portage natif (Capacitor et un greffon de géolocalisation
en arrière-plan) : `src/core/` ne dépend ni de React ni du DOM précisément pour
que le moteur se réutilise alors tel quel.

**Le dénivelé vient du GPS, pas d'un baromètre.** Voir plus haut : attendre
mieux que ±10 % sur une sortie vallonnée n'est pas réaliste.

**Les fonds de carte sont des services communautaires.** Leurs conditions
d'usage interdisent le téléchargement en masse. Le cache hors-ligne ne conserve
que les tuiles réellement affichées et reste plafonné (`public/sw.js`).

**Le calage sur les chemins et les altitudes dépendent de services publics
gratuits** (BRouter, OpenTopoData), sans garantie de disponibilité ni de débit.
L'application retombe toujours sur un comportement dégradé annoncé, jamais sur
une valeur inventée.

## Organisation

```
src/core/       moteur de calcul, sans React ni DOM, entièrement testé
  geo.ts        distances, caps, projection sur segment
  filters.ts    filtres médian et de Kalman, hystérésis, détection d'arrêt
  metrics.ts    métriques de sortie, tranches, agrégation des tronçons
  follow.ts     suivi de trace et recalage
  route.ts      construction et densification des circuits
  gpx.ts        lecture et écriture GPX, sans dépendance au DOM
  elevation.ts  modèle numérique de terrain
  routing.ts    calage sur les chemins
  db.ts         stockage IndexedDB
src/hooks/      géolocalisation, maintien de l'écran, enregistrement
src/components/ carte, profil altimétrique, tuiles de mesures
src/screens/    Rouler, Créer, Mes traces, détail d'une sortie
tests/          95 tests, témoins des méthodes naïves inclus
e2e/            maintien de l'écran, vérifié dans un vrai navigateur
```

Les mesures sont en unités SI dans tout le moteur (mètres, m/s, millisecondes).
La conversion pour l'affichage est isolée dans `src/core/format.ts`.
