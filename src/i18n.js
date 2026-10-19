// -----------------------------------------------------------------------------
// Names and messages, French and English.
// -----------------------------------------------------------------------------

export const word = (entry, language) => entry?.[language] ?? entry?.en ?? '';

/** An entry whose values are functions -> the entry of their results. */
export const fill = (entry, ...args) =>
  Object.fromEntries(
    Object.entries(entry).map(([lang, value]) => [
      lang,
      typeof value === 'function' ? value(...args) : value,
    ]),
  );

export const DEVICE_NAMES = {
  panel: { fr: 'Centrale Satel', en: 'Satel panel' },
  partition: { fr: (n) => `Partition ${n}`, en: (n) => `Partition ${n}` },
  zone: { fr: (n) => `Zone ${n}`, en: (n) => `Zone ${n}` },
  output: { fr: (n) => `Sortie ${n}`, en: (n) => `Output ${n}` },
};

export const FEATURE_NAMES = {
  online: { fr: 'Centrale connectée', en: 'Panel connected' },
  trouble: { fr: 'Défaut en cours', en: 'Trouble' },
  'service-mode': { fr: 'Mode service', en: 'Service mode' },
  mode: { fr: 'État', en: 'State' },
  armed: { fr: 'Armée', en: 'Armed' },
  alarm: { fr: 'Alarme en cours', en: 'Alarm in progress' },
  'fire-alarm': { fr: 'Alarme incendie', en: 'Fire alarm' },
  'arm-away': { fr: 'Armement total', en: 'Arm away' },
  'arm-stay': { fr: 'Armement partiel', en: 'Arm stay' },
  disarm: { fr: 'Désarmer', en: 'Disarm' },
  kind: {
    opening: { fr: 'Ouverture', en: 'Opening' },
    motion: { fr: 'Mouvement', en: 'Motion' },
    smoke: { fr: 'Fumée', en: 'Smoke' },
    leak: { fr: "Fuite d'eau", en: 'Water leak' },
  },
  tamper: { fr: 'Autoprotection', en: 'Tamper' },
  'zone-alarm': { fr: 'Alarme', en: 'Alarm' },
  state: { fr: 'Active', en: 'On' },
  'turn-on': { fr: 'Activer', en: 'Turn on' },
  'turn-off': { fr: 'Désactiver', en: 'Turn off' },
};

/** The text of the read-only state feature of a partition. */
export const MODE_NAMES = {
  disarmed: { fr: 'Désarmée', en: 'Disarmed' },
  arming: { fr: 'Armement en cours', en: 'Arming' },
  armed_away: { fr: 'Armée (totale)', en: 'Armed (away)' },
  armed_stay: { fr: 'Armée (partielle)', en: 'Armed (stay)' },
};

const modeList = (partitions, language) =>
  partitions.length === 0
    ? ''
    : ` (${partitions
        .map(({ partition, mode }) =>
          mode
            ? `${partition}: ${word(MODE_NAMES[mode], language).toLowerCase()}`
            : `${partition}: ?`,
        )
        .join(', ')})`;

const nothing = { fr: " : rien n'a été envoyé.", en: ': nothing was sent.' };

