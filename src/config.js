// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized.
// -----------------------------------------------------------------------------

import { DEFAULT_PORT, LIMITS, STAY_MODES, ZONE_KINDS } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULTS = {
  port: DEFAULT_PORT,
  partitions: '1',
  stay_mode: '1',
  allow_arm: true,
  allow_disarm: false,
  allow_outputs: false,
  language: 'fr',
};

export const LANGUAGES = ['fr', 'en'];

const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

const integer = (value, fallback, min, max) => {
  const number = Number(value);
  return value !== null && value !== '' && value !== undefined && Number.isFinite(number)
    ? Math.round(Math.max(min, Math.min(max, number)))
    : fallback;
};

/** `192.168.1.40`, `ethm.lan:7094`, `tcp://192.168.1.40` -> { host, port? }. */
export function parseHost(raw) {
  let text = String(raw ?? '').trim();
  text = text.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
  const match = /^(\[[0-9a-f:.]+\]|[^:\s]+)(?::(\d{1,5}))?$/i.exec(text);
  if (!match) return { host: '' };
  const port = match[2] ? Number(match[2]) : undefined;
  return {
    host: match[1].replace(/^\[|\]$/g, ''),
    port: port >= 1 && port <= 65535 ? port : undefined,
  };
}

/** The user code: 4 to 16 digits (prefix included), '' when absent or malformed. */
export const normalizeCode = (raw) => {
  const text = String(raw ?? '').trim();
  return /^\d{4,16}$/.test(text) ? text : '';
};

/** The integration key of an ETHM-1 Plus: printable ASCII, 12 characters at most. */
export const normalizeKey = (raw) => {
  const text = String(raw ?? '');
  return /^[\x20-\x7e]{1,12}$/.test(text) ? text : '';
};

/**
 * `1-4, 7, 9:motion` -> Map(number -> kind or undefined). Entries are
 * separated by commas, semicolons or new lines; `=` works like `:`. Wrong
 * entries are reported, not fatal. `kinds` false: a kind is an error.
 */
export function parseNumbers(raw, max, { kinds = false } = {}) {
  const numbers = new Map();
  const errors = [];
  for (const entry of String(raw ?? '').split(/[,;\n]+/)) {
    const text = entry.trim();
    if (text === '') continue;
    const match = /^(\d{1,3})(?:\s*-\s*(\d{1,3}))?(?:\s*[:=]\s*([a-z]+))?$/i.exec(text);
    const kind = match?.[3]?.toLowerCase();
    const from = Number(match?.[1]);
    const to = match?.[2] ? Number(match[2]) : from;
    if (
      !match ||
      from < 1 ||
      to > max ||
      to < from ||
      (kind !== undefined && (!kinds || !ZONE_KINDS.includes(kind)))
    ) {
      errors.push(text.slice(0, 40));
      continue;
    }
    for (let n = from; n <= to; n += 1) numbers.set(n, kind ?? numbers.get(n));
  }
  return { numbers, errors };
}

export function normalizeConfig(raw = {}) {
  const { host, port: hostPort } = parseHost(raw?.host);
  const language = String(raw?.language ?? DEFAULTS.language)
    .trim()
    .toLowerCase();
  const typedCode = String(raw?.user_code ?? '').trim();
  const typedKey = String(raw?.integration_key ?? '');
  const partitions = parseNumbers(raw?.partitions ?? DEFAULTS.partitions, LIMITS.maxPartitions);
  const zones = parseNumbers(raw?.zones, LIMITS.maxZones, { kinds: true });
  const outputs = parseNumbers(raw?.outputs, LIMITS.maxOutputs);
  const stayMode = String(raw?.stay_mode ?? DEFAULTS.stay_mode);
  return {
    host,
    // A port typed with the address wins over the port field (which has a default).
    port: hostPort ?? integer(raw?.port, DEFAULTS.port, 1, 65535),
    code: normalizeCode(typedCode),
    codeInvalid: typedCode !== '' && normalizeCode(typedCode) === '',
    key: normalizeKey(typedKey),
    keyInvalid: typedKey !== '' && normalizeKey(typedKey) === '',
    partitions: [...partitions.numbers.keys()].sort((a, b) => a - b),
    zones: new Map([...zones.numbers.entries()].sort(([a], [b]) => a - b)),
    outputs: [...outputs.numbers.keys()].sort((a, b) => a - b),
    listErrors: [...partitions.errors, ...zones.errors, ...outputs.errors],
    stayMode: STAY_MODES.includes(stayMode) ? Number(stayMode) : Number(DEFAULTS.stay_mode),
    allowArm: bool(raw?.allow_arm, DEFAULTS.allow_arm),
    allowDisarm: bool(raw?.allow_disarm, DEFAULTS.allow_disarm),
    allowOutputs: bool(raw?.allow_outputs, DEFAULTS.allow_outputs),
    language: LANGUAGES.includes(language) ? language : DEFAULTS.language,
  };
}

/** What the session depends on: a change reconnects. The user code is not in it (commands only). */
export const sessionKey = (config) =>
  JSON.stringify([
    config.host,
    config.port,
    config.key,
    config.partitions,
    [...config.zones.keys()],
    config.outputs,
  ]);

/** Where the session goes, without any secret: what a persisted stop is tied to. */
export const placeKey = (config) => `${config.host}:${config.port}`;
