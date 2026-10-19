// -----------------------------------------------------------------------------
// The frames of the Satel INTEGRA protocol (ETHM-1 / ETHM-1 Plus / INT-RS),
// ported from satel-integra 1.5.0 (MIT, see THIRD_PARTY_NOTICES.md):
// `utils.py` (checksum, bit masks, device numbers), `messages.py` (frame
// layout, the FE FE start, the FE 0D end, the FE -> FE F0 escape), `const.py`.
//
// Frame: FE FE | cmd | data… | crc.hi crc.lo | FE 0D, every FE between the
// start and the end sent as FE F0.
//
// Changed from satel-integra: the reader is one linear state machine over the
// bytes received (no `readuntil` + `replace`), with a bounded frame length;
// a FE followed by anything but F0 or 0D inside a frame drops the frame and
// starts a new one (the description's synchronisation rule).
// -----------------------------------------------------------------------------

export const FE = 0xfe;
const ESCAPED = 0xf0;
const END = 0x0d;

/** The longest frame of this protocol (0xEE answers: 1 + 20 + 2) is far below this. */
export const MAX_FRAME = 256;

/** The checksum of the Satel description (Appendix 4), over cmd + data. */
export function checksum(bytes) {
  let crc = 0x147a;
  for (const b of bytes) {
    crc = ((crc << 1) & 0xffff) | ((crc & 0x8000) >>> 15);
    crc ^= 0xffff;
    crc = (crc + (crc >>> 8) + b) & 0xffff;
  }
  return crc;
}

/** cmd + data -> the bytes on the wire. */
export function encodeFrame(cmd, data = []) {
  const payload = [cmd & 0xff, ...data];
  const crc = checksum(payload);
  payload.push(crc >>> 8, crc & 0xff);
  const out = [FE, FE];
  for (const b of payload) {
    out.push(b);
    if (b === FE) out.push(ESCAPED);
  }
  out.push(FE, END);
  return Buffer.from(out);
}

/**
 * Cuts the frames out of a byte stream, in one pass. `onFrame({ cmd, data })`
 * gets each frame whose checksum is right; `onDrop(reason)` the others.
 * Bytes outside a frame (padding, a "Busy!" text) are skipped.
 */
export class FrameReader {
  constructor({ onFrame, onDrop = () => {}, maxFrame = MAX_FRAME } = {}) {
    this.onFrame = onFrame;
    this.onDrop = onDrop;
    this.maxFrame = maxFrame;
    this.buffer = [];
    this.inFrame = false;
    this.pendingFe = false;
  }

  push(chunk) {
    for (const b of chunk) this.byte(b);
  }

  byte(b) {
    if (this.pendingFe) {
      this.pendingFe = false;
      if (b === ESCAPED) {
        if (this.inFrame) this.add(FE);
        return;
      }
      if (b === END) {
        if (this.inFrame) this.finish();
        return;
      }
      if (this.inFrame && this.buffer.length > 0) this.onDrop('frame cut by a new start');
      // FE FE (or FE + another byte): a new frame starts.
      this.buffer = [];
      this.inFrame = true;
      if (b === FE) return;
      this.add(b);
      return;
    }
    if (b === FE) {
      this.pendingFe = true;
      return;
    }
    if (this.inFrame) this.add(b);
  }

  add(b) {
    if (this.buffer.length >= this.maxFrame) {
      this.onDrop('frame too long');
      this.buffer = [];
      this.inFrame = false;
      return;
    }
    this.buffer.push(b);
  }

  finish() {
    const bytes = this.buffer;
    this.buffer = [];
    this.inFrame = false;
    if (bytes.length < 3) {
      this.onDrop('frame too short');
      return;
    }
    const body = bytes.slice(0, -2);
    const received = (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1];
    if (checksum(body) !== received) {
      this.onDrop('wrong checksum');
      return;
    }
    this.onFrame({ cmd: body[0], data: Buffer.from(body.slice(1)) });
  }
}

/** Numbers 1..n (LSB first: byte 0 bit 0 is number 1) -> a mask of `length` bytes. */
export function encodeMask(numbers, length) {
  const out = Buffer.alloc(length);
  for (const n of numbers) {
    if (!Number.isInteger(n) || n < 1 || n > length * 8) {
      throw new RangeError(`number ${n} out of a ${length}-byte mask`);
    }
    out[(n - 1) >> 3] |= 1 << ((n - 1) & 7);
  }
  return out;
}

/**
 * A mask -> the set of the numbers whose bit is 1. `set.bits` keeps how
 * many numbers the mask covered: a zone over it is unknown, not "off".
 */
export function decodeMask(bytes) {
  const set = new Set();
  set.bits = bytes.length * 8;
  for (let i = 0; i < bytes.length; i += 1) {
    for (let bit = 0; bit < 8; bit += 1) if (bytes[i] & (1 << bit)) set.add(i * 8 + bit + 1);
  }
  return set;
}

/**
 * The user code field: the digits as hexadecimal nibbles, padded with F to
 * 8 bytes (satel-integra: `bytearray.fromhex(code.ljust(16, "F"))`).
 */
export function encodeCode(code) {
  const text = String(code ?? '');
  if (!/^\d{4,16}$/.test(text)) throw new RangeError('the user code must be 4 to 16 digits');
  return Buffer.from(text.padEnd(16, 'F'), 'hex');
}

/** One-byte device numbers: 256 is sent as 0 (satel-integra `encode_device_number`). */
export const encodeDeviceNumber = (n) => (n === 256 ? 0 : n);
export const decodeDeviceNumber = (b) => (b === 0 ? 256 : b);

/** A 16-byte name of the panel (Latin-1 in satel-integra): trimmed, control characters out. */
export function decodeName(bytes) {
  let text = '';
  for (const b of bytes) text += b < 0x20 || b === 0x7f ? ' ' : String.fromCharCode(b);
  return text.replace(/\s+/g, ' ').trim();
}
