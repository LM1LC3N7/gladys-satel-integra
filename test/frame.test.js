// Frames, checksum, masks, the code field and the AES layer, against the
// vectors of satel-integra 1.5.0's own tests (tests/test_utils.py,
// tests/test_encryption.py) and the Satel description (Appendix 4).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EncryptedSession, PduReader, SatelCipher, deriveKey } from '../src/satel/crypto.js';
import {
  FrameReader,
  checksum,
  decodeMask,
  decodeName,
  encodeCode,
  encodeFrame,
  encodeMask,
} from '../src/satel/frame.js';
import { monitoringMask, panelInfo, partitionStatus, READ } from '../src/satel/protocol.js';
import { isPriority } from '../src/publisher.js';

const frames = (bytes) => {
  const out = [];
  const drops = [];
  const reader = new FrameReader({ onFrame: (f) => out.push(f), onDrop: (why) => drops.push(why) });
  reader.push(Buffer.from(bytes));
  return { out, drops };
};

test('checksum: the known value of the Satel manual (Appendix 4)', () => {
  // FE FE E0 12 34 FF FF 8A 9B FE 0D
  assert.equal(checksum([0xe0, 0x12, 0x34, 0xff, 0xff]), 0x8a9b);
});

test('a frame: start, escaped FE, checksum, end; read back whole', () => {
  const frame = encodeFrame(0x7f, [0xfe, 0x01]);
  assert.deepEqual([...frame.subarray(0, 2)], [0xfe, 0xfe]);
  assert.deepEqual([...frame.subarray(-2)], [0xfe, 0x0d]);
  assert.deepEqual([...frame.subarray(3, 5)], [0xfe, 0xf0], 'FE in the data sent as FE F0');
  const { out } = frames(frame);
  assert.deepEqual(
    out.map((f) => [f.cmd, [...f.data]]),
    [[0x7f, [0xfe, 0x01]]],
  );
});

test('the reader: split chunks, noise, a bad checksum, a frame cut, an endless frame', () => {
  const good = encodeFrame(0x0a, [1, 0, 0, 0]);
  const reader = [];
  const r = new FrameReader({ onFrame: (f) => reader.push(f.cmd) });
  for (const b of Buffer.concat([Buffer.from('Busy!\r\n'), good, good])) r.push([b]);
  assert.deepEqual(reader, [0x0a, 0x0a], 'byte by byte, noise skipped');

  const bad = Buffer.from(good);
  bad[4] ^= 1;
  assert.deepEqual(frames(bad).drops, ['wrong checksum']);
  const cut = Buffer.concat([good.subarray(0, 5), good]);
  const result = frames(cut);
  assert.equal(result.out.length, 1, 'the second start wins');
  assert.deepEqual(result.drops, ['frame cut by a new start']);
  const endless = frames([0xfe, 0xfe, ...Array(600).fill(0x11)]);
  assert.equal(endless.out.length, 0);
  assert.ok(endless.drops.includes('frame too long'));
});

test('masks: LSB first, numbers 1..n; 256 bits; the covered size is kept', () => {
  assert.deepEqual([...encodeMask([1, 9, 32], 4)], [0x01, 0x01, 0x00, 0x80]);
  const set = decodeMask(Buffer.from([0x05, 0x00, 0x00, 0x80]));
  assert.deepEqual([...set], [1, 3, 32]);
  assert.equal(set.bits, 32);
  assert.deepEqual([...decodeMask(encodeMask([256], 32))], [256]);
  assert.throws(() => encodeMask([33], 4), RangeError);
});

test('the user code: digits as nibbles, padded with F to 8 bytes', () => {
  assert.equal(encodeCode('1234').toString('hex'), '1234ffffffffffff');
  assert.equal(encodeCode('1234567890123456').toString('hex'), '1234567890123456');
  assert.throws(() => encodeCode('12a4'), RangeError);
  assert.throws(() => encodeCode('123'), RangeError);
});

test('monitoring mask: bit cmd for each followed list (satel-integra)', () => {
  const mask = monitoringMask([0x00, 0x0a, 0x2a]);
  assert.equal(mask.length, 12);
  assert.equal(mask[0], 0x01);
  assert.equal(mask[1], 0x04);
  assert.equal(mask[5], 0x04);
});

