// SatelApp with the SDK's fake Gladys (createFakeGladys) and the in-memory
// ETHM-1 module (test/helpers/fakeSatel.js): the whole chain from the frames
// to the Gladys devices, states, scene events and commands.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { SatelApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import { FakeEthm, quietLogger, settle, until } from './helpers/fakeSatel.js';

const BASE = {
  host: '192.0.2.30',
  user_code: '1234',
  partitions: '1, 2',
  zones: '1, 2:motion, 5',
  outputs: '3',
  language: 'en',
};

async function setup(t, { config = {}, panel: panelOptions = {}, store, devices } = {}) {
  const gladys = createFakeGladys({ config: { ...BASE, ...config }, devices });
  const panel = new FakeEthm(panelOptions);
  const logger = quietLogger();
  const memory = store ?? memoryStore();
  const app = new SatelApp({ gladys, logger, connect: panel.connect, store: memory, settleMs: 0 });
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  t.after(() => app.stop({ final: true }));
  const device = (externalId) =>
    gladys.fake.discoveredDevices.find((d) => d.external_id === externalId);
  return {
    gladys,
    panel,
    app,
    logger,
    store: memory,
    device,
    panelIds: gladys.externalIds('panel', 'satel'),
    partition: (n = 1) => gladys.externalIds('partition', String(n)),
    zone: (n) => gladys.externalIds('zone', String(n)),
    output: (n) => gladys.externalIds('output', String(n)),
    state: (id) => gladys.fake.lastState(id),
    events: () => gladys.fake.sceneEvents,
    press: (ids, key, value = 1) => {
      const d = device(ids.device);
      const feature = d.features.find((f) => f.external_id === ids.feature(key));
      return gladys.fake.setValue(d, feature, value);
    },
  };
}

const up = async (ctx) => {
  await until(() => ctx.app.online);
  await ctx.app.chain;
  await settle();
};

/** A change on the panel, reported by the module, then flushed to Gladys. */
const change = async (ctx, name, n, on) => {
  ctx.panel.set(name, n, on);
  await settle();
  // The app gathers the reports of one change (settleMs, 0 here) before it flushes.
  await new Promise((resolve) => setTimeout(resolve, 10));
  await ctx.app.chain;
  await settle();
};

test('start: devices named by the panel, read-only states, push buttons, status', async (t) => {
  const ctx = await setup(t);
  await up(ctx);
  const { gladys, partition, zone, output, panelIds } = ctx;
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((d) => [d.external_id, d.name]),
    [
      [panelIds.device, 'Satel panel'],
      [partition(1).device, 'Maison'],
      [partition(2).device, 'Garage'],
      [zone(1).device, 'Porte entree'],
      [zone(2).device, 'Couloir'],
      [zone(5).device, 'Garage'],
      [output(3).device, 'Portail'],
    ],
  );
  for (const d of gladys.fake.discoveredDevices) {
    for (const f of d.features) {
      assert.notEqual(f.category, 'switch', `${f.external_id}: never a switch`);
      if (f.read_only === false) {
        assert.deepEqual([f.category, f.type], ['button', 'push'], `${f.external_id}: a button`);
      }
    }
  }
  assert.deepEqual(
    ctx
      .device(output(3).device)
      .features.filter((f) => !f.read_only)
      .map((f) => f.external_id.split(':').at(-1)),
    ['turn-on', 'turn-off'],
  );
  assert.equal(ctx.device(zone(2).device).features[0].category, 'motion-sensor');
  assert.equal(ctx.device(zone(1).device).features[0].category, 'opening-sensor');
  assert.deepEqual(ctx.device(zone(5).device).params.at(-1), { name: 'partition', value: '2' });
  assert.equal(ctx.device(panelIds.device).model, 'INTEGRA 64 Plus');
  assert.equal(ctx.state(partition(1).feature('mode')), 'Disarmed');
  assert.equal(ctx.state(zone(1).feature('opening')), 1, 'opening: 1 = closed (core)');
  assert.equal(ctx.state(output(3).feature('state')), 0);
  assert.equal(ctx.state(panelIds.feature('online')), 1);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(
    gladys.fake.connectionStatus.message.en,
    /INTEGRA 64 Plus panel \(1: disarmed, 2: disarmed\), 3 zone\(s\), 1 output/,
  );
  assert.ok(gladys.fake.transports.every((entry) => entry.transport === 'local'));
  // The monitoring was asked once, then every followed list was read.
  assert.equal(ctx.panel.requests.filter((c) => c === 0x7f).length, 1);
});

