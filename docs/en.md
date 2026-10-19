# Satel Integra (ETHM-1) for Gladys

This integration connects a **Satel INTEGRA** (or INTEGRA Plus) alarm panel
to Gladys Assistant, **locally** on your network, through its **ETHM-1** or
**ETHM-1 Plus** module and the integration protocol published by Satel.

> **Never tested with a real device.** The protocol comes from the
> [satel-integra](https://github.com/c-soft/satel_integra) 1.5.0 library
> (the one of the Home Assistant Satel Integra integration), ported to
> JavaScript and checked only against a simulated module. Make your first
> tries on site, with the panel disarmed, and report what goes wrong.
>
> Unofficial integration, not affiliated with SATEL.

## Before you start

- An **ETHM-1** or **ETHM-1 Plus** module connected to the panel, reachable
  from Gladys (give it a fixed address in your router).
- In DLOADX (by your installer): **the integration enabled** on the module,
  its port (7094 by default) and, on an ETHM-1 Plus, the **integration key**
  if any.
- **The module accepts one integration client at a time**: stop any other
  software connecting to it (Home Assistant, GUARDX, another Gladys). When
  it is busy, it answers "Busy": the integration says so and tries again one
  minute later at the soonest.

## What you get

- **Satel panel**: connected or not, trouble in progress, service mode.
- **One device per partition** (named by the panel):
  - **State**, read-only: disarmed, arming (exit time), armed (away), armed
    (stay, modes 1 to 3);
  - **Armed**, **Alarm in progress**, **Fire alarm**;
  - three **buttons**: arm away, arm stay, disarm.
- **One device per zone** (only the ones you list, named by the panel):
  violated or not (opening, motion, smoke or leak as chosen), **tamper**,
  alarm.
- **One device per output** (only the ones you list): on or off, and two
  **buttons**: turn on, turn off.
- **Scene triggers**: alarm triggered (with the zone when the panel gives
  it, and whether it is a fire), partition armed (mode, asked by Gladys or
  not), partition disarmed.
- **Scene actions**: arm (away or stay), disarm.

No command is a switch: a "turn everything off" from a voice assistant,
HomeKit or a scene can neither disarm the alarm nor drive an output. The
states are read-only, the commands are buttons.

## Configuration

1. **Address of the ETHM-1 module**: its IP address.
2. **Integration port**: 7094 unless changed in DLOADX.
3. **Integration key (ETHM-1 Plus)**: only if a key is set on the module (12
   characters at most). See "What travels on the network".
4. **User code** (optional): the code of an INTEGRA user (4 to 16 digits,
   prefix included), needed only for the commands; the states need none.
   Create a dedicated user, with only the partitions and rights Gladys
   needs.
5. **Partitions**: for example `1, 2` or `1-4` (`1` by default).
6. **Zones**: for example `1-6, 7:motion, 9:smoke, 10:leak`. Kinds: `opening`
   (default), `motion`, `smoke`, `leak`. Changing the kind of a zone already
   created in Gladys adds a new feature and keeps the old one (and its
   history): delete the old one by hand if you no longer want it.
7. **Outputs** (optional): for example `3, 5-6`.
8. **INTEGRA mode of "arm stay"**: 1, 2 or 3, as set up by your installer
   (arm away is mode 0).
9. **Safety**: see below.
10. **Language of the names**: French or English.

The integration key and the user code are secret fields: kept by Gladys in
its database, never shown again in the interface, used only with the module.
They never appear in the logs nor in `/data`.

The **Test the connection** button connects at once when no connection is
open (otherwise it waits for the one in progress: the module takes one
client only) and tells the model, the state of the partitions and the number
of zones and outputs. It does not send the user code.

## What travels on the network

- **ETHM-1, or ETHM-1 Plus without an integration key: everything travels in
  clear text** on your local network, the user code of each command
  included. Any device of your network listening to the traffic can read
  it.
- **ETHM-1 Plus with an integration key**: the exchanges are protected with
  AES using that key (satel-integra's method). Set the same key on both
  sides; when they differ, the module never answers and the integration
  tells you.
- Protect your network (a separate guest Wi-Fi for the devices you are not
  sure of) and give Gladys an INTEGRA user with limited rights.

## Safety

- **Arming** is allowed by default (option "Allow arming from Gladys"), with
  the user code.
- **Disarming is off by default.** Once the option is checked, **every Gladys
  user, every scene and the Gladys mobile app can disarm, with the code of
  the configuration, without typing any code**. Allow it only if your Gladys
  is well protected (accounts, remote access).
- **The outputs are off by default**, behind their own option: an output may
  drive a siren, a gate or a lock. Check what each one does first.
- The options are read again right before each send: an option unchecked
  while a command waits its turn stops that command.
- Before each command, the integration **reads the state from the panel
  again** and decides on that state, never on what it has in memory (already
  in the state asked: nothing is sent; armed in another mode: refused,
  disarm first). Commands go one at a time.
- A command that cannot leave in time (slow panel, unreadable state) is
  refused with "nothing was sent". A command sent without a clear answer (no
  answer, an ambiguous answer, a cut) is reported "sent, without
  confirmation" and the state is read again two seconds later: it is never
  reported "not sent". Only a refusal answer of the panel is reported
  "refused" (code refused, no right, cannot arm…).
- **When the panel refuses the user code, the integration never sends it
  again by itself**, even after a restart (an INTEGRA may raise an alarm or
  lock the keypads after several wrong codes). The states keep coming.
  Change the code in the configuration, or click "Test the connection" to
  allow one new try at the next command. The file `/data/satel-state.json`
  keeps only the address concerned, never the code.
- Every command, sent or refused, is written in the integration logs; the
  codes never are.

## Connection

- One connection at a time, never two: at least 5 seconds between two
  connections.
- On a cut, the new tries are spaced: 10 s, 30 s, 1 min, 2 min, then every 5
  minutes; at least one minute when the module answers "Busy".
- A message every 15 seconds of silence keeps the connection open (the
  module drops a silent client after 25 s); with nothing received for 45 s,
  the integration reconnects.

## Known limits

- Never tested with a real device (see above).
- The "zone tamper" (0x01) and "zone alarm" (0x02) lists come from the Satel
  description of the protocol, not from satel-integra: not checked.
- Zones and outputs over 128 (INTEGRA 256 Plus) are asked in the 32-byte
  format: not checked.
- Names are read as Latin-1; Satel's own characters may be replaced.
- No zone temperatures, no separate alarm clearing (0x85), no event log in
  this version.
- An alarm already in progress when the integration starts fires no scene
  (only the changes seen do).

## Privacy

Everything stays on your network: the integration only talks to the ETHM-1
module.

## Licence

Apache-2.0. Protocol logic ported from satel-integra 1.5.0 (MIT, Krzysztof
Machelski): see `THIRD_PARTY_NOTICES.md`.
