// -----------------------------------------------------------------------------
// The commands, answers and models of the INTEGRA protocol, from
// satel-integra 1.5.0 (`commands.py`, `models/*.py`, `satel_integra.py`, MIT,
// see THIRD_PARTY_NOTICES.md). The zone tamper (0x01) and zone alarm (0x02)
// lists are not in satel-integra: they come from the Satel description of
// the protocol, like the others, and were never seen on a real panel here.
// -----------------------------------------------------------------------------

/** Read commands: the module answers with the same command byte. */
export const READ = {
  ZONES_VIOLATED: 0x00,
  ZONES_TAMPER: 0x01,
  ZONES_ALARM: 0x02,
  PARTITIONS_ARMED_SUPPRESSED: 0x09,
  PARTITIONS_ARMED: 0x0a,
  PARTITIONS_ARMED_MODE2: 0x0b,
  PARTITIONS_ARMED_MODE3: 0x0c,
  PARTITIONS_ENTRY_TIME: 0x0e,
  PARTITIONS_EXIT_OVER_10: 0x0f,
  PARTITIONS_EXIT_UNDER_10: 0x10,
  PARTITIONS_ALARM: 0x13,
  PARTITIONS_FIRE_ALARM: 0x14,
  OUTPUTS_STATE: 0x17,
  RTC_AND_STATUS: 0x1a,
  PARTITIONS_ARMED_MODE1: 0x2a,
  MODULE_VERSION: 0x7c,
  INTEGRA_VERSION: 0x7e,
  READ_DEVICE_NAME: 0xee,
};

/** Write commands: the module answers 0xEF (a result code). */
export const WRITE = {
  START_MONITORING: 0x7f,
  ARM_MODE_0: 0x80,
  DISARM: 0x84,
  OUTPUTS_ON: 0x88,
  OUTPUTS_OFF: 0x89,
};

export const RESULT = 0xef;

/** 0xEF result codes (satel-integra `SatelResultCode`). */
export const RESULT_CODES = {
  0x00: 'ok',
  0x01: 'user_code_not_found',
  0x02: 'no_access',
  0x03: 'user_does_not_exist',
  0x08: 'other_error',
  0x11: 'cannot_arm_can_force',
  0x12: 'cannot_arm',
  0xff: 'accepted',
};

export const isSuccess = (code) => code === 0x00 || code === 0xff;

/** The panel refused the user code itself: never sent again by itself. */
export const isCodeRefusal = (code) => code === 0x01 || code === 0x03;

export const resultName = (code) =>
  `${RESULT_CODES[code] ?? 'unknown'} (0x${code.toString(16).padStart(2, '0').toUpperCase()})`;

/** Lists the session follows (monitoring) and reads once at the start. */
export const ZONE_LISTS = [READ.ZONES_VIOLATED, READ.ZONES_TAMPER, READ.ZONES_ALARM];
export const OUTPUT_LISTS = [READ.OUTPUTS_STATE];
export const PARTITION_LISTS = [
  READ.PARTITIONS_ARMED_SUPPRESSED,
  READ.PARTITIONS_ARMED,
  READ.PARTITIONS_ARMED_MODE1,
  READ.PARTITIONS_ARMED_MODE2,
  READ.PARTITIONS_ARMED_MODE3,
  READ.PARTITIONS_ENTRY_TIME,
  READ.PARTITIONS_EXIT_OVER_10,
  READ.PARTITIONS_EXIT_UNDER_10,
  READ.PARTITIONS_ALARM,
  READ.PARTITIONS_FIRE_ALARM,
];
export const MONITORED = [...ZONE_LISTS, ...PARTITION_LISTS, ...OUTPUT_LISTS];

/** Zone and output lists: 16 bytes (128) or 32 bytes (256), both legal. */
export const isWideList = (cmd) => ZONE_LISTS.includes(cmd) || OUTPUT_LISTS.includes(cmd);

/** The lengths an answer may have; undefined: not a list we read. */
export function listLengths(cmd) {
  if (isWideList(cmd)) return [16, 32];
  if (PARTITION_LISTS.includes(cmd)) return [4];
  return undefined;
}