test('reports of the module become states and scene events', async (t) => {
  const ctx = await setup(t);
  await up(ctx);
  const { partition, zone } = ctx;
  await change(ctx, 'violated', 1, true);
  await change(ctx, 'tamper', 2, true);
  assert.equal(ctx.state(zone(1).feature('opening')), 0, 'open');
  assert.equal(ctx.state(zone(2).feature('tamper')), 1);
  // Armed from a keypad: exit time first, then armed.
  await change(ctx, 'exitOver', 1, true);
  assert.equal(ctx.state(partition(1).feature('mode')), 'Arming');
  ctx.panel.state.exitOver.delete(1);
  ctx.panel.state.armedSuppressed.add(1);
  ctx.panel.push(0x0f);
  ctx.panel.push(0x09);
  await change(ctx, 'armed', 1, true);
  assert.equal(ctx.state(partition(1).feature('mode')), 'Armed (away)');
  assert.deepEqual(ctx.events().at(-1), {
    key: 'armed',
    data: { partition: '1', mode: 'armed_away', by_gladys: false },
  });
  ctx.panel.state.zoneAlarm.add(1);
  ctx.panel.push(0x02);
  await change(ctx, 'alarm', 1, true);
  assert.deepEqual(ctx.events().at(-1), {
    key: 'alarm_triggered',
    data: { partition: '1', zone: 1, fire: false },
  });
  assert.equal(ctx.state(partition(1).feature('alarm')), 1);
  for (const name of ['armed', 'armedSuppressed']) ctx.panel.state[name].delete(1);
  ctx.panel.push(0x0a);
  ctx.panel.push(0x09);
  await change(ctx, 'alarm', 1, false);
  assert.deepEqual(ctx.events().at(-1), {
    key: 'disarmed',
    data: { partition: '1', by_gladys: false },
  });
  assert.equal(ctx.events().filter((e) => e.key === 'armed').length, 1, 'one event per arming');
});

test('arm away: decided on the lists read now, sent once with the code, credited to Gladys', async (t) => {
  const ctx = await setup(t);
  await up(ctx);
  const before = ctx.panel.log.length;
  const ack = await ctx.press(ctx.partition(1), 'arm-away');
  assert.equal(ack.success, true, ack.error);
  const sent = ctx.panel.log.slice(before).map((e) => e.cmd);
  assert.deepEqual(sent.slice(0, 6), [0x0a, 0x09, 0x0f, 0x10, 0x13, 0x14], 'fresh reads first');
  assert.equal(sent[6], 0x80, 'then the arming, mode 0');
  const command = ctx.panel.commands.at(-1);
  assert.equal(command.data.subarray(0, 8).toString('hex'), '1234ffffffffffff');
  assert.deepEqual([...command.data.subarray(8)], [1, 0, 0, 0]);
  await until(() => ctx.events().some((e) => e.key === 'armed'));
  assert.deepEqual(ctx.events().at(-1).data, {
    partition: '1',
    mode: 'armed_away',
    by_gladys: true,
  });
  assert.equal(ctx.state(ctx.partition(1).feature('mode')), 'Armed (away)');
  // Already armed: nothing sent. Stay while armed away: refused, nothing sent.
  assert.equal((await ctx.press(ctx.partition(1), 'arm-away')).success, true);
  const stay = await ctx.press(ctx.partition(1), 'arm-stay');
  assert.equal(stay.success, false);
  assert.match(stay.error, /another mode.*nothing was sent/);
  assert.equal(ctx.panel.commands.length, 1);
  assert.ok(!ctx.logger.lines.some((l) => l.includes('1234')), 'the code is never logged');
});

