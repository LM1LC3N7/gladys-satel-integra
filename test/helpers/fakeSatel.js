// -----------------------------------------------------------------------------
// An in-memory ETHM-1 module of an INTEGRA panel: no socket, no network.
// `connect` is given to the client in place of net.createConnection; each
// call opens a connection that behaves as satel-integra's ETHM simulator
// describes the module (one client at a time and "Busy!" for the next one,
// the answers to the reads, 0xEF to the commands, the monitoring that sends
// every followed list then each change), with the AES layer of the ETHM-1
// Plus when the fake has an integration key. It records every frame the
// client sent.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { PduReader, SatelCipher } from '../../src/satel/crypto.js';
import { FrameReader, decodeMask, encodeFrame, encodeMask } from '../../src/satel/frame.js';

/** Lets every queued delivery and the promise chains behind it run. */
export async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Waits until `check()` is true, at most `timeout` ms (the client listens 300 ms after connecting). */
export async function until(check, timeout = 6_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (check()) return;
    await settle(5);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition never met');
}

const LISTS = {
  0x00: 'violated',
  0x01: 'tamper',
  0x02: 'zoneAlarm',
  0x09: 'armedSuppressed',
  0x0a: 'armed',
  0x0b: 'mode2',
  0x0c: 'mode3',
  0x0e: 'entry',
  0x0f: 'exitOver',
  0x10: 'exitUnder',
  0x13: 'alarm',
  0x14: 'fire',
  0x17: 'outputs',
  0x2a: 'mode1',
};
const WIDE = new Set([0x00, 0x01, 0x02, 0x17]);

class FakeSocket extends EventEmitter {
  constructor(server) {
    super();
    this.server = server;
    this.destroyed = false;
    this.writableLength = 0;
    this.reader = new FrameReader({ onFrame: (frame) => server.receive(this, frame) });
    if (server.key) {
      this.cipher = new SatelCipher(server.key);
      this.moduleIdS = 0x40;
      this.counter = 0;
      this.pdus = new PduReader({
        onPdu: (pdu) => {
          const plain = this.cipher.decrypt(pdu);
          this.clientIdS = plain[4];
          this.reader.push(plain.subarray(6));
        },
        onError: () => undefined,
      });
    }
  }

  setNoDelay() {}

  write(bytes) {
    if (this.destroyed) throw new Error('write after destroy');
    const copy = Buffer.from(bytes);
    queueMicrotask(() => {
      if (this.destroyed) return;
      if (this.pdus) this.pdus.push(copy);
      else this.reader.push(copy);
    });
    return true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    queueMicrotask(() => this.emit('close'));
  }

  /** Server side: a frame to the client. */
  send(cmd, data = []) {
    if (this.destroyed) return;
    let bytes = encodeFrame(cmd, data);
    if (this.cipher) {
      const header = Buffer.from([0x12, 0x34, this.counter >> 8, this.counter & 0xff]);
      this.counter = (this.counter + 1) & 0xffff;
      const idR = this.server.wrongIdS ? (this.clientIdS ?? 0) ^ 0xff : (this.clientIdS ?? 0);
      const pdu = this.cipher.encrypt(
        Buffer.concat([header, Buffer.from([this.moduleIdS, idR]), bytes]),
      );
      bytes = Buffer.concat([Buffer.from([pdu.length]), pdu]);
    }
    const frame = bytes;
    queueMicrotask(() => {
      if (!this.destroyed) this.emit('data', frame);
    });
  }

  raw(bytes) {
    queueMicrotask(() => {
      if (!this.destroyed) this.emit('data', Buffer.from(bytes));
    });
  }
}

const defaultNames = () => ({
  partition: { 1: 'Maison', 2: 'Garage' },
  zone: { 1: ['Porte entree', 1], 2: ['Couloir', 1], 5: ['Garage', 2] },
  output: { 3: 'Portail' },
});

export class FakeEthm {
  constructor({
    code = '1234',
    key = '',
    type = 66,
    maskBytes = 32,
    names = defaultNames(),
    busy = false,
    silent = false,
    refuseConnections = 0,
  } = {}) {
    this.code = code;
    this.key = key;
    this.type = type;
    this.maskBytes = maskBytes;
    this.names = names;
    this.busy = busy;
    this.silent = silent;
    this.refuseConnections = refuseConnections;
    this.state = Object.fromEntries(Object.values(LISTS).map((name) => [name, new Set()]));
    this.troubles = false;
    this.pushChanges = true;
    /** Result code for every command (0x80..0x89), undefined: the normal one. */
    this.rejectCode = undefined;
    this.sockets = [];
    /** Every frame the client sent: [{ session, cmd, data }]. */
    this.log = [];
    /** (cmd, data) -> true: that frame gets no answer. */
    this.hold = () => false;
    /** (cmd, data) -> a promise: that frame is answered once it resolves. */
    this.gate = () => undefined;
    this.monitoring = new Set();
    this.connect = this.connect.bind(this);
  }

