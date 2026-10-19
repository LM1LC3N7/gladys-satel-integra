# Satel Integra (ETHM-1) pour Gladys

Cette intégration relie une centrale d'alarme **Satel INTEGRA** (ou INTEGRA
Plus) à Gladys Assistant, **en local** sur votre réseau, par son module
**ETHM-1** ou **ETHM-1 Plus** et le protocole d'intégration publié par Satel.

> **Jamais testé avec un vrai appareil.** Le protocole vient de la
> bibliothèque [satel-integra](https://github.com/c-soft/satel_integra)
> 1.5.0 (celle de l'intégration Satel Integra de Home Assistant), portée en
> JavaScript et vérifiée seulement contre un module simulé. Faites vos
> premiers essais en présence, centrale désarmée, et signalez ce qui ne va
> pas.
>
> Intégration non officielle, sans lien avec SATEL.

## Avant de commencer

- Un module **ETHM-1** ou **ETHM-1 Plus** relié à la centrale, joignable
  depuis Gladys (donnez-lui une adresse fixe dans votre box).
- Dans DLOADX (par votre installateur) : **l'intégration activée** sur le
  module, son port (7094 par défaut) et, sur un ETHM-1 Plus, la **clé
  d'intégration** éventuelle.
- **Le module n'accepte qu'un seul client d'intégration à la fois** :
  arrêtez tout autre logiciel qui s'y connecte (Home Assistant, GUARDX, un
  autre Gladys). S'il est occupé, il répond « Busy » : l'intégration le dit
  et réessaie au plus tôt une minute plus tard.

## Ce que vous obtenez

- **Centrale Satel** : connectée ou non, défaut en cours, mode service.
- **Une partition par appareil** (nom repris de la centrale) :
  - **État** en lecture seule : désarmée, armement en cours (temporisation
    de sortie), armée (totale), armée (partielle, modes 1 à 3) ;
  - **Armée**, **Alarme en cours**, **Alarme incendie** ;
  - trois **boutons** : armement total, armement partiel, désarmer.
- **Une zone par appareil** (seulement celles que vous indiquez, nom repris
  de la centrale) : violée ou non (ouverture, mouvement, fumée ou fuite selon
  le type choisi), **autoprotection** (sabotage), alarme.
- **Une sortie par appareil** (seulement celles que vous indiquez) : active
  ou non, et deux **boutons** : activer, désactiver.
- **Déclencheurs de scène** : alarme déclenchée (avec la zone si la centrale
  la donne, et si c'est un incendie), partition armée (mode, demandé par
  Gladys ou non), partition désarmée.
- **Actions de scène** : armer (total ou partiel), désarmer.

Aucune commande n'est un interrupteur : un « éteins tout » d'un assistant
vocal, de HomeKit ou d'une scène ne peut ni désarmer l'alarme ni actionner
une sortie. Les états sont en lecture seule, les commandes sont des boutons.

## Configuration

1. **Adresse du module ETHM-1** : son adresse IP.
2. **Port d'intégration** : 7094, sauf changement dans DLOADX.
3. **Clé d'intégration (ETHM-1 Plus)** : seulement si une clé est réglée sur
   le module (12 caractères au plus). Voir « Ce qui circule sur le réseau ».
4. **Code utilisateur** (facultatif) : le code d'un utilisateur INTEGRA
   (4 à 16 chiffres, préfixe compris), nécessaire seulement aux commandes ;
   les états n'en ont pas besoin. Créez un utilisateur dédié, avec seulement
   les partitions et les droits utiles à Gladys.
5. **Partitions** : par exemple `1, 2` ou `1-4` (par défaut `1`).
6. **Zones** : par exemple `1-6, 7:motion, 9:smoke, 10:leak`. Types :
   `opening` (ouverture, par défaut), `motion` (mouvement), `smoke` (fumée),
   `leak` (fuite d'eau). Changer le type d'une zone déjà créée dans Gladys
   ajoute une nouvelle fonction et garde l'ancienne (et son historique) :
   supprimez l'ancienne à la main si vous n'en voulez plus.
7. **Sorties** (facultatif) : par exemple `3, 5-6`.
8. **Mode INTEGRA de « armement partiel »** : 1, 2 ou 3, selon ce que votre
   installateur a réglé (l'armement total est le mode 0).
9. **Sécurité** : voir plus bas.
10. **Langue des noms** : français ou anglais.

La clé d'intégration et le code utilisateur sont des champs secrets : gardés
par Gladys dans sa base, jamais réaffichés dans l'interface, utilisés
seulement avec le module. Ils n'apparaissent jamais dans les journaux ni dans
`/data`.

Le bouton **Tester la connexion** se connecte tout de suite si aucune
connexion n'est ouverte (sinon il attend celle en cours : le module n'accepte
qu'un client) et indique le modèle, l'état des partitions et le nombre de
zones et de sorties. Il n'envoie pas le code utilisateur.

Le bouton **Autoriser un nouvel essai du code** lève l'arrêt posé après un
code utilisateur refusé (voir « Sécurité ») : la prochaine commande enverra
de nouveau le code, une fois. Il n'envoie rien lui-même.

## Ce qui circule sur le réseau

- **ETHM-1, ou ETHM-1 Plus sans clé d'intégration : tout circule en clair**
  sur votre réseau local, y compris le code utilisateur à chaque commande.
  Tout appareil de votre réseau qui écoute le trafic peut le lire.
- **ETHM-1 Plus avec une clé d'intégration** : les échanges restent
  confidentiels grâce à AES avec cette clé (la méthode de satel-integra).
  AES n'empêche pas le rejeu : une trame enregistrée sur votre réseau peut
  être renvoyée telle quelle au module. Mettez la même clé
  des deux côtés ; si elles diffèrent, le module ne répond jamais et
  l'intégration vous le signale.
- Protégez votre réseau (Wi-Fi invité séparé pour les appareils dont vous
  n'êtes pas sûr) et donnez à Gladys un utilisateur INTEGRA aux droits
  limités.

## Sécurité

- **Armer** est permis par défaut (option « Autoriser l'armement depuis
  Gladys »), avec le code utilisateur. Armer alors que quelqu'un est à
  l'intérieur (une scène mal réglée, une erreur) peut déclencher une fausse
  alarme, les sirènes et un appel de votre télésurveillance.
- **Désarmer est désactivé par défaut.** Une fois l'option cochée, **tout
  utilisateur de Gladys, toute scène et l'application mobile Gladys peuvent
  désarmer, avec le code de la configuration, sans saisir aucun code**. Ne
  l'autorisez que si votre Gladys est bien protégé (comptes, accès à
  distance).
- **Les sorties sont désactivées par défaut**, derrière leur propre option :
  une sortie peut commander une sirène, un portail ou une serrure. Vérifiez
  d'abord ce que fait chacune.
- Les options sont relues juste avant chaque envoi : une option décochée
  pendant qu'une commande attend son tour bloque cette commande.
- Avant chaque commande, l'intégration **relit l'état sur la centrale** et
  décide sur cet état, jamais sur ce qu'elle a en mémoire (déjà dans l'état
  demandé : rien n'est envoyé ; armée dans un autre mode : refusé, désarmez
  d'abord). Les commandes passent une par une : une commande demandée pendant
  qu'une autre est en cours est refusée tout de suite (« une autre commande
  est en cours »), rien n'est envoyé.
- Une commande qui ne peut pas partir dans les temps (centrale lente, état
  illisible) est refusée avec « rien n'a été envoyé ». Une commande partie
  sans réponse claire (pas de réponse, réponse ambiguë, coupure) est
  annoncée « envoyée, sans confirmation » et l'état est relu deux secondes
  plus tard : elle n'est jamais annoncée « non envoyée ». Seule une réponse
  de refus de la centrale est annoncée « refusée » (code refusé, droits
  insuffisants, armement impossible…).
- **Si la centrale refuse le code utilisateur, l'intégration ne l'envoie plus
  jamais d'elle-même**, même après un redémarrage (une INTEGRA peut
  déclencher une alarme ou bloquer les claviers après plusieurs codes faux).
  Les états continuent d'arriver. Changez le code dans la configuration, ou
  cliquez sur « Autoriser un nouvel essai du code ». Une réponse de refus
  arrivée en retard (après « envoyée, sans confirmation ») arrête aussi les
  commandes. Le fichier `/data/satel-state.json` garde seulement la date de
  l'arrêt, jamais le code ; l'arrêt tient même si l'adresse du module change.
- Chaque commande, envoyée ou refusée, est écrite dans les journaux de
  l'intégration, jamais les codes.

## Connexion

- Une seule connexion à la fois, jamais deux : au moins 5 secondes entre
  deux connexions.
- Sur une coupure, les nouveaux essais sont espacés : 10 s, 30 s, 1 min,
  2 min, puis toutes les 5 minutes ; au moins une minute quand le module
  répond « Busy ».
- Un message toutes les 15 secondes de silence garde la connexion ouverte
  (le module coupe un client muet après 25 s) ; sans rien recevoir pendant
  45 s, l'intégration se reconnecte.

## Limites connues

- Jamais testé avec un vrai appareil (voir plus haut).
- Les listes « autoprotection des zones » (0x01) et « alarme des zones »
  (0x02) viennent de la description Satel du protocole, pas de
  satel-integra : non vérifiées.
- Les zones et sorties au-delà de 128 (INTEGRA 256 Plus) sont demandées au
  format 32 octets : non vérifié.
- Les noms sont lus en Latin-1 ; les caractères propres à Satel peuvent être
  remplacés.
- Pas de températures de zones, pas d'effacement d'alarme séparé (0x85), pas
  de journal d'événements dans cette version.
- Une alarme déjà en cours au démarrage de l'intégration ne déclenche pas de
  scène (seuls les changements vus le font).

## Confidentialité

Tout reste sur votre réseau : l'intégration ne parle qu'au module ETHM-1.

## Licence

Apache-2.0. Logique de protocole portée de satel-integra 1.5.0 (MIT,
Krzysztof Machelski) : voir `THIRD_PARTY_NOTICES.md`.
