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

[Unreleased]: https://github.com/LM1LC3N7/gladys-satel-integra/commits/main
