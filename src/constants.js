// -----------------------------------------------------------------------------
// Fixed values: manifest keys, Gladys value enums, protocol limits and timings.
// The SDK exports the Gladys categories and types, not the state values: the
// ones used here mirror server/utils/constants.js of the core.
// -----------------------------------------------------------------------------

/** Manifest keys: frozen, users store them in scenes and dashboards. */
export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

export const SCENE_ACTIONS = {
  ARM: 'arm',
  DISARM: 'disarm',
};

export const SCENE_TRIGGERS = {
  ALARM_TRIGGERED: 'alarm_triggered',
  ARMED: 'armed',
  DISARMED: 'disarmed',
};

/** Arming modes of a scene action or of an `armed` event (frozen: scenes compare them). */
export const ARM_MODES = ['armed_away', 'armed_stay'];

/** Every mode a partition can show (`arming`: exit time running). */
export const MODES = ['disarmed', 'arming', 'armed_away', 'armed_stay'];

/** The INTEGRA arming mode used for "arm stay" (mode 0 is "arm away"). */
export const STAY_MODES = ['1', '2', '3'];

/** How a zone shows in Gladys (frozen: stored in the configuration). */
export const ZONE_KINDS = ['opening', 'motion', 'smoke', 'leak'];

/** Gladys core values (server/utils/constants.js). */
export const OPENING_SENSOR_STATE = { OPEN: 0, CLOSE: 1 };
export const BUTTON_PUSH = { PRESSED: 1 };

/** The integration port of the ETHM-1 (Satel's default). */
export const DEFAULT_PORT = 7094;

export const LIMITS = {
  maxPartitions: 32,
  /** INTEGRA 256 Plus. */
  maxZones: 256,
  maxOutputs: 256,
  /** Characters of an ETHM-1 Plus integration key. */
  maxKey: 12,
  /** Requests in a row without an answer before the link counts as dead. */
  maxTimeouts: 3,
  /** States per minute sent to Gladys (the core admits 300). */
  statesPerMinute: 240,
  /** Part of it only the panel and partition states may use. */
  priorityStates: 60,
  /** Scene events per minute (the core admits 300); alarm_triggered is never dropped. */
  eventsPerMinute: 120,
  /** Tries of an alarm_triggered event refused by Gladys or the network. */
  alarmEventTries: 3,
  /** Name reads in a row without an answer: the other names are skipped. */
  nameTimeouts: 2,
  /** First requests in a row without an answer: the integration key is suspected. */
  silentSessions: 2,
  /** Bytes waiting in the socket write buffer before the session is cut (a flood). */
  maxPendingWrite: 64 * 1024,
  /** Bytes kept from what the module sends before the first request ("Busy!"). */
  maxGreeting: 64,
};

export const TIMINGS = {
  /** TCP connection to the module. */
  connectTimeout: 10_000,
  /**
   * After the TCP connection, the module says "Busy!" (and closes) when
   * another client holds it: listened for this long before the first
   * request (satel-integra: 0.1 s).
   */
  greeting: 300,
  /** One request (satel-integra waits 5 s). */
  requestTimeout: 5_000,
  /** One name read during the discovery. */
  nameTimeout: 2_000,
  /** The module drops a client silent for 25 s: a keep-alive after 15 s without a request (satel-integra). */
  keepAlive: 15_000,
  /** Nothing received for this long while connected: the link is dead. */
  watchdog: 45_000,
  /** Waits before reconnecting, in a row (the last one repeats). */
  backoff: [10_000, 30_000, 60_000, 120_000, 300_000],
  /** The module is held by another client: never sooner than this. */
  busyRetry: 60_000,
  /** Never a new connection sooner than this after the last one closed (one client at a time). */
  sessionGap: 5_000,
  /** A late answer may still come this long after a command timed out. */
  uncertain: 10_000,
  /**
   * Gladys waits 5 s for a set_value ack. A command's fresh state must be
   * read by readBy, the command sent by sendBy after it was asked (else
   * refused, nothing sent), and the answer is awaited until answerBy (then
   * "sent, not confirmed").
   */
  readBy: 2_800,
  sendBy: 3_500,
  answerBy: 4_500,
  /** The partition or output is read again this long after a command. */
  readBack: 2_000,
  /** A transition seen this long after a Gladys command is credited to it. */
  commandMemory: 5 * 60_000,
  /** How often the unchanged states get their heartbeat checked. */
  sweep: 60_000,
  /** An unchanged state is sent again this often… */
  stateHeartbeat: 30 * 60_000,
  /** …plus a per-feature offset within this spread. */
  heartbeatSpread: 5 * 60_000,
  /** Waits between two tries of an alarm_triggered event. */
  alarmEventRetry: [5_000, 20_000],
  /** "Test the connection" waits this long for the session (the manifest allows 30 s). */
  testWait: 25_000,
};
