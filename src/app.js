// -----------------------------------------------------------------------------
// The integration: one TCP connection with the ETHM-1 module of the Satel
// INTEGRA panel (src/satel/client.js), the lists it reports, the Gladys
// devices and states (src/devices.js), the scene events, the commands.
// index.js only wires the SDK handlers to it.
//
// Safety:
// - arming is allowed unless the configuration forbids it; disarming and
//   the outputs are off unless the configuration allows them (two options);
// - a command decides on the state read from the panel right before it,
//   never on the state in memory; one command at a time; its option is read
//   again right before the write;
// - a command is sent within 3.5 s of the request or not at all (Gladys
//   waits 5 s); one that may have reached the panel is never reported "not
//   sent", but "sent, not confirmed", and the state is read again;
// - a user code refused by the panel is never sent again by itself (an
//   INTEGRA may raise an alarm after wrong codes): the commands stop, across
//   restarts, until the code changes or "Test the connection" is clicked;
// - every command, sent or refused, is logged; the user code and the
//   integration key never are.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig, placeKey, sessionKey } from './config.js';
import { ARM_MODES, BUTTON_PUSH, SCENE_TRIGGERS, TIMINGS } from './constants.js';
import { buildDevices, buildStates, member, parseFeatureId } from './devices.js';
import { COMMAND_NAMES, T, fill, word } from './i18n.js';
import { SatelClient, SatelError } from './satel/client.js';
import {
  PARTITION_LISTS,
  PARTITION_MODE_READS,
  PARTITION_STATE_READS,
  READ,
  isCodeRefusal,
  partitionStatus,
  resultName,
} from './satel/protocol.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory } from './store.js';

/** A command refused before anything was sent to the panel. */
export class Refused extends Error {}

/** Command -> [config flag, refusal message, log name]. */
const OPTIONS = {
  arm: ['allowArm', T.armRefused, 'Arm'],
  disarm: ['allowDisarm', T.disarmRefused, 'Disarm'],
  output: ['allowOutputs', T.outputsRefused, 'Output'],
};

const emptyModel = () => ({
  panel: undefined,
  names: undefined,
  lists: new Map(),
  status: undefined,
});

