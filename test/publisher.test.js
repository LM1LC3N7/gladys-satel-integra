// The state and scene event budgets, the deduplication, the heartbeats.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, TIMINGS } from '../src/constants.js';
import { Budget, StatePublisher } from '../src/publisher.js';
import { quietLogger, settle } from './helpers/fakeSatel.js';

const recorder = () => {
  const sent = [];
  return {
    sent,
    gladys: {
      publishStates: async (batch) => {
        assert.ok(batch.length <= 100, 'at most 100 states per request');
        sent.push(...batch);
        return { success: true };
      },
    },
  };
};

const zone = (i, value) => ({
  device_feature_external_id: `ext:t:zone:${i}:opening`,
  state: value,
});
const mode = (value) => ({ device_feature_external_id: 'ext:t:partition:1:mode', text: value });

test('a budget frees what leaves the one-minute window', () => {
  let now = 0;
  const budget = new Budget(10, () => now);
  budget.spend(8);
  now = 30_000;
  budget.spend(2);
  assert.equal(budget.left, 0);
  assert.equal(budget.wait, 30_000);
  now = 60_000;
  assert.equal(budget.left, 8);
});

test('only the values that changed are sent; forget sends them again', async () => {
  const { sent, gladys } = recorder();
  const publisher = new StatePublisher({ gladys, logger: quietLogger() });
  await publisher.publish([zone(1, 0), mode('disarmed')]);
  await publisher.publish([zone(1, 0), mode('disarmed')]);
  assert.equal(sent.length, 2);
  await publisher.publish([zone(1, 1)]);
  assert.equal(sent.length, 3);
  publisher.forget('ext:t:partition:1');
  await publisher.publish([zone(1, 1), mode('disarmed')]);
  assert.deepEqual(sent.at(-1), mode('disarmed'));
  assert.equal(sent.length, 4);
  publisher.stop();
});

test('over budget: the zones wait, the panel and partitions keep their part', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { sent, gladys } = recorder();
  const publisher = new StatePublisher({ gladys, logger: quietLogger() });
  await publisher.publish(
    Array.from({ length: LIMITS.statesPerMinute + 20 }, (_, i) => zone(i, 1)),
  );
  assert.equal(sent.length, LIMITS.statesPerMinute - LIMITS.priorityStates, 'the reserve is kept');
  // A mode change goes through at once, through the reserve.
  await publisher.publish([mode('armed_away')]);
  assert.deepEqual(sent.at(-1), mode('armed_away'));
  // A newer value of a waiting zone replaces it.
  await publisher.publish([zone(LIMITS.statesPerMinute + 5, 0)]);
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(sent.length, LIMITS.statesPerMinute + 20 + 1);
  const late = sent.filter((s) =>
    s.device_feature_external_id.endsWith(`:${LIMITS.statesPerMinute + 5}:opening`),
  );
  assert.deepEqual(
    late.map((s) => s.state),
    [0],
  );
  publisher.stop();
});

test('heartbeats: an unchanged value again after 30 minutes, offset per feature', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { sent, gladys } = recorder();
  const publisher = new StatePublisher({ gladys, logger: quietLogger() });
  const states = Array.from({ length: 50 }, (_, i) => zone(i, 1));
  await publisher.publish(states);
  t.mock.timers.tick(TIMINGS.stateHeartbeat - 1);
  await publisher.publish(states);
  assert.equal(sent.length, 50, 'not due yet');
  t.mock.timers.tick(TIMINGS.heartbeatSpread / 2);
  await publisher.publish(states);
  const first = sent.length - 50;
  assert.ok(first > 0 && first < 50, `${first} heartbeats: spread, not one burst`);
  t.mock.timers.tick(TIMINGS.heartbeatSpread);
  await publisher.publish(states);
  assert.equal(sent.length, 100);
  publisher.stop();
});

