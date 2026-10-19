// -----------------------------------------------------------------------------
// One TCP connection with the ETHM-1 / ETHM-1 Plus module of a Satel INTEGRA
// panel, ported from satel-integra 1.5.0 (`connection.py`, `transport.py`,
// `queue.py`, `satel_integra.py`, MIT, see THIRD_PARTY_NOTICES.md): the
// "Busy" check after connecting, the first request that proves the link
// (and the integration key), the monitoring (0x7F), the lists the module
// then sends by itself, the keep-alive (0x1A after 15 s without a request),
// the requests one at a time, the arming, disarming and output commands.
//
// The module takes ONE client at a time: this client never opens a second
// connection while one is open, and waits at least 5 s between two.
//
// Changed from satel-integra:
// - the names of the configured partitions, zones and outputs (0xEE) and
//   every followed list are read once after the monitoring starts, so the
//   model never waits for the module to report a change;
// - zone and output lists of 16 or 32 bytes are both taken (the module sends
//   either), the zone tamper and zone alarm lists are followed too;
// - reconnection with growing waits (10 s to 5 min, at least 60 s when the
//   module says "Busy"); a watchdog; three requests in a row without an
//   answer drop the link;
// - a command is never written after its deadline, and its option is read
//   again right before the write; a command that may have reached the module
//   is reported `sent: true`, never "not sent"; after a command timed out, a
//   result (0xEF) is ambiguous for 10 s (it may be the late answer);
// - the user code and the integration key are never logged: requests are
//   logged by a label.
//
// Events: 'up' { snapshot }, 'down' { reason, retryIn, busy, silent, wasUp },
// 'list' { cmd, set }, 'status' { troubles, service }.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { createConnection } from 'node:net';
import { LIMITS, TIMINGS } from '../constants.js';
import { EncryptedSession, PduReader } from './crypto.js';
import {
  FrameReader,
  decodeDeviceNumber,
  decodeMask,
  decodeName,
  encodeCode,
  encodeDeviceNumber,
  encodeFrame,
  encodeMask,
} from './frame.js';
import {
  MONITORED,
  NAME_SELECTORS,
  READ,
  RESULT,
  WRITE,
  isSuccess,
  isWideList,
  listLengths,
  monitoringMask,
  panelInfo,
  resultName,
  rtcStatus,
} from './protocol.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** One id_s per connection, as satel-integra (it shows the reconnections). */
let nextIdS = 0;

/**
 * kind: `offline` (nothing sent), `late` (not written in time, nothing sent),
 * `withdrawn` (its option was switched off before the write, nothing sent),
 * `timeout` (sent, no answer), `lost` (the connection ended while it waited),
 * `panel` (the module answered a refusal, 0xEF), `ambiguous` (a result that
 * may belong to an earlier command), `unexpected` (an answer of a wrong
 * length). `sent` tells whether the request may have reached the module.
 */
export class SatelError extends Error {
  constructor(message, kind, { sent = false, code } = {}) {
    super(message);
    this.kind = kind;
    this.sent = sent;
    this.code = code;
  }
}

const hex = (cmd) => `0x${cmd.toString(16).padStart(2, '0').toUpperCase()}`;

export class SatelClient extends EventEmitter {
  constructor({
    connect = (options) => createConnection(options),
    timers = globalThis,
    now = Date.now,
    logger = silent,
  } = {}) {
    super();
    this.connectFn = connect;
    this.timers = timers;
    this.now = now;
    this.logger = logger;
    this.options = { host: '', port: 7094, key: '', partitions: [], zones: [], outputs: [] };
    this.socket = undefined;
    this.generation = 0;
    this.running = false;
    this.ready = false;
    this.failures = 0;
    this.silentSessions = 0;
    this.closedAt = undefined;
    this.queue = [];
    this.inflight = undefined;
    this.lists = new Map();
    this.names = undefined;
    this.namesKey = undefined;
    this.reconnectTimer = undefined;
    this.connectTimer = undefined;
    this.greetingTimer = undefined;
    this.ticker = undefined;
    this.uncertainUntil = 0;
  }

  configure({ host, port, key = '', partitions = [], zones = [], outputs = [] }) {
    this.options = { host, port, key, partitions, zones, outputs };
  }

  get connected() {
    return this.ready;
  }

  /** A socket is open (connecting, starting or up). */
  get busy() {
    return Boolean(this.socket);
  }