export class SatelApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'satel' }),
    client,
    connect,
    now = Date.now,
    timers = globalThis,
    store = fileStore(),
    // The partition lists of one change come in several frames: the
    // transitions wait until no partition list came for 1.5 x settleMs, at
    // most 4 x settleMs after the first one (375 ms and 1 s by default).
    settleMs = 250,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.store = store;
    this.settleMs = settleMs;
    this.client = client ?? new SatelClient({ connect, timers, now, logger });
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    this.key = undefined;
    this.code = undefined;
    this.model = emptyModel();
    this.online = false;
    this.memory = undefined;
    /** partition -> { mode, until }: what the last Gladys command asked. */
    this.commanded = new Map();
    /** partition -> its status at the last flush: the transitions start from it. */
    this.seen = new Map();
    this.readBacks = new Set();
    this.lastStatus = undefined;
    this.lastTransport = undefined;
    this.published = undefined;
    this.started = false;
    this.sweeper = undefined;
    this.flushTimer = undefined;
    this.partitionTimer = undefined;
    this.partitionSince = undefined;
    this.modelPlace = undefined;
    /** { code, at }: the last command frame written with a user code (memory only). */
    this.sentWithCode = undefined;
    this.pendingCommands = 0;
    this.commands = Promise.resolve();
    this.starting = Promise.resolve();
    // Every model change is applied when the client emits it, in the order of
    // emission; guard() only queues what talks to Gladys.
    this.client.on('up', ({ snapshot }) => {
      this.model.panel = snapshot.panel;
      this.model.names = snapshot.names;
      this.model.lists = new Map(snapshot.lists);
      this.model.status = snapshot.status;
      this.online = true;
      this.guard(() => this.onUp());
    });
    this.client.on('down', (info) => {
      const wasOnline = this.online;
      this.online = false;
      this.guard(() => this.onDown(info, wasOnline));
    });
    this.client.on('list', ({ cmd, set }) => {
      this.model.lists.set(cmd, set);
      this.noteChange(PARTITION_LISTS.includes(cmd));
    });
    // A result that answers no request (late, after its command timed out).
    this.client.on('result', ({ code }) => this.lateResult(code));
    this.client.on('status', (status) => {
      this.model.status = status;
      this.noteChange();
    });
  }

  /** Client events run one after the other, in order. */
  guard(fn) {
    this.chain = (this.chain ?? Promise.resolve())
      .then(fn)
      .catch((err) => this.logger.error(`Satel event failed: ${err.message}`));
    return this.chain;
  }

  get language() {
    return this.config.language;
  }

  error(entry, cause) {
    return new Error(word(entry, this.language), cause ? { cause } : undefined);
  }

  refused(entry) {
    return new Refused(word(entry, this.language));
  }

  // --- Lifecycle -------------------------------------------------------------

  async loadMemory() {
    if (this.memory) return this.memory;
    try {
      this.memory = normalizeMemory(await this.store.load());
    } catch {
      this.memory = normalizeMemory(null);
    }
    return this.memory;
  }

  async saveMemory() {
    try {
      await this.store.save(this.memory);
    } catch (err) {
      this.logger.warn(`Saving the state to /data failed: ${err.message}`);
    }
  }

  /** Starts (or restarts); two starts never overlap (no leaked timer). */
  start(raw = {}) {
    const run = this.starting.then(() => this.startNow(raw));
    this.starting = run.catch(() => undefined);
    return run;
  }

  async startNow(raw = {}) {
    this.stop();
    const next = normalizeConfig(raw);
    if (placeKey(next) !== this.modelPlace) {
      // Another panel, maybe: what we knew no longer holds.
      this.model = emptyModel();
      this.seen.clear();
      this.modelPlace = placeKey(next);
    }
    this.config = next;
    this.key = sessionKey(next);
    this.code = next.code;
    this.online = false;
    if (next.listErrors.length > 0) {
      this.logger.warn(
        `Partitions, zones or outputs not understood: ${next.listErrors.join(', ')}`,
      );
    }
    if (next.codeInvalid) this.logger.warn('The user code is not 4 to 16 digits: ignored');
    await this.loadMemory();
    await this.publishDevices();
    await this.publishStates();
    const problem = this.configProblem();
    if (problem) {
      await this.setStatus(false, problem);
      return;
    }
    await this.setStatus(false, T.connecting);
    this.client.configure({
      host: next.host,
      port: next.port,
      key: next.key,
      partitions: next.partitions,
      zones: [...next.zones.keys()],
      outputs: next.outputs,
    });
    this.client.start();
    this.startSweeper();
  }

  startSweeper() {
    if (this.sweeper) this.timers.clearInterval(this.sweeper);
    this.sweeper = this.timers.setInterval(() => this.guard(() => this.sweep()), TIMINGS.sweep);
  }

  /**
   * Stops the connection. `final` only when the container stops: a restart
   * (new address) keeps the alarm_triggered retries running.
   */
  stop({ final = false } = {}) {
    this.client.stop();
    this.online = false;
    this.publisher.stop({ final });
    if (this.sweeper) {
      this.timers.clearInterval(this.sweeper);
      this.sweeper = undefined;
    }
    for (const name of ['flushTimer', 'partitionTimer']) {
      if (this[name]) this.timers.clearTimeout(this[name]);
      this[name] = undefined;
    }
    this.partitionSince = undefined;
    for (const timer of this.readBacks) this.timers.clearTimeout(timer);
    this.readBacks.clear();
  }

  configProblem() {
    if (!this.config.host) return T.noHost;
    if (this.config.keyInvalid) return T.badKey;
    if (this.config.partitions.length === 0) return T.noPartition;
    return undefined;
  }

  /** First connection to Gladys: start; a reconnection (Gladys restarted): resend everything. */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    // Gladys keeps the connection status and the discovered devices in memory.
    this.published = undefined;
    this.lastTransport = undefined;
    const status = this.lastStatus;
    this.lastStatus = undefined;
    await this.configUpdated(raw);
    if (status && this.lastStatus === undefined) {
      const [connected, message] = JSON.parse(status);
      await this.setStatus(connected, message ?? undefined);
    }
    this.publisher.forget();
    await this.publishDevices();
    await this.publishStates();
    await this.publishTransports(
      this.online ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE,
    );
  }

  /**
   * A new address, port, integration key or list reconnects; a new user
   * code lifts its stop; the rest applies at once.
   */
  async configUpdated(raw = {}) {
    const next = normalizeConfig(raw);
    // First of all: an option switched off applies to the commands at once.
    this.config = next;
    if (next.code !== this.code) {
      this.code = next.code;
      await this.liftCodeStop();
    }
    if (sessionKey(next) !== this.key) return this.start(raw);
    await this.publishDevices();
    await this.publishStates();
    if (this.online) await this.setStatus(true, this.connectedMessage());
    return undefined;
  }

  async liftCodeStop() {
    const memory = await this.loadMemory();
    if (!memory.codeStop) return;
    memory.codeStop = null;
    await this.saveMemory();
    this.logger.info('Satel: the stop on the refused user code is lifted');
  }

  /** The stop belongs to the integration (its user code), whatever the address. */
  codeStopped() {
    return Boolean(this.memory?.codeStop);
  }

  /**
   * The panel refused the user code (an answer, or a late result of a
   * command written with the current code): no command until the code
   * changes or "Allow a new try of the code" is clicked. Persisted.
   */
  async stopOnCode(why) {
    const memory = await this.loadMemory();
    const already = Boolean(memory.codeStop);
    memory.codeStop = { at: this.now() };
    if (!already) {
      this.logger.error(`Satel: the panel refused the user code (${why}): commands stopped`);
    }
    await this.saveMemory();
    // Not awaited: the ack of the command never waits for Gladys' status.
    if (this.online) this.setStatus(true, this.connectedMessage());
  }

  /** A late result: a refused code counts if a frame with the current code just left. */
  lateResult(code) {
    if (!isCodeRefusal(code)) return undefined;
    const sent = this.sentWithCode;
    const recent =
      sent &&
      sent.code === this.config.code &&
      this.now() - sent.at <= TIMINGS.answerBy + TIMINGS.uncertain;
    if (!recent) return undefined;
    return this.guard(() => this.stopOnCode('late answer'));
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  partitionsSummary() {
    return this.config.partitions.map((partition) => {
      const status = partitionStatus(this.model.lists, partition);
      return { partition, mode: status.known ? status.mode : undefined };
    });
  }

  connectedMessage() {
    const message = fill(
      T.connected,
      this.model.panel?.model ?? 'INTEGRA',
      this.partitionsSummary(),
      this.config.zones.size,
      this.config.outputs.length,
    );
    if (!this.codeStopped()) return message;
    return { en: message.en + T.codeStopped.en, fr: message.fr + T.codeStopped.fr };
  }

  // --- Client events ---------------------------------------------------------

  /** Gladys side of a new session: devices, states, status, transports, events. */
  async onUp() {
    await this.publishDevices();
    await this.flushChanges();
    await this.setStatus(true, this.connectedMessage());
    await this.publishTransports(DEVICE_TRANSPORTS.LOCAL);
  }

  /** Gladys side of a session lost (the model went offline when it was emitted). */
  async onDown({ reason, retryIn, busy, silent }, wasOnline) {
    const seconds = Math.round((retryIn ?? 0) / 1000);
    if (busy) {
      this.logger.warn(`Satel: the module is busy with another client; next try in ${seconds} s`);
      await this.setStatus(false, fill(T.busy, seconds));
    } else if (silent) {
      this.logger.warn(
        `Satel: the module never answers (integration key?); next try in ${seconds} s`,
      );
      await this.setStatus(false, fill(T.silent, seconds));
    } else {
      this.logger.warn(`Satel: ${reason}; next try in ${seconds} s`);
      await this.setStatus(false, fill(T.unreachable, reason, seconds));
    }
    if (wasOnline || this.lastTransport !== undefined) {
      await this.publishStates();
      await this.publishTransports(DEVICE_TRANSPORTS.UNREACHABLE);
    }
  }

  /**
   * A list changed. The module reports one list per frame: an arming shows
   * as several frames (armed, then its mode, then the exit time over). The
   * publication and the transitions wait settleMs so that they see the
   * whole change, once.
   */
  noteChange(partition = false) {
    if (partition) {
      // A sliding window over the partition lists, capped.
      const now = this.now();
      if (this.partitionSince === undefined) this.partitionSince = now;
      if (this.partitionTimer) this.timers.clearTimeout(this.partitionTimer);
      const wait = Math.min(this.settleMs * 1.5, this.partitionSince + this.settleMs * 4 - now);
      this.partitionTimer = this.timers.setTimeout(
        () => {
          this.partitionTimer = undefined;
          this.partitionSince = undefined;
          this.guard(() => this.flushChanges());
        },
        Math.max(0, wait),
      );
      return;
    }
    // Zones, outputs, status: at once, unless a partition change is being
    // gathered (its flush, within 1 s, publishes everything).
    if (this.flushTimer || this.partitionTimer) return;
    this.flushTimer = this.timers.setTimeout(() => {
      this.flushTimer = undefined;
      if (this.partitionTimer) return;
      this.guard(() => this.flushChanges());
    }, 0);
  }

  async flushChanges() {
    const events = [];
    for (const n of this.config.partitions) {
      const status = partitionStatus(this.model.lists, n);
      if (!status.known) continue;
      events.push(...this.transitions(n, this.seen.get(n), status));
      this.seen.set(n, status);
    }
    await this.publishStates();
    for (const event of events) await this.effect(event);
    if (this.online) await this.setStatus(true, this.connectedMessage());
  }

  /** Nothing for the first status seen of a partition after a start. */
  transitions(n, before, after) {
    if (!before) return [];
    const events = [];
    const settled = (mode) => mode !== 'arming';
    if (before.mode !== after.mode && settled(after.mode)) {
      if (after.mode === 'disarmed') {
        if (before.mode !== 'arming') events.push({ type: 'disarmed', partition: n });
      } else {
        events.push({ type: 'armed', partition: n, mode: after.mode });
      }
    }
    if ((!before.alarm && after.alarm) || (!before.fire && after.fire)) {
      events.push({ type: 'alarm', partition: n, fire: Boolean(after.fire && !before.fire) });
    }
    return events;
  }

  /** Whether a transition answers a Gladys command; the entry is used once. */
  byGladys(partition, mode) {
    const asked = this.commanded.get(partition);
    const match = Boolean(asked && asked.mode === mode && this.now() < asked.until);
    if (match) this.commanded.delete(partition);
    return match;
  }

  /** The configured zone in alarm assigned to this partition, if the panel says which. */
  zoneInAlarm(partition) {
    const alarms = this.model.lists.get(READ.ZONES_ALARM);
    if (!alarms) return undefined;
    for (const n of this.config.zones.keys()) {
      if (alarms.has(n) && this.model.names?.zone?.get(n)?.partition === partition) return n;
    }
    return undefined;
  }

  async effect(event) {
    const partition = String(event.partition);
    if (event.type === 'armed') {
      const byGladys = this.byGladys(event.partition, event.mode);
      this.logger.info(
        `Panel: partition ${partition} ARMED ${event.mode} (${byGladys ? 'Gladys command' : 'keypad or other'})`,
      );
      await this.publisher.sceneEvent(SCENE_TRIGGERS.ARMED, {
        partition,
        mode: event.mode,
        by_gladys: byGladys,
      });
    } else if (event.type === 'disarmed') {
      const byGladys = this.byGladys(event.partition, 'disarmed');
      this.logger.info(
        `Panel: partition ${partition} DISARMED (${byGladys ? 'Gladys command' : 'keypad or other'})`,
      );
      await this.publisher.sceneEvent(SCENE_TRIGGERS.DISARMED, {
        partition,
        by_gladys: byGladys,
      });
    } else if (event.type === 'alarm') {
      const zone = this.zoneInAlarm(event.partition);
      this.logger.warn(
        `Panel: ${event.fire ? 'FIRE ' : ''}ALARM partition ${partition}${zone ? ` zone ${zone}` : ''}`,
      );
      await this.publisher.sceneEvent(SCENE_TRIGGERS.ALARM_TRIGGERED, {
        partition,
        zone,
        fire: event.fire,
      });
    }
  }

  /** Heartbeats of the unchanged states; expired memories go. */
  async sweep() {
    const now = this.now();
    for (const [id, asked] of this.commanded) if (now >= asked.until) this.commanded.delete(id);
    await this.publishStates();
  }

  // --- Gladys ----------------------------------------------------------------

  devices() {
    // Nothing to show before the panel was read once (the names come from it).
    if (!this.model.panel) return undefined;
    return buildDevices(this.gladys, this.config, this.model);
  }

  async publishDevices({ force = false } = {}) {
    const devices = this.devices();
    if (!devices) return;
    const json = JSON.stringify(devices);
    if (json === this.published && !force) return;
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the devices failed: ${err.message}`);
    }
  }

  publishStates() {
    if (!this.model.panel) return Promise.resolve();
    return this.publisher.publish(
      buildStates(this.gladys, this.config, this.model, { online: this.online }),
    );
  }

  async publishTransports(transport) {
    if (transport === this.lastTransport) return;
    const devices = this.devices();
    if (!devices) return;
    const entries = devices.map((device) => ({ external_id: device.external_id, transport }));
    try {
      // At most 100 entries per request.
      for (let i = 0; i < entries.length; i += 100) {
        await this.gladys.publishTransports(entries.slice(i, i + 100));
      }
      this.lastTransport = transport;
    } catch (err) {
      this.logger.warn(`Publishing the transports failed: ${err.message}`);
    }
  }

  async scan() {
    await this.publishDevices({ force: true });
  }

  /** The user created or updated a device: Gladys has none of its states yet, send them again. */
  async deviceChanged(device) {
    this.publisher.forget(device?.external_id);
    await this.publishStates();
  }

  // --- Commands --------------------------------------------------------------

  /**
   * One command at a time; a failed one never blocks the next. A command
   * asked while another one is being handled is refused at once (nothing
   * sent): waiting behind it would spend its own 5 s (a disarm behind a slow
   * arming would come too late anyway).
   */
  serial(fn) {
    if (this.pendingCommands > 0) {
      this.logger.warn('Command REFUSED: another command is in progress');
      return Promise.reject(this.refused(T.commandBusy));
    }
    this.pendingCommands += 1;
    const run = this.commands.then(fn, fn).finally(() => {
      this.pendingCommands -= 1;
    });
    this.commands = run.catch(() => undefined);
    return run;
  }

  partitionOf(value) {
    const n = Number(value);
    if (
      value === null ||
      value === '' ||
      value === undefined ||
      !Number.isInteger(n) ||
      !this.config.partitions.includes(n)
    ) {
      throw this.refused(fill(T.unknownPartition, String(value).slice(0, 10)));
    }
    return n;
  }

  outputOf(value) {
    const n = Number(value);
    if (!Number.isInteger(n) || !this.config.outputs.includes(n)) {
      throw this.refused(fill(T.unknownOutput, String(value).slice(0, 10)));
    }
    return n;
  }

  /** A button pressed in Gladys. Only a push (1) of a button feature acts. */
  async setValue(_device, feature, value) {
    const target = parseFeatureId(feature?.external_id);
    const asked = this.now();
    const pressed = value === BUTTON_PUSH.PRESSED || value === String(BUTTON_PUSH.PRESSED);
    const action = target && `${target.kind}:${target.key}`;
    const handlers = {
      'partition:arm-away': () => this.arm(target.number, 'armed_away', asked),
      'partition:arm-stay': () => this.arm(target.number, 'armed_stay', asked),
      'partition:disarm': () => this.disarm(target.number, asked),
      'output:turn-on': () => this.output(target.number, true, asked),
      'output:turn-off': () => this.output(target.number, false, asked),
    };
    if (!handlers[action]) throw new Error(`${feature?.external_id} is read-only`);
    if (!pressed) throw new Error(`Unexpected value ${JSON.stringify(value)} for a button`);
    await handlers[action]();
  }

  isAllowed(command) {
    return Boolean(this.config[OPTIONS[command][0]]);
  }

  /** The option of a command, read again now; refused (nothing sent) once switched off. */
  checkAllowed(command, what) {
    const option = OPTIONS[command];
    if (this.isAllowed(command)) return;
    this.logger.warn(`${option[2]} REFUSED (${word(what, 'en')}): disabled in the configuration`);
    throw this.refused(option[1]);
  }

  /** Every command needs the user code; a refused one is never sent again by itself. */
  checkCode(what) {
    if (this.config.codeInvalid) throw this.refused(T.badCode);
    if (!this.config.code) throw this.refused(T.noCode);
    if (this.codeStopped()) {
      this.logger.warn(`Command REFUSED (${word(what, 'en')}): the user code was refused before`);
      throw this.refused(T.codeRefusedBefore);
    }
  }

  /** Checks run when asked, again in the queue, and again right before the write. */
  check(command, what) {
    this.checkAllowed(command, what);
    this.checkCode(what);
  }

  /**
   * Lists read from the panel now; refused (nothing sent) when they cannot be
   * read by readBy. The reads also update the model (in order with the
   * module's own reports).
   */
  async fresh(cmds, asked) {
    if (!this.client.connected) throw this.refused(T.offline);
    const readBy = asked + TIMINGS.readBy;
    try {
      const lists = new Map();
      for (const cmd of cmds) {
        const left = readBy - this.now();
        if (left < 100) throw new SatelError('too late', 'late');
        // Absolute deadline, counted from the write; a short read is no sign of a dead link.
        lists.set(
          cmd,
          await this.client.readList(cmd, { sendBy: readBy, answerBy: readBy, short: true }),
        );
      }
      return lists;
    } catch (err) {
      if (err instanceof SatelError && err.kind === 'late') throw this.refused(T.tooLate);
      if (err instanceof SatelError && err.kind === 'offline') throw this.refused(T.offline);
      // Timeout, refused or unexpected answer, lost session: unreadable.
      throw this.refused(T.stateUnknown);
    }
  }

  /** The partition status read now (the arming mode too when it is armed). */
  async freshPartition(n, asked) {
    const lists = await this.fresh(PARTITION_STATE_READS, asked);
    let status = partitionStatus(lists, n);
    if (status.armed) {
      const modes = await this.fresh(PARTITION_MODE_READS, asked);
      for (const [cmd, set] of modes) lists.set(cmd, set);
      status = partitionStatus(lists, n);
    }
    return status;
  }

  /**
   * Sends a command decided on a fresh state. Resolves when the panel
   * accepted it; throws Refused when nothing was sent, an Error otherwise.
   * Only a result of the panel (0xEF) is a refusal: no answer, an ambiguous
   * result or a lost connection after the write is "sent, without
   * confirmation", with onSent() and a read back.
   */
  async send(what, asked, run, { command, onSent, readBack }) {
    const label = word(what, 'en');
    if (this.now() > asked + TIMINGS.sendBy) {
      this.logger.warn(`Command NOT sent (${label}): too late`);
      throw this.refused(T.tooLate);
    }
    // The configuration may have changed while the command waited its turn.
    this.check(command, what);
    const code = this.config.code;
    const request = run(code, {
      sendBy: asked + TIMINGS.sendBy,
      // Absolute: the client waits from the write up to it, whatever was ahead in the queue.
      answerBy: asked + TIMINGS.answerBy,
      // The code of this frame, kept in memory: a late refusal of it stops the commands.
      onWrite: () => {
        this.sentWithCode = { code, at: this.now() };
      },
      // …and once more by the client, right before the socket write.
      check: () => {
        try {
          this.check(command, what);
          return this.config.code === code;
        } catch {
          return false;
        }
      },
    });
    try {
      await request;
    } catch (err) {
      if (err instanceof SatelError && !err.sent) {
        this.logger.warn(`Command NOT sent (${label}): ${err.message}`);
        if (err.kind === 'withdrawn') this.check(command, what);
        throw this.refused(err.kind === 'late' || err.kind === 'withdrawn' ? T.tooLate : T.offline);
      }
      if (err instanceof SatelError && err.kind === 'panel') {
        this.scheduleReadBack(readBack);
        throw await this.panelRefusal(what, err.code);
      }
      if (err instanceof SatelError && err.kind === 'ambiguous' && isCodeRefusal(err.code)) {
        // This frame or the one before (both with this code) was refused.
        await this.stopOnCode('ambiguous answer');
      }
      this.logger.warn(`Command sent, NOT confirmed (${label}): ${err.message}`);
      onSent();
      this.scheduleReadBack(readBack);
      throw this.error(fill(T.unconfirmed, word(what, this.language)), err);
    }
    onSent();
    this.logger.info(`Command accepted by the panel (${label})`);
    this.scheduleReadBack(readBack);
  }

  /** The error of a 0xEF refusal; a refused user code stops the commands (persisted). */
  async panelRefusal(what, code) {
    const label = word(what, 'en');
    const name = word(what, this.language);
    if (isCodeRefusal(code)) {
      this.logger.error(`Command REFUSED by the panel (${label}): user code refused`);
      await this.stopOnCode('refused');
      return this.error(fill(T.codeRefused, name));
    }
    this.logger.warn(`Command REFUSED by the panel (${label}): ${resultName(code)}`);
    if (code === 0x02) return this.error(fill(T.noAccess, name));
    if (code === 0x11 || code === 0x12) return this.error(fill(T.cannotArm, name));
    return this.error(fill(T.panelRefused, name, code < 0 ? '?' : resultName(code)));
  }

  scheduleReadBack(readBack) {
    const timer = this.timers.setTimeout(() => {
      this.readBacks.delete(timer);
      if (!this.client.connected) return;
      readBack().catch((err) => this.logger.debug(`Read back failed: ${err.message}`));
    }, TIMINGS.readBack);
    this.readBacks.add(timer);
  }

  // The client reports every list it reads (as a 'list' event, in order with
  // the module's own reports): a read back only has to ask.
  readBackPartition() {
    return () => this.client.readLists(PARTITION_LISTS);
  }

  readBackOutput() {
    return () => this.client.readList(READ.OUTPUTS_STATE);
  }

  async arm(rawPartition, mode, asked = this.now()) {
    if (!ARM_MODES.includes(mode)) throw new Error(`Unknown arming mode ${mode}`);
    const n = this.partitionOf(rawPartition);
    const what = fill(COMMAND_NAMES[mode], n);
    this.check('arm', what);
    return this.serial(async () => {
      this.check('arm', what);
      const status = await this.freshPartition(n, asked);
      if (status.mode === mode) {
        this.logger.info(`Partition ${n} already ${mode}: nothing sent`);
        return;
      }
      if (status.mode !== 'disarmed') {
        this.logger.warn(`Arm REFUSED (${word(what, 'en')}): partition ${n} is ${status.mode}`);
        throw this.refused(T.otherMode);
      }
      if (status.alarm || status.fire) {
        this.logger.warn(`Arm REFUSED (${word(what, 'en')}): partition ${n} is in alarm`);
        throw this.refused(T.inAlarm);
      }
      const satelMode = mode === 'armed_away' ? 0 : this.config.stayMode;
      this.check('arm', what);
      this.logger.info(`ARMING from Gladys: ${word(what, 'en')} (INTEGRA mode ${satelMode})`);
      await this.send(
        what,
        asked,
        (code, options) => this.client.arm(n, satelMode, code, options),
        {
          command: 'arm',
          onSent: () => this.commanded.set(n, { mode, until: this.now() + TIMINGS.commandMemory }),
          readBack: this.readBackPartition(),
        },
      );
    });
  }

  async disarm(rawPartition, asked = this.now()) {
    const n = this.partitionOf(rawPartition);
    const what = fill(COMMAND_NAMES.disarm, n);
    this.check('disarm', what);
    return this.serial(async () => {
      this.check('disarm', what);
      const status = await this.freshPartition(n, asked);
      if (status.mode === 'disarmed' && !status.alarm && !status.fire) {
        this.logger.info(`Partition ${n} already disarmed: nothing sent`);
        return;
      }
      this.check('disarm', what);
      this.logger.info(`DISARMING from Gladys: ${word(what, 'en')}`);
      await this.send(what, asked, (code, options) => this.client.disarm(n, code, options), {
        command: 'disarm',
        onSent: () =>
          this.commanded.set(n, { mode: 'disarmed', until: this.now() + TIMINGS.commandMemory }),
        readBack: this.readBackPartition(),
      });
    });
  }

  async output(rawOutput, on, asked = this.now()) {
    const n = this.outputOf(rawOutput);
    const what = fill(COMMAND_NAMES[on ? 'turn-on' : 'turn-off'], n);
    this.check('output', what);
    return this.serial(async () => {
      this.check('output', what);
      const lists = await this.fresh([READ.OUTPUTS_STATE], asked);
      const state = member(lists, READ.OUTPUTS_STATE, n);
      if (state === undefined) throw this.refused(T.stateUnknown);
      if (state === (on ? 1 : 0)) {
        this.logger.info(`Output ${n} already ${on ? 'on' : 'off'}: nothing sent`);
        return;
      }
      this.check('output', what);
      this.logger.info(`OUTPUT from Gladys: ${word(what, 'en')}`);
      await this.send(what, asked, (code, options) => this.client.setOutput(n, on, code, options), {
        command: 'output',
        onSent: () => undefined,
        readBack: this.readBackOutput(),
      });
    });
  }

  // --- Configuration button ----------------------------------------------------

  /** Waits for the session to come up or go down, at most `timeout` ms. */
  waitForLink(timeout = TIMINGS.testWait) {
    if (this.client.connected) return Promise.resolve('up');
    return new Promise((resolve) => {
      const done = (result) => {
        this.client.off('up', onUp);
        this.client.off('down', onDown);
        this.timers.clearTimeout(timer);
        resolve(result);
      };
      const onUp = () => done('up');
      const onDown = () => done('down');
      const timer = this.timers.setTimeout(() => done('timeout'), timeout);
      this.client.on('up', onUp);
      this.client.on('down', onDown);
    });
  }

  /**
   * "Test the connection": lifts the stop on a refused user code (the next
   * command may try it once); connects now when no connection is open (else
   * waits for the one in progress: the module takes one client only); tells
   * what the panel holds. The user code is not sent by this test.
   */
  async testConnection() {
    const problem = this.configProblem();
    if (problem) throw this.error(problem);
    if (!this.client.connected && !this.client.busy) {
      await this.setStatus(false, T.connecting);
      this.client.start();
      if (!this.sweeper) this.startSweeper();
    }
    const result = await this.waitForLink();
    await this.chain;
    if (result === 'timeout') throw this.error(T.stillConnecting);
    if (result !== 'up') {
      const [, message] = this.lastStatus ? JSON.parse(this.lastStatus) : [];
      throw this.error(message ?? T.offline);
    }
    await this.setStatus(true, this.connectedMessage());
    return this.connectedMessage();
  }

  /**
   * "Allow a new try of the code": the user's explicit go for the next
   * command to send the code again (nothing is sent now).
   */
  async allowCodeRetry() {
    if (!this.codeStopped()) return T.codeNotStopped;
    await this.liftCodeStop();
    if (this.online) await this.setStatus(true, this.connectedMessage());
    return T.codeRetryAllowed;
  }
}