  connect(options) {
    this.options = options;
    const socket = new FakeSocket(this);
    socket.session = this.sockets.length + 1;
    this.sockets.push(socket);
    if (this.refuseConnections > 0) {
      this.refuseConnections -= 1;
      queueMicrotask(() => {
        const err = new Error('connect ECONNREFUSED');
        err.code = 'ECONNREFUSED';
        socket.emit('error', err);
      });
      return socket;
    }
    const open = this.sockets.filter((s) => s !== socket && !s.destroyed).length;
    this.maxOpen = Math.max(this.maxOpen ?? 0, open + 1);
    queueMicrotask(() => {
      socket.emit('connect');
      if (this.busy || open > 0) {
        socket.raw(Buffer.from('Busy!\r\n'));
        socket.destroy();
      }
    });
    this.monitoring = new Set();
    return socket;
  }

  get current() {
    return this.sockets.at(-1);
  }

  /** The commands of the current session, keep-alives (0x1A) left out. */
  get requests() {
    const session = this.current?.session;
    return this.log.filter((e) => e.session === session && e.cmd !== 0x1a).map((e) => e.cmd);
  }

  /** The control frames (0x80..0x89), every session. */
  get commands() {
    return this.log.filter((e) => e.cmd >= 0x80 && e.cmd <= 0x89);
  }

  receive(socket, { cmd, data }) {
    this.log.push({ session: socket.session, cmd, data });
    if (this.silent || this.hold(cmd, data)) return;
    const gate = this.gate(cmd, data);
    if (gate) {
      gate.then(() => this.respond(socket, cmd, data));
      return;
    }
    this.respond(socket, cmd, data);
  }

  list(cmd) {
    const size = WIDE.has(cmd) ? this.maskBytes : 4;
    return encodeMask(
      [...this.state[LISTS[cmd]]].filter((n) => n <= size * 8),
      size,
    );
  }

  respond(socket, cmd, data) {
    if (cmd === 0x7f) {
      this.monitoring = new Set(
        [...decodeMask(data.subarray(0, 12))].map((bit) => bit - 1).filter((c) => LISTS[c]),
      );
      socket.send(0xef, [0x00]);
      for (const c of [...this.monitoring].sort((a, b) => a - b)) socket.send(c, this.list(c));
      return;
    }
    if (LISTS[cmd] !== undefined) {
      socket.send(cmd, this.list(cmd));
      return;
    }
    if (cmd === 0x7e) {
      socket.send(0x7e, [this.type, ...Buffer.from('11920200123'), 1, 0xff]);
      return;
    }
    if (cmd === 0x1a) {
      socket.send(0x1a, [0x20, 0x26, 0x10, 0x19, 0x12, 0x00, 0x00, this.troubles ? 0x40 : 0, 0]);
      return;
    }
    if (cmd === 0xee) {
      this.name(socket, data);
      return;
    }
    if (cmd >= 0x80 && cmd <= 0x89) {
      this.control(socket, cmd, data);
      return;
    }
    // Unknown command: the module stays silent.
  }

  name(socket, data) {
    const [selector, number] = data;
    const kind = { 0x10: 'partition', 0x05: 'zone', 0x04: 'output' }[selector];
    const n = number === 0 ? 256 : number;
    const entry = this.names[kind]?.[n];
    if (entry === undefined) {
      socket.send(0xef, [0x08]);
      return;
    }
    const [label, assignment] = Array.isArray(entry) ? entry : [entry, 0];
    const name = Buffer.alloc(16, 0x20);
    Buffer.from(label, 'latin1').copy(name);
    const out = [selector, number, 1, ...name];
    if (kind !== 'output') out.push(assignment ?? 0);
    socket.send(0xee, out);
  }

  control(socket, cmd, data) {
    if (this.rejectCode !== undefined) {
      socket.send(0xef, [this.rejectCode]);
      return;
    }
    const code = data.subarray(0, 8).toString('hex').replace(/f+$/, '');
    if (code !== this.code) {
      socket.send(0xef, [0x01]);
      return;
    }
    socket.send(0xef, [0xff]);
    const numbers = [...decodeMask(data.subarray(8))];
    const s = this.state;
    for (const n of numbers) {
      if (cmd >= 0x80 && cmd <= 0x83) {
        s.armed.add(n);
        s.armedSuppressed.add(n);
        const mode = cmd - 0x80;
        if (mode > 0) s[`mode${mode}`].add(n);
      } else if (cmd === 0x84) {
        for (const name of ['armed', 'armedSuppressed', 'mode1', 'mode2', 'mode3', 'alarm']) {
          s[name].delete(n);
        }
      } else if (cmd === 0x88) {
        s.outputs.add(n);
      } else if (cmd === 0x89) {
        s.outputs.delete(n);
      }
    }
    if (!this.pushChanges) return;
    const changed =
      cmd >= 0x88 ? [0x17] : [0x09, 0x0a, 0x2a, 0x0b, 0x0c, ...(cmd === 0x84 ? [0x13] : [])];
    for (const c of changed) this.push(c);
  }

  /** A change on the panel side: sent by the module if the client follows that list. */
  set(name, n, on) {
    if (on) this.state[name].add(n);
    else this.state[name].delete(n);
    const cmd = Number(Object.keys(LISTS).find((c) => LISTS[c] === name));
    this.push(cmd);
  }

  push(cmd) {
    if (this.monitoring.has(cmd)) this.current?.send(cmd, this.list(cmd));
  }

  /** The module closes the connection. */
  drop() {
    this.current.destroy();
  }
}

export const quietLogger = () => {
  const lines = [];
  const log = (level) => (message) => lines.push(`${level} ${message}`);
  return {
    lines,
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
  };
};