test('panel info and names', () => {
  const info = panelInfo(Buffer.from([66, ...Buffer.from('11920200123'), 1, 0xff]));
  assert.deepEqual(info, { type: 66, model: 'INTEGRA 64 Plus', firmware: '1.19 (2020-01-23)' });
  assert.equal(panelInfo(Buffer.alloc(3)), undefined);
  assert.equal(decodeName(Buffer.from('Porte\x00\x01 entree   ', 'latin1')), 'Porte entree');
});

test('partition status: alarm, modes 0 to 3, exit time', () => {
  const lists = new Map([
    [READ.PARTITIONS_ARMED, new Set([1, 2])],
    [READ.PARTITIONS_ARMED_MODE2, new Set([2])],
    [READ.PARTITIONS_EXIT_OVER_10, new Set([3])],
    [READ.PARTITIONS_ALARM, new Set([1])],
  ]);
  assert.deepEqual(
    [1, 2, 3, 4].map((n) => partitionStatus(lists, n).mode),
    ['armed_away', 'armed_stay', 'arming', 'disarmed'],
  );
  assert.equal(partitionStatus(lists, 2).armMode, 2);
  assert.equal(partitionStatus(lists, 1).alarm, true);
  assert.equal(partitionStatus(new Map(), 1).known, false);
});

test('AES: the key rule and the vectors of satel-integra', () => {
  assert.equal(deriveKey('').toString('latin1'), ' '.repeat(24));
  assert.equal(deriveKey('short_key').toString('latin1'), 'short_key   short_key   ');
  assert.equal(deriveKey('too_long_key1234').toString('latin1'), 'too_long_keytoo_long_key');
  const plain = Buffer.from([
    0x52, 0x3d, 0x00, 0x03, 0x00, 0x54, 0xfe, 0xfe, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe,
    0xf0, 0x8a, 0xfe, 0x0d,
  ]);
  const encrypted = new SatelCipher('some_key').encrypt(plain);
  assert.equal(encrypted.toString('hex'), '43d864307e6b8431cd7559ce2ef9d41f26615c2f');
  assert.deepEqual(new SatelCipher('some_key').decrypt(encrypted), plain);
  const short = new SatelCipher('some_key').encrypt(Buffer.from('short message'));
  assert.equal(
    new SatelCipher('some_key').decrypt(short).toString('latin1'),
    'short message\x00\x00\x00',
    'a short PDU is padded with zeros',
  );
});

test('PDU: header, rolling counter, id_s checked, length byte', () => {
  const session = new EncryptedSession('key', { idS: 7, random: () => Buffer.from([1, 2]) });
  const wire = session.wrap(encodeFrame(0x0a));
  assert.equal(wire[0], wire.length - 1, 'the length byte');
  const peer = new SatelCipher('key');
  const header = peer.decrypt(wire.subarray(1)).subarray(0, 6);
  assert.deepEqual([...header], [1, 2, 0, 0, 7, 0]);
  assert.deepEqual(
    [...peer.decrypt(session.wrap(encodeFrame(0x0a)).subarray(1)).subarray(2, 4)],
    [0, 1],
  );

  const answer = peer.encrypt(
    Buffer.concat([Buffer.from([9, 9, 0, 0, 0x33, 7]), encodeFrame(0x0a)]),
  );
  const inner = session.unwrap(answer);
  assert.equal(session.idR, 0x33, 'the id of the module goes in our next PDU');
  assert.equal(frames(inner).out[0].cmd, 0x0a);
  const wrong = peer.encrypt(
    Buffer.concat([Buffer.from([9, 9, 0, 0, 0x33, 8]), encodeFrame(0x0a)]),
  );
  assert.throws(() => session.unwrap(wrong), /id_s/);

  const pdus = [];
  const reader = new PduReader({ onPdu: (p) => pdus.push(p.length), onError: () => {} });
  for (const b of [...wire, ...wire]) reader.push([b]);
  assert.deepEqual(pdus, [wire.length - 1, wire.length - 1]);
});

test('the outputs, like the zones, never eat the reserve of the partitions', () => {
  assert.equal(isPriority('ext:t:output:3:state'), false);
  assert.equal(isPriority('ext:t:zone:3:opening'), false);
  assert.equal(isPriority('ext:t:partition:1:mode'), true);
});