test('scene events over their budget are dropped, alarm_triggered never', async () => {
  const events = [];
  const logger = quietLogger();
  const publisher = new StatePublisher({
    gladys: { publishSceneEvent: async (key) => events.push(key) },
    logger,
  });
  for (let i = 0; i < LIMITS.eventsPerMinute + 3; i += 1) await publisher.sceneEvent('armed', {});
  assert.equal(events.length, LIMITS.eventsPerMinute);
  assert.equal(logger.lines.filter((l) => /dropped/.test(l)).length, 3);
  await publisher.sceneEvent('alarm_triggered', {});
  assert.equal(events.at(-1), 'alarm_triggered');
});

test('alarm_triggered refused by Gladys is tried again, three times in all', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let calls = 0;
  const publisher = new StatePublisher({
    gladys: {
      publishSceneEvent: async () => {
        calls += 1;
        throw new Error('429 TOO_MANY_REQUESTS');
      },
    },
    logger: quietLogger(),
  });
  await publisher.sceneEvent('alarm_triggered', {});
  for (const wait of TIMINGS.alarmEventRetry) {
    t.mock.timers.tick(wait);
    await settle();
  }
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(calls, LIMITS.alarmEventTries);
  await publisher.sceneEvent('armed', {});
  assert.equal(calls, LIMITS.alarmEventTries + 1, 'other events are not retried');
  publisher.stop({ final: true });
});

test('a restart keeps the alarm_triggered retries, the container stop cancels them', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let calls = 0;
  const publisher = new StatePublisher({
    gladys: {
      publishSceneEvent: async () => {
        calls += 1;
        if (calls === 1) throw new Error('network down');
      },
    },
    logger: quietLogger(),
  });
  await publisher.sceneEvent('alarm_triggered', {});
  publisher.stop(); // a new address or access code: the session restarts
  t.mock.timers.tick(TIMINGS.alarmEventRetry[0]);
  await settle();
  assert.equal(calls, 2, 'the retry still ran');

  calls = 0;
  await publisher.sceneEvent('alarm_triggered', {});
  publisher.stop({ final: true }); // the container stops
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(calls, 1, 'no retry after the final stop');
});

test('a value is never dropped while another one of the feature is on its way', async () => {
  const sent = [];
  let release;
  let hang = false;
  const gladys = {
    publishStates: (batch) => {
      sent.push(...batch);
      if (hang) {
        hang = false;
        return new Promise((resolve) => (release = resolve));
      }
      return Promise.resolve({ success: true });
    },
  };
  const publisher = new StatePublisher({ gladys, logger: quietLogger() });
  await publisher.publish([mode('disarmed')]); // accepted by Gladys
  hang = true;
  const done = publisher.publish([mode('armed_away')]); // on its way, slow
  await settle();
  // Back to "disarmed" while "armed_away" travels: equal to the last accepted
  // value, but Gladys is about to hold armed_away: it must be sent.
  publisher.publish([mode('disarmed')]);
  assert.equal(publisher.pending.size, 1, 'queued, not dropped');
  // The same value as the one on its way adds nothing.
  publisher.publish([mode('armed_away')]);
  assert.equal(publisher.pending.size, 0);
  publisher.publish([mode('disarmed')]);
  release({ success: true });
  await done;
  await publisher.flush();
  assert.deepEqual(
    sent.map((s) => s.text),
    ['disarmed', 'armed_away', 'disarmed'],
  );
  publisher.stop({ final: true });
});

test('M8/N3: a value forgotten while on its way is queued again', async () => {
  let release;
  const sent = [];
  let hang = true;
  const gladys = {
    publishStates: (batch) => {
      sent.push(...batch);
      if (hang) {
        hang = false;
        return new Promise((resolve) => (release = resolve));
      }
      return Promise.resolve({ success: true });
    },
  };
  const publisher = new StatePublisher({ gladys, logger: quietLogger() });
  const done = publisher.publish([mode('disarmed')]);
  await settle();
  publisher.forget('ext:t:partition:1'); // the user created the device meanwhile
  release({ success: true });
  await done;
  assert.equal(publisher.pending.size, 1, 'queued again, without a new publish');
  await publisher.flush();
  assert.equal(sent.length, 2, 'Gladys gets the value of the new device');
  publisher.stop({ final: true });
});