/** Connection status and command messages. */
export const T = {
  noHost: {
    en: 'Enter the address of the ETHM-1 module in the configuration.',
    fr: "Saisissez l'adresse du module ETHM-1 dans la configuration.",
  },
  badKey: {
    en: 'The integration key holds 1 to 12 characters (letters, digits, signs): fix it or leave it empty.',
    fr: "La clé d'intégration compte 1 à 12 caractères (lettres, chiffres, signes) : corrigez-la ou laissez-la vide.",
  },
  noPartition: {
    en: 'List at least one partition in the configuration (for example "1").',
    fr: 'Indiquez au moins une partition dans la configuration (par exemple « 1 »).',
  },
  connecting: { en: 'Connecting to the Satel module…', fr: 'Connexion au module Satel…' },
  connected: {
    en: (model, partitions, zones, outputs) =>
      `Connected to the ${model} panel${modeList(partitions, 'en')}, ${zones} zone(s), ${outputs} output(s).`,
    fr: (model, partitions, zones, outputs) =>
      `Connecté à la centrale ${model}${modeList(partitions, 'fr')}, ${zones} zone(s), ${outputs} sortie(s).`,
  },
  codeStopped: {
    en: ' The panel refused the user code: commands stopped until the code is changed or "Allow a new try of the code" is clicked.',
    fr: ' La centrale a refusé le code utilisateur : commandes arrêtées jusqu’à un changement du code ou un clic sur « Autoriser un nouvel essai du code ».',
  },
  unreachable: {
    en: (reason, seconds) => `Satel module unreachable (${reason}), next try in ${seconds} s.`,
    fr: (reason, seconds) =>
      `Module Satel injoignable (${reason}), nouvel essai dans ${seconds} s.`,
  },
  busy: {
    en: (seconds) =>
      `The ETHM-1 module is busy with another client (it takes only one: Home Assistant, DLOADX, GUARDX…). Next try in ${seconds} s.`,
    fr: (seconds) =>
      `Le module ETHM-1 est occupé par un autre client (il n'en accepte qu'un : Home Assistant, DLOADX, GUARDX…). Nouvel essai dans ${seconds} s.`,
  },
  silent: {
    en: (seconds) =>
      `The module accepts the connection but never answers: check the integration key (ETHM-1 Plus: same key, or none on both sides) and that the integration is enabled on the module. Next try in ${seconds} s.`,
    fr: (seconds) =>
      `Le module accepte la connexion mais ne répond jamais : vérifiez la clé d'intégration (ETHM-1 Plus : la même clé, ou aucune des deux côtés) et que l'intégration est activée sur le module. Nouvel essai dans ${seconds} s.`,
  },
  offline: {
    en: `The panel is not connected${nothing.en}`,
    fr: `La centrale n'est pas connectée${nothing.fr}`,
  },
  noCode: {
    en: `Enter a user code in the configuration to control the alarm${nothing.en}`,
    fr: `Saisissez un code utilisateur dans la configuration pour piloter l'alarme${nothing.fr}`,
  },
  badCode: {
    en: `The user code of the configuration must be 4 to 16 digits${nothing.en}`,
    fr: `Le code utilisateur de la configuration doit compter 4 à 16 chiffres${nothing.fr}`,
  },
  codeRefusedBefore: {
    en: `The panel refused this user code before: change it in the configuration, or click "Allow a new try of the code"${nothing.en}`,
    fr: `La centrale a déjà refusé ce code utilisateur : changez-le dans la configuration, ou cliquez sur « Autoriser un nouvel essai du code »${nothing.fr}`,
  },
  armRefused: {
    en: `Arming from Gladys is disabled in the configuration${nothing.en}`,
    fr: `L'armement depuis Gladys est désactivé dans la configuration${nothing.fr}`,
  },
  disarmRefused: {
    en: `Disarming from Gladys is disabled in the configuration${nothing.en}`,
    fr: `Le désarmement depuis Gladys est désactivé dans la configuration${nothing.fr}`,
  },
  outputsRefused: {
    en: `Controlling outputs from Gladys is disabled in the configuration${nothing.en}`,
    fr: `Le pilotage des sorties depuis Gladys est désactivé dans la configuration${nothing.fr}`,
  },
  otherMode: {
    en: `The partition is already armed in another mode, or arming, disarm it first${nothing.en}`,
    fr: `La partition est déjà armée dans un autre mode, ou en cours d'armement : désarmez-la d'abord${nothing.fr}`,
  },
  inAlarm: {
    en: `The partition is in alarm${nothing.en}`,
    fr: `La partition est en alarme${nothing.fr}`,
  },
  unknownPartition: {
    en: (n) => `Partition ${n} is not in the configuration${nothing.en}`,
    fr: (n) => `La partition ${n} n'est pas dans la configuration${nothing.fr}`,
  },
  unknownOutput: {
    en: (n) => `Output ${n} is not in the configuration${nothing.en}`,
    fr: (n) => `La sortie ${n} n'est pas dans la configuration${nothing.fr}`,
  },
  stateUnknown: {
    en: `The current state could not be read from the panel${nothing.en}`,
    fr: `L'état actuel n'a pas pu être relu sur la centrale${nothing.fr}`,
  },
  tooLate: {
    en: `The panel answered too slowly to send the command in time${nothing.en}`,
    fr: `La centrale a répondu trop lentement pour envoyer la commande à temps${nothing.fr}`,
  },
  codeRefused: {
    en: (what) =>
      `The panel refused the user code (${what}). Commands are stopped until the code is changed or "Allow a new try of the code" is clicked.`,
    fr: (what) =>
      `La centrale a refusé le code utilisateur (${what}). Les commandes sont arrêtées jusqu'à un changement du code ou un clic sur « Autoriser un nouvel essai du code ».`,
  },
  noAccess: {
    en: (what) => `The panel refused the command: this user has no right for it (${what}).`,
    fr: (what) =>
      `La centrale a refusé la commande : cet utilisateur n'en a pas le droit (${what}).`,
  },
  cannotArm: {
    en: (what) =>
      `The panel cannot arm now (${what}): a zone is violated or a trouble is in progress.`,
    fr: (what) =>
      `La centrale ne peut pas armer maintenant (${what}) : une zone est violée ou un défaut est en cours.`,
  },
  panelRefused: {
    en: (what, code) => `The panel refused the command (${what}, answer ${code}).`,
    fr: (what, code) => `La centrale a refusé la commande (${what}, réponse ${code}).`,
  },
  unconfirmed: {
    en: (what) =>
      `Sent to the panel (${what}), without confirmation in time: the state is read again in 2 s.`,
    fr: (what) =>
      `Envoyé à la centrale (${what}), sans confirmation dans les temps : l'état est relu dans 2 s.`,
  },
  commandBusy: {
    en: `Other commands took all the time of this one before its turn came${nothing.en}`,
    fr: `D'autres commandes ont pris tout le temps de celle-ci avant son tour${nothing.fr}`,
  },
  armWithdrawn: {
    en: `A disarm of this partition was asked while this arming waited its turn${nothing.en}`,
    fr: `Un désarmement de cette partition a été demandé pendant que cet armement attendait son tour${nothing.fr}`,
  },
  codeNotStopped: {
    en: 'The user code is not stopped: nothing to allow.',
    fr: "Le code utilisateur n'est pas arrêté : rien à autoriser.",
  },
  codeRetryAllowed: {
    en: 'The next command will send the user code again (once). Nothing was sent now.',
    fr: "La prochaine commande enverra de nouveau le code utilisateur (une fois). Rien n'a été envoyé maintenant.",
  },
  stillConnecting: {
    en: 'The connection to the module is still starting; try again in a moment.',
    fr: 'La connexion au module démarre encore ; réessayez dans un instant.',
  },
};

/** What a command does, for the logs and the messages. */
export const COMMAND_NAMES = {
  armed_away: {
    en: (p) => `arm away, partition ${p}`,
    fr: (p) => `armement total, partition ${p}`,
  },
  armed_stay: {
    en: (p) => `arm stay, partition ${p}`,
    fr: (p) => `armement partiel, partition ${p}`,
  },
  disarm: { en: (p) => `disarm, partition ${p}`, fr: (p) => `désarmement, partition ${p}` },
  'turn-on': { en: (o) => `turn on, output ${o}`, fr: (o) => `activation, sortie ${o}` },
  'turn-off': { en: (o) => `turn off, output ${o}`, fr: (o) => `désactivation, sortie ${o}` },
};