  get encrypted() {
    return Boolean(this.options.key);
  }

  /** Zones or outputs over 128: the 32-byte lists are asked (0xFF after the command). */
  get wide() {
    return [...this.options.zones, ...this.options.outputs].some((n) => n > 128);
  }

  start() {
    this.stop();
    this.running = true;
    this.failures = 0;
    this.silentSessions = 0;
    this.openSoon(0);
  }

  /** Opens after `wait`, never sooner than sessionGap after the last connection closed. */
  openSoon(wait) {
    const gap = this.closedAt === undefined ? 0 : this.closedAt + TIMINGS.sessionGap - this.now();
    const delay = Math.max(wait, gap, 0);
    if (delay === 0) {
      this.open();
      return;
    }
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.running && !this.socket) this.open();
    }, delay);
  }

  stop() {
    this.running = false;
    this.generation += 1;
    if (this.reconnectTimer) {
      this.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.close();
  }

  clearTimers() {
    for (const name of ['connectTimer', 'greetingTimer']) {
      if (this[name]) this.timers.clearTimeout(this[name]);
      this[name] = undefined;
    }
    if (this.ticker) {
      this.timers.clearInterval(this.ticker);
      this.ticker = undefined;
    }
  }

  /** Ends the socket; every waiting request fails (sent or not, as it was). */
  close() {
    this.clearTimers();
    const socket = this.socket;
    this.socket = undefined;
    this.ready = false;
    this.phase = undefined;
    const inflight = this.inflight;
    this.inflight = undefined;
    if (inflight) {
      this.timers.clearTimeout(inflight.timer);
      inflight.reject(
        new SatelError('The connection to the module ended', 'lost', { sent: inflight.written }),
      );
    }
    for (const entry of this.queue.splice(0)) {
      this.timers.clearTimeout(entry.deadline);
      entry.reject(new SatelError('Not connected to the module', 'offline'));
    }
    if (!socket) return;
    this.closedAt = this.now();
    socket.removeAllListeners();
    socket.on('error', () => undefined);
    socket.destroy();
  }

  // --- Connection -------------------------------------------------------------

  open() {
    const generation = this.generation;
    const { host, port } = this.options;
    this.lists = new Map();
    this.status = undefined;
    this.timeouts = 0;
    this.uncertainUntil = 0;
    this.greeting = [];
    this.phase = 'connecting';
    this.frames = new FrameReader({
      onFrame: (frame) => {
        if (generation === this.generation) this.frame(generation, frame);
      },
      onDrop: (why) => this.logger.warn(`Satel: ${why}, frame dropped`),
    });
    this.session = this.encrypted
      ? new EncryptedSession(this.options.key, { idS: nextIdS++ })
      : undefined;
    this.pdus = this.session
      ? new PduReader({
          onPdu: (pdu) => {
            if (generation !== this.generation) return;
            let inner;
            try {
              inner = this.session.unwrap(pdu);
            } catch (err) {
              this.logger.warn(`Satel: ${err.message}`);
              this.lost(generation, 'unreadable data from the module (integration key?)');
              return;
            }
            this.frames.push(inner);
          },
          onError: (why) => this.logger.warn(`Satel: ${why}`),
        })
      : undefined;
    this.logger.debug(`Connecting to the Satel module at ${host}:${port}`);
    let socket;
    try {
      socket = this.connectFn({ host, port });
    } catch (err) {
      this.lost(generation, `connection failed: ${err.message}`);
      return;
    }
    this.socket = socket;
    socket.setNoDelay?.(true);
    this.connectTimer = this.timers.setTimeout(
      () => this.lost(generation, 'connection timed out'),
      TIMINGS.connectTimeout,
    );
    socket.on('connect', () => {
      if (generation !== this.generation) return;
      this.timers.clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
      this.phase = 'greeting';
      this.lastReceived = this.now();
      this.lastSent = this.now();
      this.greetingTimer = this.timers.setTimeout(() => {
        this.greetingTimer = undefined;
        if (generation !== this.generation) return;
        this.phase = 'starting';
        this.run(generation);
      }, TIMINGS.greeting);
    });
    socket.on('data', (chunk) => {
      if (generation !== this.generation) return;
      this.lastReceived = this.now();
      if (this.phase === 'greeting') {
        this.greet(generation, chunk);
        return;
      }
      if (this.pdus) this.pdus.push(chunk);
      else this.frames.push(chunk);
    });
    socket.on('error', (err) => this.lost(generation, err.code ?? err.message));
    socket.on('close', () =>
      this.lost(generation, 'connection closed by the module', {
        busy: this.phase === 'greeting',
      }),
    );
  }

  /** Data before the first request: "Busy!" (another client), or, encrypted, anything. */
  greet(generation, chunk) {
    for (const b of chunk) if (this.greeting.length < LIMITS.maxGreeting) this.greeting.push(b);
    const text = Buffer.from(this.greeting).toString('latin1');
    if (this.encrypted || /busy/i.test(text)) {
      this.lost(generation, 'the module is busy with another client', { busy: true });
    }
  }

  /** The session ended: reconnect later, unless stopped. */
  lost(generation, reason, { busy = false, silent: silentStart = false } = {}) {
    if (generation !== this.generation) return;
    this.generation += 1;
    const wasUp = this.ready;
    this.close();
    if (!this.running) return;
    this.failures = wasUp ? 1 : this.failures + 1;
    if (silentStart) this.silentSessions += 1;
    let retryIn = TIMINGS.backoff[Math.min(this.failures - 1, TIMINGS.backoff.length - 1)];
    if (busy) retryIn = Math.max(retryIn, TIMINGS.busyRetry);
    this.openSoon(retryIn);
    this.emit('down', {
      reason,
      retryIn,
      busy,
      silent: this.silentSessions >= LIMITS.silentSessions,
      wasUp,
    });
  }

  /** The first request, the names, the monitoring, the lists; 'up' once everything was read. */
  async run(generation) {
    try {
      let info;
      try {
        info = panelInfo(await this.request(READ.INTEGRA_VERSION, [], { internal: true }));
      } catch (err) {
        if (err instanceof SatelError && err.kind === 'timeout') {
          this.lost(generation, 'no answer from the module', { silent: true });
          return;
        }
        throw err;
      }
      this.silentSessions = 0;
      const names = await this.readNames(generation);
      if (generation !== this.generation) return;
      const code = await this.request(WRITE.START_MONITORING, monitoringMask(), {
        internal: true,
        label: 'start monitoring',
      }).catch((err) => {
        if (err instanceof SatelError && err.kind === 'panel') {
          throw new Error(`the module refused the monitoring: ${resultName(err.code)}`);
        }
        throw err;
      });
      this.logger.debug(`Satel: monitoring started (${resultName(code)})`);
      for (const cmd of MONITORED) {
        try {
          await this.readList(cmd, { internal: true });
        } catch (err) {
          // A list the panel does not have (0xEF answer) stays unknown.
          if (!(err instanceof SatelError && err.kind === 'panel')) throw err;
          this.logger.debug(`Satel: list ${hex(cmd)} not available`);
        }
      }
      if (generation !== this.generation) return;
      this.ticker = this.timers.setInterval(() => this.tick(generation), 1_000);
      this.ready = true;
      this.failures = 0;
      this.emit('up', {
        snapshot: {
          panel: info ?? { model: 'INTEGRA' },
          names,
          lists: new Map(this.lists),
          status: this.status,
        },
      });
    } catch (err) {
      if (generation !== this.generation) return;
      this.lost(generation, err.message);
    }
  }

  /** The names of the configured objects, read once per address and list. */
  async readNames(generation) {
    const { host, port, partitions, zones, outputs } = this.options;
    const key = JSON.stringify([host, port, partitions, zones, outputs]);
    if (this.namesKey === key && this.names) return this.names;
    const names = { partition: new Map(), zone: new Map(), output: new Map() };
    let timeouts = 0;
    const wanted = [
      ...partitions.map((n) => ['partition', n]),
      ...zones.map((n) => ['zone', n]),
      ...outputs.map((n) => ['output', n]),
    ];
    for (const [kind, n] of wanted) {
      if (generation !== this.generation) return names;
      if (timeouts >= LIMITS.nameTimeouts) break;
      const { selector, length } = NAME_SELECTORS[kind];
      try {
        const data = await this.request(READ.READ_DEVICE_NAME, [selector, encodeDeviceNumber(n)], {
          internal: true,
          timeout: TIMINGS.nameTimeout,
        });
        timeouts = 0;
        if (data.length !== length || data[0] !== selector) continue;
        if (decodeDeviceNumber(data[1]) !== n) continue;
        const name = decodeName(data.subarray(3, 19));
        const entry = { name };
        if (kind === 'zone' && data[19] >= 1 && data[19] <= LIMITS.maxPartitions) {
          entry.partition = data[19];
        }
        names[kind].set(n, entry);
      } catch (err) {
        if (!(err instanceof SatelError)) throw err;
        if (err.kind === 'timeout') timeouts += 1;
        else if (err.kind !== 'panel') throw err;
      }
    }
    if (timeouts >= LIMITS.nameTimeouts) {
      this.logger.warn('Satel: the names do not come; default names used');
    } else {
      this.names = names;
      this.namesKey = key;
    }
    return names;
  }

  tick(generation) {
    if (generation !== this.generation || !this.socket) return;
    const now = this.now();
    if (now - this.lastReceived > TIMINGS.watchdog) {
      this.logger.warn('Satel: nothing received for too long, reconnecting');
      this.lost(generation, 'no answer from the module');
      return;
    }
    // Only when the line is idle: the module drops a client silent for 25 s.
    if (!this.inflight && this.queue.length === 0 && now - this.lastSent >= TIMINGS.keepAlive) {
      this.request(READ.RTC_AND_STATUS, [], { label: 'keep-alive' }).catch(() => undefined);
    }
  }

  // --- Frames -----------------------------------------------------------------

  frame(generation, { cmd, data }) {
    const lengths = listLengths(cmd);
    if (lengths) {
      if (!lengths.includes(data.length)) {
        this.logger.warn(`Satel: list ${hex(cmd)} of ${data.length} bytes ignored`);
        this.answer(cmd, undefined, true);
        return;
      }
      const set = decodeMask(data);
      this.lists.set(cmd, set);
      if (this.ready) this.emit('list', { cmd, set });
    } else if (cmd === READ.RTC_AND_STATUS) {
      const status = rtcStatus(data);
      if (status) {
        this.status = status;
        if (this.ready) this.emit('status', status);
      }
    }
    this.answer(cmd, data);
  }

  /** An answer for the request in flight, if it is the one it waits for. */
  answer(cmd, data, malformed = false) {
    const entry = this.inflight;
    if (!entry) {
      if (cmd === RESULT) this.uncertainUntil = 0; // the late result came: in step again
      return;
    }
    if (cmd !== entry.expect && cmd !== RESULT) return;
    this.timers.clearTimeout(entry.timer);
    this.inflight = undefined;
    this.timeouts = 0;
    if (malformed) {
      entry.reject(
        new SatelError(`Unexpected answer to ${entry.label}`, 'unexpected', { sent: true }),
      );
    } else if (cmd === RESULT) {
      const code = data.length === 1 ? data[0] : -1;
      const late = this.now() < this.uncertainUntil;
      if (entry.expect === RESULT && late) {
        this.uncertainUntil = 0;
        entry.reject(
          new SatelError(`Ambiguous result to ${entry.label}`, 'ambiguous', { sent: true, code }),
        );
      } else if (entry.expect === RESULT && isSuccess(code)) {
        entry.resolve(code);
      } else {
        entry.reject(
          new SatelError(
            `The module answered ${code < 0 ? 'a malformed result' : resultName(code)}`,
            'panel',
            { sent: true, code },
          ),
        );
      }
    } else {
      entry.resolve(data);
    }
    this.pump();
  }

  // --- Requests ---------------------------------------------------------------

  /**
   * Queues a request; resolves with the answer data (a read) or the result
   * code (a write). `label` replaces the command in the logs (a frame may
   * hold the user code). `sendBy` (a time): never written after it,
   * rejected as not sent instead. `check()`: read right before the write,
   * false withdraws the request (nothing sent).
   */
  request(
    cmd,
    data = [],
    { timeout = TIMINGS.requestTimeout, label = hex(cmd), internal = false, sendBy, check } = {},
  ) {
    return new Promise((resolve, reject) => {
      if (!this.socket || (!internal && !this.ready)) {
        reject(new SatelError('Not connected to the module', 'offline'));
        return;
      }
      const expect = cmd >= 0x7f && cmd <= 0x89 ? RESULT : cmd;
      const entry = { cmd, data, expect, label, timeout, check, resolve, reject, written: false };
      if (sendBy !== undefined) {
        const wait = sendBy - this.now();
        if (wait <= 0) {
          reject(new SatelError(`${label} not sent in time`, 'late'));
          return;
        }
        // Withdrawn at its deadline if the line is still busy: never written late.
        entry.deadline = this.timers.setTimeout(() => {
          const at = this.queue.indexOf(entry);
          if (at < 0) return;
          this.queue.splice(at, 1);
          reject(new SatelError(`${label} not sent in time`, 'late'));
        }, wait);
      }
      this.queue.push(entry);
      this.pump();
    });
  }

  pump() {
    if (this.inflight || this.queue.length === 0 || !this.socket) return;
    const entry = this.queue.shift();
    this.timers.clearTimeout(entry.deadline);
    const generation = this.generation;
    // Last look before the socket: a command whose option was switched off
    // while it waited is withdrawn, never written.
    if (entry.check && !entry.check()) {
      entry.reject(new SatelError(`${entry.label} withdrawn: not allowed any more`, 'withdrawn'));
      this.pump();
      return;
    }
    let bytes;
    try {
      const frame = encodeFrame(entry.cmd, entry.data);
      bytes = this.session ? this.session.wrap(frame) : frame;
    } catch (err) {
      entry.reject(new SatelError(err.message, 'offline'));
      this.pump();
      return;
    }
    this.inflight = entry;
    this.logger.debug(`Satel <- ${entry.label}`);
    entry.written = true;
    this.lastSent = this.now();
    try {
      this.socket.write(bytes);
    } catch (err) {
      this.lost(generation, err.message);
      return;
    }
    if (this.overflowing(generation)) return;
    entry.timer = this.timers.setTimeout(() => {
      if (this.inflight !== entry) return;
      this.inflight = undefined;
      this.timeouts += 1;
      // A late result may still come: for a while, a result is not trusted.
      if (entry.expect === RESULT) this.uncertainUntil = this.now() + TIMINGS.uncertain;
      entry.reject(new SatelError(`No answer to ${entry.label}`, 'timeout', { sent: true }));
      if (this.timeouts >= LIMITS.maxTimeouts) {
        this.lost(generation, 'no answer from the module');
        return;
      }
      this.pump();
    }, entry.timeout);
  }

  /** A module (or a peer) flooding us faster than the socket drains: cut. */
  overflowing(generation) {
    if ((this.socket?.writableLength ?? 0) <= LIMITS.maxPendingWrite) return false;
    this.logger.warn('Satel: too much data waiting to be written, connection cut');
    this.lost(generation, 'write buffer full');
    return true;
  }

  // --- Reads and commands ---------------------------------------------------

  /** One list, read now (16 or 32 bytes for zones and outputs). */
  async readList(cmd, options = {}) {
    const data = await this.request(cmd, this.wide && isWideList(cmd) ? [0xff] : [], {
      label: `read ${hex(cmd)}`,
      ...options,
    });
    const lengths = listLengths(cmd);
    if (lengths && !lengths.includes(data.length)) {
      throw new SatelError(`Unexpected answer to ${hex(cmd)}`, 'unexpected', { sent: true });
    }
    return decodeMask(data);
  }

  /** Several lists, one after the other: Map cmd -> Set. */
  async readLists(cmds, options = {}) {
    const lists = new Map();
    for (const cmd of cmds) lists.set(cmd, await this.readList(cmd, options));
    return lists;
  }

  /** Arming mode 0 (away) to 3; the user code goes in the frame, never in a log. */
  arm(partition, mode, code, options) {
    return this.request(
      WRITE.ARM_MODE_0 + mode,
      [...encodeCode(code), ...encodeMask([partition], 4)],
      { label: `arm mode ${mode}, partition ${partition}`, ...options },
    );
  }

  disarm(partition, code, options) {
    return this.request(WRITE.DISARM, [...encodeCode(code), ...encodeMask([partition], 4)], {
      label: `disarm, partition ${partition}`,
      ...options,
    });
  }

  /** 32-byte output list, as satel-integra. */
  setOutput(output, on, code, options) {
    return this.request(
      on ? WRITE.OUTPUTS_ON : WRITE.OUTPUTS_OFF,
      [...encodeCode(code), ...encodeMask([output], 32)],
      { label: `output ${output} ${on ? 'on' : 'off'}`, ...options },
    );
  }
}