test('arm stay uses the configured INTEGRA mode', async (t) => {
  const ctx = await setup(t, { config: { stay_mode: '2' } });
  await up(ctx);
  const ack = await ctx.press(ctx.partition(2), 'arm-stay');
  assert.equal(ack.success, true, ack.error);
  assert.equal(ctx.panel.commands.at(-1).cmd, 0x82);
  await until(() => ctx.state(ctx.partition(2).feature('mode')) === 'Armed (stay)');
});

test('the memory never decides: the lists read before the command do', async (t) => {
  const ctx = await setup(t);
  await up(ctx);
  ctx.panel.pushChanges = false;
  // Armed from a keypad, nothing reported: Gladys still shows disarmed.
  ctx.panel.state.armed.add(1);
  ctx.panel.state.mode1.add(1);
  assert.equal(ctx.state(ctx.partition(1).feature('mode')), 'Disarmed');
  const ack = await ctx.press(ctx.partition(1), 'arm-away');
  assert.equal(ack.success, false);
  assert.match(ack.error, /another mode/);
  assert.equal(ctx.panel.commands.length, 0);
});

test('disarming is off by default: nothing read, nothing sent', async (t) => {
  const ctx = await setup(t);
  await up(ctx);
  ctx.panel.state.armed.add(1);
  const before = ctx.panel.log.length;
  const ack = await ctx.press(ctx.partition(1), 'disarm');
  assert.equal(ack.success, false);
  assert.match(ack.error, /Disarming from Gladys is disabled.*nothing was sent/);
  assert.equal(ctx.panel.log.length, before);
  await assert.rejects(ctx.app.disarm('1'), /disabled/);
});

test('disarm, once allowed: sent only when the partition is armed', async (t) => {
  const ctx = await setup(t, { config: { allow_disarm: true } });
  await up(ctx);
  assert.equal((await ctx.press(ctx.partition(1), 'disarm')).success, true);
  assert.equal(ctx.panel.commands.length, 0, 'already disarmed: nothing sent');
  await change(ctx, 'armed', 1, true);
  const ack = await ctx.press(ctx.partition(1), 'disarm');
  assert.equal(ack.success, true, ack.error);
  assert.equal(ctx.panel.commands.at(-1).cmd, 0x84);
  await until(() => ctx.events().some((e) => e.key === 'disarmed'));
  assert.deepEqual(ctx.events().at(-1).data, { partition: '1', by_gladys: true });
});

test('outputs are off by default; once allowed, decided on the output state read now', async (t) => {
  const off = await setup(t);
  await up(off);
  const refused = await off.press(off.output(3), 'turn-on');
  assert.equal(refused.success, false);
  assert.match(refused.error, /outputs from Gladys is disabled/);
  assert.equal(off.panel.commands.length, 0);
  off.app.stop({ final: true });

  const ctx = await setup(t, { config: { allow_outputs: true } });
  await up(ctx);
  assert.equal((await ctx.press(ctx.output(3), 'turn-off')).success, true);
  assert.equal(ctx.panel.commands.length, 0, 'already off: nothing sent');
  const ack = await ctx.press(ctx.output(3), 'turn-on');
  assert.equal(ack.success, true, ack.error);
  const command = ctx.panel.commands.at(-1);
  assert.equal(command.cmd, 0x88);
  assert.equal(command.data.length, 8 + 32);
  await until(() => ctx.state(ctx.output(3).feature('state')) === 1);
  // A value that is not a push is refused; a read-only feature too.
  assert.equal((await ctx.press(ctx.output(3), 'turn-on', 0)).success, false);
  assert.equal((await ctx.press(ctx.output(3), 'state')).success, false);
});

