// The TCP client alone, against the in-memory module, on mocked timers: the
// spaced reconnections, one connection at a time, the silent module (wrong
// integration key), the keep-alive, the watchdog, the ambiguous result.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIMINGS } from '../src/constants.js';
import { SatelClient, SatelError } from '../src/satel/client.js';
import { FakeEthm, quietLogger, settle } from './helpers/fakeSatel.js';

function setup(t, panelOptions = {}, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const panel = new FakeEthm(panelOptions);
  const logger = quietLogger();
  const client = new SatelClient({ connect: panel.connect, logger });
  client.configure({
    host: '192.0.2.30',
    port: 7094,
    partitions: [1],
    zones: [1],
    outputs: [],
    ...options,
  });
  const downs = [];
  const ups = [];
  client.on('down', (info) => downs.push(info));
  client.on('up', (info) => ups.push(info));
  t.after(() => client.stop());
  return { panel, client, logger, downs, ups };
}

/** Advances the mocked clock by `ms`, `step` at a time, letting the I/O run. */
async function advance(t, ms, step = 100) {
  for (let left = ms; left > 0; left -= Math.min(step, left)) {
    t.mock.timers.tick(Math.min(step, left));
    await settle(3);
  }
}

test('a silent module: spaced tries, one connection at a time, then the key is suspected', async (t) => {
  const ctx = setup(t, { silent: true });
  ctx.client.start();
  await settle();
  await advance(t, TIMINGS.greeting + TIMINGS.requestTimeout + 200);
  assert.equal(ctx.downs.length, 1);
  assert.equal(ctx.downs[0].retryIn, 10_000);
  assert.equal(ctx.downs[0].silent, false, 'once could be anything');
  await advance(t, 9_000);
  assert.equal(ctx.panel.sockets.length, 1, 'never sooner than 10 s');
  await advance(t, 1_000 + TIMINGS.greeting + TIMINGS.requestTimeout + 200);
  assert.equal(ctx.panel.sockets.length, 2);
  assert.equal(ctx.downs.length, 2);
  assert.equal(ctx.downs[1].silent, true, 'twice in a row: the integration key is suspected');
  assert.equal(ctx.downs[1].retryIn, 30_000);
  assert.equal(ctx.panel.maxOpen, 1, 'never two connections at once');
});

test('the backoff grows to 5 minutes and stays there; a refused connection is not a loop', async (t) => {
  const ctx = setup(t, { refuseConnections: 10 });
  ctx.client.start();
  await settle();
  const total = TIMINGS.backoff.reduce((sum, wait) => sum + wait, 0) + 300_000;
  await advance(t, total, 1_000);
  assert.deepEqual(
    ctx.downs.map((d) => d.retryIn),
    [...TIMINGS.backoff, 300_000, 300_000],
  );
});

test('up: the monitoring, the lists, then a keep-alive after 15 s without a request', async (t) => {
  const ctx = setup(t);
  ctx.client.start();
  await settle();
  await advance(t, TIMINGS.greeting);
  assert.equal(ctx.ups.length, 1);
  const { snapshot } = ctx.ups[0];
  assert.equal(snapshot.panel.model, 'INTEGRA 64 Plus');
  assert.equal(snapshot.names.partition.get(1).name, 'Maison');
  assert.equal(snapshot.lists.size, 14, 'every followed list was read');
  const keepAlives = () => ctx.panel.log.filter((e) => e.cmd === 0x1a).length;
  await advance(t, TIMINGS.keepAlive - 2_000);
  assert.equal(keepAlives(), 0);
  await advance(t, 3_000);
  assert.equal(keepAlives(), 1);
});

test('the watchdog: nothing received for 45 s drops the link', async (t) => {
  const ctx = setup(t);
  ctx.client.start();
  await settle();
  await advance(t, TIMINGS.greeting);
  ctx.panel.silent = true;
  await advance(t, TIMINGS.watchdog + 2_000);
  assert.equal(ctx.downs.length, 1);
  assert.equal(ctx.downs[0].wasUp, true);
});

test('a result after a command timed out is ambiguous, never a plain success', async (t) => {
  const ctx = setup(t);
  ctx.client.start();
  await settle();
  await advance(t, TIMINGS.greeting);
  let held = true;
  ctx.panel.hold = (cmd) => cmd === 0x80 && held;
  const first = ctx.client.arm(1, 0, '1234').catch((err) => err);
  await advance(t, TIMINGS.requestTimeout);
  const timedOut = await first;
  assert.ok(timedOut instanceof SatelError);
  assert.deepEqual([timedOut.kind, timedOut.sent], ['timeout', true]);
  held = false;
  const second = await ctx.client.arm(1, 0, '1234').catch((err) => err);
  assert.equal(second.kind, 'ambiguous', 'the result may answer the first one');
  // M2: the second command's own answer is still to come: still uncertain.
  const third = await ctx.client.arm(1, 0, '1234').catch((err) => err);
  assert.equal(third.kind, 'ambiguous', 'still uncertain after an ambiguous result');
  await advance(t, TIMINGS.uncertain + 500);
  const fourth = await ctx.client.arm(1, 0, '1234');
  assert.equal(fourth, 0xff, 'in step again once the window is over');
});

test('M2/I1: a late result with nothing in flight is reported, and puts the line in step', async (t) => {
  const ctx = setup(t);
  ctx.client.start();
  await settle();
  await advance(t, TIMINGS.greeting);
  const results = [];
  ctx.client.on('result', (r) => results.push(r.code));
  let release;
  ctx.panel.gate = (cmd) => (cmd === 0x80 ? new Promise((r) => (release = r)) : undefined);
  const first = ctx.client.arm(1, 0, '9999').catch((err) => err);
  await advance(t, TIMINGS.requestTimeout);
  assert.equal((await first).kind, 'timeout');
  release();
  await settle();
  assert.deepEqual(results, [0x01], 'the late refusal of the code is reported');
  ctx.panel.gate = () => undefined;
  assert.equal(await ctx.client.arm(1, 0, '1234'), 0xff, 'in step again');
});

