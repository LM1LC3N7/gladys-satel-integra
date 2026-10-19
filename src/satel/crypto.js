// -----------------------------------------------------------------------------
// The AES layer of the ETHM-1 Plus (its "integration key"), ported from
// satel-integra 1.5.0 `encryption.py` and `transport.py` (MIT, see
// THIRD_PARTY_NOTICES.md), on node:crypto:
// - the key: the integration key (ASCII, 12 characters at most, padded with
//   spaces) written twice -> 24 bytes, AES-192;
// - the PDU: 2 random bytes, a 16-bit rolling counter, id_s, id_r, then the
//   whole frame (FE FE … FE 0D), transformed block by block (AES-ECB chained
//   with the previous output, the last partial block XORed with the
//   transformed chaining value), a PDU shorter than 16 bytes padded with 0;
// - on the wire: one length byte, then the PDU;
// - the answer must carry, as its 6th byte, the id_s we sent; its 5th byte is
//   the id_r of our next PDU.
//
// Changed from satel-integra: the reader is a linear state machine with a
// bounded PDU (one length byte: 255 at most), never a partial `read(n)`; an
// id_s mismatch is a protocol error of the session (satel-integra raises
// too); the integration key is never logged.
// -----------------------------------------------------------------------------

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const BLOCK = 16;

/** The 24-byte AES key derived from the integration key (satel-integra's rule). */
export function deriveKey(integrationKey) {
  const ascii = Buffer.from(String(integrationKey ?? ''), 'latin1');
  const key = Buffer.alloc(24, 0x20);
  for (let i = 0; i < 12; i += 1) {
    if (i < ascii.length) {
      key[i] = ascii[i];
      key[i + 12] = ascii[i];
    }
  }
  return key;
}

export class SatelCipher {
  constructor(integrationKey) {
    const key = deriveKey(integrationKey);
    this.encryptor = createCipheriv('aes-192-ecb', key, null).setAutoPadding(false);
    this.decryptor = createDecipheriv('aes-192-ecb', key, null).setAutoPadding(false);
  }

  e(block) {
    return this.encryptor.update(block);
  }

  d(block) {
    return this.decryptor.update(block);
  }

  encrypt(input) {
    let data = Buffer.from(input);
    if (data.length < BLOCK) data = Buffer.concat([data, Buffer.alloc(BLOCK - data.length)]);
    const out = Buffer.alloc(data.length);
    let cv = this.e(Buffer.alloc(BLOCK));
    for (let at = 0; at < data.length; at += BLOCK) {
      const block = data.subarray(at, at + BLOCK);
      if (block.length === BLOCK) {
        const p = this.e(xor(block, cv));
        p.copy(out, at);
        cv = p;
      } else {
        cv = this.e(cv);
        xor(block, cv).copy(out, at);
      }
    }
    return out;
  }

  decrypt(input) {
    const data = Buffer.from(input);
    const out = Buffer.alloc(data.length);
    let cv = this.e(Buffer.alloc(BLOCK));
    for (let at = 0; at < data.length; at += BLOCK) {
      const block = data.subarray(at, at + BLOCK);
      if (block.length === BLOCK) {
        xor(this.d(block), cv).copy(out, at);
        cv = Buffer.from(block);
      } else {
        cv = this.e(cv);
        xor(block, cv).copy(out, at);
      }
    }
    return out;
  }
}

/** a XOR b, over the length of a. */
function xor(a, b) {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i += 1) out[i] = a[i] ^ b[i];
  return out;
}

/** One connection's PDU state (a new one per TCP connection, as satel-integra). */
export class EncryptedSession {
  constructor(integrationKey, { idS = 0, random = randomBytes } = {}) {
    this.cipher = new SatelCipher(integrationKey);
    this.counter = 0;
    this.idS = idS & 0xff;
    this.idR = 0;
    this.random = random;
  }

  /** A frame -> the bytes on the wire (length byte + PDU). */
  wrap(frame) {
    const header = Buffer.alloc(6);
    this.random(2).copy(header, 0);
    header.writeUInt16BE(this.counter, 2);
    header[4] = this.idS;
    header[5] = this.idR;
    this.counter = (this.counter + 1) & 0xffff;
    const pdu = this.cipher.encrypt(Buffer.concat([header, frame]));
    if (pdu.length > 255) throw new RangeError('frame too long for one PDU');
    return Buffer.concat([Buffer.from([pdu.length]), pdu]);
  }

  /** A PDU from the module -> its inner bytes; throws on an id_s mismatch. */
  unwrap(pdu) {
    const plain = this.cipher.decrypt(pdu);
    if (plain.length < 6) throw new Error('PDU too short');
    if (plain[5] !== this.idS) throw new Error('unexpected PDU identifier (id_s)');
    this.idR = plain[4];
    return plain.subarray(6);
  }
}

/** Cuts the length-prefixed PDUs out of the byte stream, in one pass. */
export class PduReader {
  constructor({ onPdu, onError }) {
    this.onPdu = onPdu;
    this.onError = onError;
    this.want = 0;
    this.buffer = [];
  }

  push(chunk) {
    for (const b of chunk) {
      if (this.want === 0) {
        if (b === 0) {
          this.onError('empty PDU');
          continue;
        }
        this.want = b;
        this.buffer = [];
        continue;
      }
      this.buffer.push(b);
      if (this.buffer.length === this.want) {
        const pdu = Buffer.from(this.buffer);
        this.want = 0;
        this.buffer = [];
        this.onPdu(pdu);
      }
    }
  }
}