/** What a partition decision needs: armed, arming, alarm (plus the mode when armed). */
export const PARTITION_STATE_READS = [
  READ.PARTITIONS_ARMED,
  READ.PARTITIONS_ARMED_SUPPRESSED,
  READ.PARTITIONS_EXIT_OVER_10,
  READ.PARTITIONS_EXIT_UNDER_10,
  READ.PARTITIONS_ALARM,
  READ.PARTITIONS_FIRE_ALARM,
];
export const PARTITION_MODE_READS = [
  READ.PARTITIONS_ARMED_MODE1,
  READ.PARTITIONS_ARMED_MODE2,
  READ.PARTITIONS_ARMED_MODE3,
];

/** 0x7F data: 12 bytes, bit (cmd + 1) set for each followed list (satel-integra). */
export function monitoringMask(commands = MONITORED) {
  const out = Buffer.alloc(12);
  for (const cmd of commands) out[cmd >> 3] |= 1 << (cmd & 7);
  return out;
}

/** INTEGRA types (satel-integra `PANEL_MODEL_BY_TYPE_CODE`). */
export const PANEL_MODELS = {
  0: 'INTEGRA 24',
  1: 'INTEGRA 32',
  2: 'INTEGRA 64',
  3: 'INTEGRA 128',
  4: 'INTEGRA 128-WRL SIM300',
  66: 'INTEGRA 64 Plus',
  67: 'INTEGRA 128 Plus',
  72: 'INTEGRA 256 Plus',
  132: 'INTEGRA 128-WRL LEON',
};

/** `12320120527` -> `1.23 (2012-05-27)`; undefined when it is not 11 digits. */
export function firmware(bytes) {
  const text = Buffer.from(bytes).toString('latin1');
  if (!/^\d{11}$/.test(text)) return undefined;
  return `${Number(text[0])}.${text.slice(1, 3)} (${text.slice(3, 7)}-${text.slice(7, 9)}-${text.slice(9, 11)})`;
}

/** 0x7E answer (14 bytes) -> { type, model, firmware }. */
export function panelInfo(data) {
  if (data.length !== 14) return undefined;
  const type = data[0];
  return {
    type,
    model: PANEL_MODELS[type] ?? `INTEGRA (type ${type})`,
    firmware: firmware(data.subarray(1, 12)),
  };
}

/** 0x7C answer (12 bytes) -> { firmware, wide }. */
export function moduleInfo(data) {
  if (data.length !== 12) return undefined;
  return { firmware: firmware(data.subarray(0, 11)), wide: Boolean(data[11] & 1) };
}

/** 0x1A answer (9 bytes) -> the status flags (satel-integra `SatelRtcAndStatus`). */
export function rtcStatus(data) {
  if (data.length !== 9) return undefined;
  return { service: Boolean(data[7] & 0x80), troubles: Boolean(data[7] & 0x40) };
}

/** 0xEE selectors and answer lengths (satel-integra `SatelDeviceSelector`). */
export const NAME_SELECTORS = {
  partition: { selector: 0x10, length: 20 },
  zone: { selector: 0x05, length: 20 },
  output: { selector: 0x04, length: 19 },
};

/**
 * The status of one partition from the lists (a Map cmd -> Set, or
 * undefined while the list was never received). Order of satel-integra's
 * Home Assistant mapping: alarm, armed mode 3, 2, 1, armed (0), exit time.
 */
export function partitionStatus(lists, n) {
  const has = (cmd) => lists.get(cmd)?.has(n) ?? false;
  const known = lists.has(READ.PARTITIONS_ARMED) || lists.has(READ.PARTITIONS_ARMED_SUPPRESSED);
  if (!known) return { known: false };
  const armed = has(READ.PARTITIONS_ARMED) || has(READ.PARTITIONS_ARMED_SUPPRESSED);
  let armMode;
  if (armed) {
    if (has(READ.PARTITIONS_ARMED_MODE3)) armMode = 3;
    else if (has(READ.PARTITIONS_ARMED_MODE2)) armMode = 2;
    else if (has(READ.PARTITIONS_ARMED_MODE1)) armMode = 1;
    else armMode = 0;
  }
  const exit = has(READ.PARTITIONS_EXIT_OVER_10) || has(READ.PARTITIONS_EXIT_UNDER_10);
  let mode = 'disarmed';
  if (armed) mode = armMode === 0 ? 'armed_away' : 'armed_stay';
  else if (exit) mode = 'arming';
  return {
    known: true,
    mode,
    armMode,
    armed,
    entry: has(READ.PARTITIONS_ENTRY_TIME),
    alarm: has(READ.PARTITIONS_ALARM),
    fire: has(READ.PARTITIONS_FIRE_ALARM),
  };
}