test('I1: a read never takes a refused-code result as its answer', async (t) => {
  const ctx = setup(t);
  ctx.client.start();
  await settle();
  await advance(t, TIMINGS.greeting);
  const results = [];
  ctx.client.on('result', (r) => results.push(r.code));
  let answer;
  ctx.panel.gate = (cmd) => (cmd === 0x0a ? new Promise((r) => (answer = r)) : undefined);
  const read = ctx.client.readList(0x0a);
  await settle();
  ctx.panel.current.send(0xef, [0x01]); // a late refusal lands while the read waits
  await settle();
  answer();
  await settle();
  assert.ok((await read) instanceof Set, 'the read got its own answer');
  assert.deepEqual(results, [0x01]);
});

test('M5: a result of another length than 1 byte is "sent, without confirmation"', async (t) => {
  const ctx = setup(t);
  ctx.client.start();
  await settle();
  await advance(t, TIMINGS.greeting);
  ctx.panel.hold = (cmd) => cmd === 0x80;
  const pending = ctx.client.arm(1, 0, '1234').catch((err) => err);
  await settle();
  ctx.panel.current.send(0xef, [0x01, 0x00]);
  await settle();
  const err = await pending;
  assert.deepEqual([err.kind, err.sent], ['unexpected', true]);
});

test('M6: short reads before a command never drop the link by their timeouts', async (t) => {
  const ctx = setup(t);
  ctx.client.start();
  await settle();
  await advance(t, TIMINGS.greeting);
  ctx.panel.hold = (cmd) => cmd === 0x0a;
  for (let i = 0; i < 4; i += 1) {
    const read = ctx.client
      .readList(0x0a, { answerBy: Date.now() + 300, short: true })
      .catch((e) => e);
    await advance(t, 400);
    assert.equal((await read).kind, 'timeout');
  }
  assert.equal(ctx.downs.length, 0, 'still connected after 4 short timeouts');
  assert.equal(ctx.client.connected, true);
});

test('I2: the answer of a command is awaited up to its absolute deadline, from the write', async (t) => {
  const ctx = setup(t);
  ctx.client.start();
  await settle();
  await advance(t, TIMINGS.greeting);
  let release;
  ctx.panel.gate = (cmd) => (cmd === 0x0b ? new Promise((r) => (release = r)) : undefined);
  ctx.panel.hold = (cmd) => cmd === 0x80;
  const started = Date.now();
  const slow = ctx.client.readList(0x0b);
  const command = ctx.client
    .arm(1, 0, '1234', { sendBy: started + 3_500, answerBy: started + 4_500 })
    .catch((err) => err);
  await advance(t, 3_000);
  release(); // the read ahead answers at +3 s: the command is written then
  let settledAt;
  command.then(() => (settledAt = Date.now()));
  await slow;
  await advance(t, 2_000);
  const err = await command;
  assert.equal(err.kind, 'timeout');
  assert.ok(settledAt - started <= 4_600, `answered at +${settledAt - started} ms`);
});

test('M4: a flood of malformed frames: a few log lines, then the link is cut', async (t) => {
  const ctx = setup(t);
  ctx.client.start();
  await settle();
  await advance(t, TIMINGS.greeting);
  const before = ctx.logger.lines.length;
  const bytes = Buffer.alloc(300_000);
  for (let i = 0; i < bytes.length; i += 3) bytes.set([0xfe, 0xfe, 0x00], i);
  ctx.panel.current.emit('data', bytes);
  await settle();
  const lines = ctx.logger.lines.slice(before).filter((l) => /dropped/.test(l));
  assert.ok(lines.length <= 3, `${lines.length} log lines`);
  assert.equal(ctx.downs.length, 1);
  assert.match(ctx.downs[0].reason, /malformed/);
});

test('M4: AES, a stream of empty PDUs: the same bound', async (t) => {
  const ctx = setup(t, { key: 'Klucz123' }, { key: 'Klucz123' });
  ctx.client.start();
  await settle();
  await advance(t, TIMINGS.greeting);
  assert.equal(ctx.client.connected, true);
  const before = ctx.logger.lines.length;
  ctx.panel.current.emit('data', Buffer.alloc(200_000, 0));
  await settle();
  assert.ok(ctx.logger.lines.length - before <= 4);
  assert.equal(ctx.downs.length, 1);
});

test('a request is never written after its deadline', async (t) => {
  const ctx = setup(t);
  ctx.client.start();
  await settle();
  await advance(t, TIMINGS.greeting);
  ctx.panel.hold = (cmd) => cmd === 0x0a;
  const blocking = ctx.client.readList(0x0a).catch((err) => err);
  const sendBy = Date.now() + 1_000;
  const late = ctx.client.arm(1, 0, '1234', { sendBy }).catch((err) => err);
  await advance(t, 1_500);
  const err = await late;
  assert.deepEqual([err.kind, err.sent], ['late', false]);
  await advance(t, TIMINGS.requestTimeout);
  await blocking;
  assert.equal(ctx.panel.commands.length, 0);
});

test('"Busy!" after connecting: at least 60 s before the next try', async (t) => {
  const ctx = setup(t, { busy: true });
  ctx.client.start();
  await settle();
  assert.equal(ctx.downs[0].busy, true);
  assert.equal(ctx.downs[0].retryIn, TIMINGS.busyRetry);
  await advance(t, TIMINGS.busyRetry - 1_000);
  assert.equal(ctx.panel.sockets.length, 1);
});
