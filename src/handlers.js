// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the tests, so
// the tests run the exact wiring of the container.
// -----------------------------------------------------------------------------

import { ACTIONS, SCENE_ACTIONS } from './constants.js';

export function registerHandlers(gladys, app, logger) {
  // Discovery: the panel, its partitions, zones and outputs.
  gladys.onScanRequest(() => app.scan());
  gladys.onDeviceCreated((device) => app.deviceChanged(device));
  gladys.onDeviceUpdated((device) => app.deviceChanged(device));

  // The buttons (arm away, arm stay, disarm, output on / off).
  gladys.onSetValue((device, feature, value) => app.setValue(device, feature, value));

  // Configuration screen buttons.
  gladys.onAction(ACTIONS.TEST_CONNECTION, () => app.testConnection());
  gladys.onAction(ACTIONS.ALLOW_CODE_RETRY, () => app.allowCodeRetry());

  // Scene actions.
  // A missing partition or mode is refused, never guessed: Gladys sends the
  // manifest defaults itself when the user left them.
  gladys.onSceneAction(SCENE_ACTIONS.ARM, async (fields) => {
    await app.arm(fields?.partition, fields?.mode);
    return undefined;
  });
  gladys.onSceneAction(SCENE_ACTIONS.DISARM, async (fields) => {
    await app.disarm(fields?.partition);
    return undefined;
  });

  // Configuration changed by the user.
  gladys.onConfigUpdated((config) => app.configUpdated(config));

  // Connection lifecycle: the first connection starts, a reconnection resends.
  gladys.on('connected', async () => {
    try {
      await app.connected(await gladys.getConfig());
    } catch (err) {
      logger?.error('Start failed', err);
    }
  });
}
