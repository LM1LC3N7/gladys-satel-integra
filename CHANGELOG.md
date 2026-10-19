# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Local connection to Satel INTEGRA panels through the ETHM-1 / ETHM-1 Plus
  module over TCP (port 7094), with the protocol of satel-integra 1.5.0:
  frames, checksum, "Busy" check, monitoring, keep-alive, names of the
  partitions, zones and outputs read from the panel.
- ETHM-1 Plus integration key (AES layer of satel-integra), as a secret
  field.
- One device per configured partition: read-only state (disarmed, arming,
  armed away, armed stay), armed, alarm, fire alarm, and arm away / arm stay
  / disarm push buttons (never a switch); the INTEGRA mode of "arm stay" is
  configurable (1, 2 or 3).
- One device per configured zone: violated (opening, motion, smoke or leak),
  tamper, alarm.
- One device per configured output: state, and turn on / turn off push
  buttons.
- The panel: link, trouble, service mode.
- Scene triggers `alarm_triggered` (zone, fire), `armed`, `disarmed`; scene
  actions `arm` and `disarm`; a "Test the connection" button.
- State and scene event budgets under the Gladys limits.
- French and English names, messages and guides.

### Security

- Disarming and the outputs are off by default, each behind its own option;
  arming has its own option too. The options are read when the command is
  asked, again after the fresh read, and once more right before the write.
- Every command decided on the lists read from the panel just before it,
  one at a time, sent within 3.5 s or not at all; a command that may have
  left is reported "sent, without confirmation" and read again; after a
  command timed out, a result is treated as ambiguous for 10 s.
- A user code refused by the panel stops the commands, kept across restarts
  in `/data` (the address only, never the code); lifted by a new code or by
  "Test the connection". The user code and the integration key are never
  logged.
- One TCP connection only (the module takes one client), at least 5 s
  between two, spaced reconnections (10 s to 5 min, at least 60 s after
  "Busy"); bounded frames and PDUs, linear parsing.
- Docs and configuration: without an integration key the traffic, user code
  included, travels in clear text on the local network.

### Fixed

- `alarm_triggered` is no longer lost when the zone in alarm is not known:
  it carries `zone: null` (every undefined event value is sent as null).
- A refusal of the user code that comes late (after the command timed out,
  or on the next command) now stops the commands too.
- The answer of a command is awaited up to an absolute deadline counted
  from its write, so the ack always comes before Gladys' 5 s.
- The partition lists of one change are gathered in a sliding window (up
  to 1 s): one `armed` event per arming, no false `armed` on a disarm.
- After an ambiguous result the line stays uncertain until the pending
  answers came or 10 s passed.
- Commands asked together (a scene arming two partitions) all go, one after
  the other; one whose time ran out while waiting is refused with an exact
  message, and a disarm withdraws an arming of the same partition still
  waiting. A late refusal of the code stops the commands at once.
- Malformed frames are logged once per minute in a summary; 50 in a row
  cut the connection. A result of a wrong length is "sent, without
  confirmation". Short reads never drop the link.
- A new configuration applies at once; offline, only the link state is
  published; the ack of a refused code never waits for Gladys' status.

### Changed

- The stop on a refused user code belongs to the integration, not to the
  address of the module, and is lifted by a dedicated "Allow a new try of
  the code" button (no longer by "Test the connection").
- Docs and configuration: user code in clear without an integration key;
  AES keeps the exchanges confidential, without replay protection; arming
  with people inside may raise a false alarm and a monitoring call.

[Unreleased]: https://github.com/LM1LC3N7/gladys-satel-integra/commits/main
