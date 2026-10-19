# Satel Integra (ETHM-1) for Gladys Assistant

External integration for [Gladys Assistant](https://gladysassistant.com):
**Satel INTEGRA** alarm panels through their **ETHM-1 / ETHM-1 Plus** module,
**locally** over TCP with the integration protocol published by Satel.

> **Never tested with a real device.** Unofficial, not affiliated with SATEL.

- Partitions: state (disarmed, arming, armed away, armed stay), armed, alarm,
  fire alarm; arm away, arm stay and disarm **buttons**.
- Zones (the ones you list): violated (opening, motion, smoke, leak), tamper,
  alarm.
- Outputs (the ones you list): on / off state; turn on and turn off
  **buttons**.
- Panel: link, trouble, service mode.
- Scene triggers: alarm triggered, partition armed, partition disarmed. Scene
  actions: arm, disarm.
- Safety: arming allowed; **disarming and outputs off by default**, each
  behind its own option; every command decided on the state read from the
  panel right before it, one at a time; the user code and the integration
  key are secret fields, never logged; a refused user code is never sent
  again by itself, even across restarts; one TCP connection only (the
  module takes one client), spaced reconnections.
- ETHM-1 Plus integration key supported (AES, as satel-integra). Without it
  (ETHM-1, or ETHM-1 Plus without a key) the traffic, user code included,
  is in clear text on the local network: see the guides.

User guides: [français](docs/fr.md), [English](docs/en.md).

## Development

```bash
npm install
npm test               # node --test (Node 22 and 24), against an in-memory ETHM-1
npm run lint
npm run format:check
npm run audit          # npm audit --omit=dev
npx github:GladysAssistant/integration-store .
```

Layout: `src/satel/` (frames, AES layer, protocol, TCP client), `src/app.js`
(devices, states, scene events, commands), `src/devices.js`,
`src/publisher.js` (rate limits), `test/helpers/fakeSatel.js` (the simulated
module). See `CLAUDE.md` and `TODO.md`.

## Credits and licence

Apache-2.0 (`LICENSE`). The protocol is ported from
[satel-integra](https://github.com/c-soft/satel_integra) 1.5.0 by Krzysztof
Machelski and contributors (MIT): see `THIRD_PARTY_NOTICES.md`.