test('a refused user code stops the commands, across restarts, without the code in /data', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { config: { user_code: '9999' }, store });
  await up(ctx);
  const ack = await ctx.press(ctx.partition(1), 'arm-away');
  assert.equal(ack.success, false);
  assert.match(ack.error, /refused the user code/);
  assert.equal(ctx.panel.commands.length, 1);
  assert.deepEqual(Object.keys(store.data.codeStop), ['place', 'at']);
  assert.ok(!JSON.stringify(store.data).includes('9999'));
  // Never sent again by itself.
  const again = await ctx.press(ctx.partition(1), 'arm-away');
  assert.match(again.error, /refused this user code before.*nothing was sent/);
  assert.equal(ctx.panel.commands.length, 1);
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /refused the user code/);
  ctx.app.stop({ final: true });

  // A restart (same configuration) keeps the stop; monitoring still works.
  const restarted = await setup(t, { config: { user_code: '9999' }, store });
  await up(restarted);
  assert.match((await restarted.press(restarted.partition(1), 'arm-away')).error, /before/);
  assert.equal(restarted.panel.commands.length, 0);
  // A new code lifts it.
  await restarted.app.configUpdated({ ...BASE, user_code: '1234' });
  assert.equal(store.data.codeStop, null);
  const ok = await restarted.press(restarted.partition(1), 'arm-away');
  assert.equal(ok.success, true, ok.error);
});

test('"Test the connection" lifts the code stop (one new try) and tells the panel', async (t) => {
  const store = memoryStore({ codeStop: { place: '192.0.2.30:7094', at: 1 } });
  const ctx = await setup(t, { store });
  await up(ctx);
  assert.match((await ctx.press(ctx.partition(1), 'arm-away')).error, /before/);
  const result = await ctx.gladys.fake.action('test_connection');
  assert.equal(result.success, true, result.error);
  assert.match(JSON.stringify(result), /INTEGRA 64 Plus/);
  assert.equal(store.data.codeStop, null);
  assert.equal((await ctx.press(ctx.partition(1), 'arm-away')).success, true);
});

test('without a user code: monitoring only, commands refused with a clear message', async (t) => {
  const ctx = await setup(t, { config: { user_code: '' } });
  await up(ctx);
  const ack = await ctx.press(ctx.partition(1), 'arm-away');
  assert.match(ack.error, /Enter a user code/);
  assert.equal(ctx.panel.commands.length, 0);
  await change(ctx, 'violated', 5, true);
  assert.equal(ctx.state(ctx.zone(5).feature('opening')), 0);
});

test('an option switched off while the command waits: withdrawn, nothing sent', async (t) => {
  const ctx = await setup(t);
  await up(ctx);
  let open;
  const gate = new Promise((resolve) => (open = resolve));
  ctx.panel.gate = (cmd) => (cmd === 0x14 ? gate : undefined);
  const pending = ctx.press(ctx.partition(1), 'arm-away');
  await until(() => ctx.panel.log.some((e) => e.cmd === 0x14));
  ctx.app.config = { ...ctx.app.config, allowArm: false };
  open();
  const ack = await pending;
  assert.equal(ack.success, false);
  assert.match(ack.error, /Arming from Gladys is disabled/);
  assert.equal(ctx.panel.commands.length, 0);
});

test('no answer to the command: "sent, without confirmation", never "not sent"', async (t) => {
  const ctx = await setup(t);
  await up(ctx);
  ctx.panel.hold = (cmd) => cmd === 0x80;
  const ack = await ctx.press(ctx.partition(1), 'arm-away');
  assert.equal(ack.success, false);
  assert.match(ack.error, /Sent to the panel.*without confirmation/);
  assert.ok(ctx.logger.lines.some((l) => /Command sent, NOT confirmed/.test(l)));
});

test('a panel refusal (cannot arm) is told, with no stop', async (t) => {
  const ctx = await setup(t);
  await up(ctx);
  ctx.panel.rejectCode = 0x12;
  const ack = await ctx.press(ctx.partition(1), 'arm-away');
  assert.match(ack.error, /cannot arm now/);
  ctx.panel.rejectCode = undefined;
  assert.equal((await ctx.press(ctx.partition(1), 'arm-away')).success, true);
});

