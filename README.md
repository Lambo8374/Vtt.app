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
npm test           # 86 tests unitaires sur le moteur de calcul
npm run build      # bundle de production dans dist/
```

La géolocalisation exige une origine sécurisée : `localhost` en développement,
**HTTPS** en production. Servi en HTTP sur une IP de réseau local, le navigateur
refuse l'accès à la position — l'application le signale explicitement plutôt que
de rester muette.

## Ce que fait l'application

**Rouler** — enregistrement en direct avec vitesse instantanée, distance,
dénivelé et temps en mouvement. Un circuit peut être suivi en parallèle :
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

## Limites connues

**L'enregistrement s'arrête quand l'écran s'éteint.** C'est la limite
structurelle d'une application web : aucune API ne permet de maintenir le suivi
GPS en arrière-plan sur iOS. L'application demande un verrou d'écran et
avertit lorsqu'il n'est pas obtenu. Lever cette limite suppose un portage natif
(Capacitor et un greffon de géolocalisation en arrière-plan) — c'est pourquoi
`src/core/` ne dépend ni de React ni du DOM : le moteur se réutilise tel quel.

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
src/hooks/      géolocalisation, verrou d'écran, enregistrement
src/components/ carte, profil altimétrique, tuiles de mesures
src/screens/    Rouler, Créer, Mes traces, détail d'une sortie
tests/          86 tests, témoins des méthodes naïves inclus
```

Les mesures sont en unités SI dans tout le moteur (mètres, m/s, millisecondes).
La conversion pour l'affichage est isolée dans `src/core/format.ts`.
