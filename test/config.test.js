// The configuration: address, lists of partitions, zones (with their kind)
// and outputs, the codes, the defaults.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseNumbers, sessionKey } from '../src/config.js';
import { fileStore, normalizeMemory } from '../src/store.js';

test('the defaults: port 7094, partition 1, arming on, disarming and outputs off', () => {
  const config = normalizeConfig({ host: '192.0.2.1' });
  assert.equal(config.port, 7094);
  assert.deepEqual(config.partitions, [1]);
  assert.equal(config.zones.size, 0);
  assert.deepEqual(
    [config.allowArm, config.allowDisarm, config.allowOutputs],
    [true, false, false],
  );
  assert.equal(config.stayMode, 1);
  assert.equal(config.code, '');
});

test('the address may carry a port; it wins over the port field', () => {
  assert.deepEqual(
    [
      normalizeConfig({ host: 'tcp://ethm.lan:7095/x', port: 1 }).host,
      normalizeConfig({ host: 'ethm.lan:7095' }).port,
    ],
    ['ethm.lan', 7095],
  );
});

test('lists: ranges, kinds, wrong entries reported, bounds kept', () => {
  const zones = parseNumbers('1-3, 5:motion; 7=smoke\n9:leak, 300, 4:fire, x', 256, {
    kinds: true,
  });
  assert.deepEqual(
    [...zones.numbers.entries()],
    [
      [1, undefined],
      [2, undefined],
      [3, undefined],
      [5, 'motion'],
      [7, 'smoke'],
      [9, 'leak'],
    ],
  );
  assert.deepEqual(zones.errors, ['300', '4:fire', 'x']);
  assert.deepEqual(parseNumbers('2:motion', 32).errors, ['2:motion'], 'no kind for a partition');
  assert.deepEqual(normalizeConfig({ partitions: '33, 2' }).partitions, [2]);
});

test('the codes: user code 4 to 16 digits, integration key 12 characters at most', () => {
  assert.equal(normalizeConfig({ user_code: ' 1234 ' }).code, '1234');
  const bad = normalizeConfig({ user_code: '12ab' });
  assert.deepEqual([bad.code, bad.codeInvalid], ['', true]);
  assert.equal(normalizeConfig({ integration_key: 'abc def' }).key, 'abc def');
  assert.equal(normalizeConfig({ integration_key: 'a'.repeat(13) }).keyInvalid, true);
});

test('the user code is not part of the session: changing it never reconnects', () => {
  const a = normalizeConfig({ host: 'h', user_code: '1111' });
  const b = normalizeConfig({ host: 'h', user_code: '2222' });
  assert.equal(sessionKey(a), sessionKey(b));
  assert.notEqual(sessionKey(a), sessionKey(normalizeConfig({ host: 'h', zones: '1' })));
});

test('the persisted state is repaired, and holds no code', async () => {
  assert.deepEqual(normalizeMemory({ codeStop: { place: 'h:7094', at: 5, code: '1' } }), {
    codeStop: { at: 5 },
  });
  // A stop in doubt is kept (M11: tied to the integration, not to an address).
  assert.deepEqual(normalizeMemory({ codeStop: { place: '' } }), { codeStop: { at: 0 } });
  assert.deepEqual(normalizeMemory({ codeStop: null }), { codeStop: null });
  assert.deepEqual(normalizeMemory('junk'), { codeStop: null });
  assert.equal(await fileStore('/nonexistent/dir/state.json').load(), null);
});