test('state unreadable in time: refused, nothing sent, within the Gladys ack', async (t) => {
  const ctx = await setup(t);
  await up(ctx);
  ctx.panel.hold = (cmd) => cmd === 0x0a;
  const started = Date.now();
  const ack = await ctx.press(ctx.partition(1), 'arm-away');
  assert.equal(ack.success, false);
  assert.match(ack.error, /could not be read|too slowly/);
  assert.ok(Date.now() - started < 4_000, 'answered before Gladys gives up (5 s)');
  assert.equal(ctx.panel.commands.length, 0);
});

test('scene actions: arm and disarm, a missing partition refused', async (t) => {
  const ctx = await setup(t, { config: { allow_disarm: true } });
  await up(ctx);
  await ctx.app.arm('2', 'armed_away');
  assert.equal(ctx.panel.commands.at(-1).cmd, 0x80);
  await assert.rejects(ctx.app.arm(undefined, 'armed_away'), /not in the configuration/);
  await assert.rejects(ctx.app.arm('7', 'armed_away'), /not in the configuration/);
  await assert.rejects(ctx.app.arm('1', 'armed_night'), /Unknown arming mode/);
  await until(() => ctx.state(ctx.partition(2).feature('mode')) === 'Armed (away)');
  await ctx.app.disarm('2');
  assert.equal(ctx.panel.commands.at(-1).cmd, 0x84);
});

test('the module is busy with another client: told, retried later, never two connections', async (t) => {
  const ctx = await setup(t, { panel: { busy: true } });
  await until(() =>
    /busy with another client/.test(ctx.gladys.fake.connectionStatus?.message?.en ?? ''),
  );
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /Next try in 60 s/);
  assert.equal(ctx.panel.sockets.length, 1);
  assert.equal(ctx.panel.log.length, 0, 'nothing sent to a busy module');
});

test('the AES layer of the ETHM-1 Plus, end to end', async (t) => {
  const ctx = await setup(t, {
    config: { integration_key: 'Klucz123' },
    panel: { key: 'Klucz123' },
  });
  await up(ctx);
  assert.equal(ctx.state(ctx.partition(1).feature('mode')), 'Disarmed');
  const ack = await ctx.press(ctx.partition(1), 'arm-away');
  assert.equal(ack.success, true, ack.error);
  assert.ok(!ctx.logger.lines.some((l) => l.includes('Klucz123')), 'the key is never logged');
});

test('a wrong integration key: the module answers nothing usable, the link drops', async (t) => {
  const ctx = await setup(t, {
    config: { integration_key: 'Klucz123' },
    panel: { key: 'Klucz123', wrongIdS: true },
  });
  ctx.panel.wrongIdS = true;
  await until(
    () =>
      ctx.gladys.fake.connectionStatus?.connected === false &&
      /unreadable|unreachable/.test(ctx.gladys.fake.connectionStatus.message.en),
  );
  assert.equal(ctx.app.online, false);
});

test('a bad configuration: told in the status, nothing opened', async (t) => {
  const ctx = await setup(t, { config: { integration_key: 'much-too-long-key' } });
  await settle();
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /12 characters/);
  assert.equal(ctx.panel.sockets.length, 0);
});

test('Gladys restarted: status, devices and states sent again', async (t) => {
  const ctx = await setup(t);
  await up(ctx);
  const published = ctx.gladys.fake.discoveredDevices.length;
  const statuses = ctx.gladys.fake.connectionStatuses.length;
  await ctx.app.connected(await ctx.gladys.getConfig());
  assert.ok(ctx.gladys.fake.connectionStatuses.length > statuses, 'the status is sent again');
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
  assert.equal(ctx.gladys.fake.discoveredDevices.length, published);
  assert.equal(ctx.panel.sockets.length, 1, 'the module connection is kept');
});

test('the module drops the link: offline, states unreachable, one connection again later', async (t) => {
  const ctx = await setup(t);
  await up(ctx);
  ctx.panel.drop();
  await until(() => ctx.gladys.fake.connectionStatus.connected === false);
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /next try in 10 s/);
  assert.equal(ctx.state(ctx.panelIds.feature('online')), 0);
  assert.ok(ctx.gladys.fake.transports.some((e) => e.transport === 'unreachable'));
  assert.equal(ctx.panel.maxOpen, 1);
});
