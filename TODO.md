# TODO - Satel Integra (ETHM-1) v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm run audit`, `npx github:GladysAssistant/integration-store .`,
  then update README, `docs/fr.md`, `docs/en.md`, `CHANGELOG.md` and this file.
- No forum topic of its own, no forum post from a module session: the main
  session posts one recap per wave in /t/10385.
- The `gladys-assistant-integration` topic is added at the first real release only.

## Status

- [x] **Milestone 1 - core** (2026-10-19): own TCP client on `node:net`
      ported from satel-integra 1.5.0 (frames, checksum, "Busy" check,
      monitoring, keep-alive, names, one request at a time, AES layer of the
      ETHM-1 Plus); panel / partition / zone / output devices; read-only
      states and push buttons; arming allowed, disarming and outputs opt-in
      (separate options); fresh read before every command, serialized,
      deadlines inside Gladys' 5 s; refused user code stop persisted in
      `/data`; scene triggers `alarm_triggered`, `armed`, `disarmed`; scene
      actions `arm`, `disarm`; "Test the connection"; fr/en. Tested against
      an in-memory module only (AES and checksum checked against
      satel-integra's own test vectors).
- [ ] **Milestone 2 - real panel**: run against a real INTEGRA with an
      ETHM-1 and an ETHM-1 Plus (with and without a key); capture real
      frames (anonymised) as fixtures; fix what differs (see below).
- [ ] **Milestone 3 - more**: zone temperatures (0x7D), clearing an alarm
      (0x85) behind the disarm option, zone bypass and alarm memory lists,
      troubles detail, the event log (0x8C), forced arming (0xA0..) behind
      the arming option, automatic discovery of the zones and outputs
      (0xEE over every number, slow: opt-in).
- [ ] **Milestone 4 - first release**: Docker image check, Release workflow,
      topic, GHCR package public.

## To check on a real panel

- Does the module send every followed list right after 0x7F (the
  simulator of satel-integra says so)? The client reads them all anyway.
- The lists 0x01 (zone tamper) and 0x02 (zone alarm): present and in the
  monitoring on every INTEGRA? (from the Satel description only.)
- 16 or 32 bytes in the zone and output lists, and the 0xFF suffix for
  32-byte reads on an INTEGRA 256 Plus.
- 0xEE names: selectors 0x10 / 0x05 / 0x04 on older firmwares; the answer
  for an unused zone (0xEF 0x08 assumed).
- The answer to a wrong user code (0xEF 0x01 assumed), and whether repeated
  wrong codes lock the keypads or raise an alarm on the installation tested.
- Disarming a disarmed partition still in alarm (sent as 0x84 here): does
  it clear the alarm, or is 0x85 needed?
- A wrong integration key: silence (assumed), garbage or a closed socket?
- What a busy ETHM-1 Plus with a key sends ("Busy!" in clear, or bytes).
- The order of the lists on an arming (armed, mode, exit time): the app
  waits 250 ms before it decides on the transitions.

## Decisions

- **Own client, no dependency**: no maintained INTEGRA client on npm under
  a usable licence; satel-integra (MIT) is ported and credited in
  `THIRD_PARTY_NOTICES.md` (copied into the image with `LICENSE`). Runtime
  dependency: the SDK only; the AES layer uses `node:crypto`.
- **Version 0.1.0, set by hand once**: the template ships 1.0.0; the
  sibling modules start at 0.1.x, so `package.json`, `package-lock.json`, the
  manifest `version` and the `docker_image` tag were set together to 0.1.0 in
  milestone 1, before any release (`test/manifest.test.js` checks all four).
  Every later version comes from Actions -> Release (the first patch release
  gives 0.1.1).
- **ETHM-1 Plus integration key**: supported, since satel-integra supports
  it (its AES module, ported, with the vectors of its tests). Without a key the
  docs and the manifest say plainly that everything, the user code
  included, travels in clear text. The user texts say "AES" / "protected"
  only, so that the test against the word for a ciphered secret keeps
  guarding the secret fields (only `THIRD_PARTY_NOTICES.md`, which names
  the ported Python file, is left out of it).
- **One TCP connection**: the module takes one client. The client never
  opens a second socket while one is open, waits 5 s after a close, 10 s to
  5 min between tries, at least 60 s after "Busy". Two first requests in a
  row without an answer: the status points at the integration key.
- **Configured objects only**: partitions (default `1`), zones (with their
  kind) and outputs are listed in the configuration, as in Home Assistant;
  their names come from the panel (0xEE), read once per address and lists.
  Scanning all 256 zones and outputs would take a long time per connection
  on a single-client module: milestone 3, opt-in.
- **States**: the module's monitoring (0x7F) pushes each list on a change;
  every followed list is also read once at the start. A list never received
  leaves its states unpublished (unknown, not "off"); a 16-byte list leaves
  the numbers over 128 unknown.
- **Partition state** (satel-integra's Home Assistant order): alarm, armed
  in mode 3 / 2 / 1, armed (0x0A or 0x09: away), exit time (arming), else
  disarmed. Text feature in the configured language, no history; the scene
  triggers carry the frozen codes (`armed_away`, `armed_stay`).
- **Transitions**: the module reports one list per frame; the app waits 250
  ms after a report before it computes the transitions and publishes, so an
  arming fires one `armed` event. No event for the first status after a
  start; `disarmed` is not sent for an exit time cancelled.
- **Commands**: buttons (`button`/`push`, value 1 only, strictly), never a
  switch or a binary. Each command reads its lists from the panel first
  (arm/disarm: 0x0A, 0x09, 0x0F, 0x10, 0x13, 0x14, plus the mode lists when
  armed; output: 0x17) and decides on that read only: already in the state:
  nothing sent; armed in another mode or arming: refused; in alarm: arming
  refused. Reads by 2.8 s, sent by 3.5 s or withdrawn ("nothing was sent"),
  answer awaited until 4.5 s; no answer, a lost session, an ambiguous
  result: "sent, without confirmation" + read back in 2 s. A 0xEF refusal:
  "refused by the panel", with its meaning.
- **Options**: `allow_arm` (default on), `allow_disarm` (off),
  `allow_outputs` (off), checked when asked, again inside the queue after
  the fresh read, and once more by the client right before the socket write
  (with the code unchanged).
- **User code**: optional (states need none), 4 to 16 digits, sent only in
  command frames, logged by label only. A 0xEF 0x01 / 0x03 answer (code not
  found, user does not exist) stops every command: saved in
  `/data/satel-state.json` with the address only (never the code nor a hash
  of it: a 4-digit code is brute-forced from any hash); lifted by a new code
  in the configuration or by "Test the connection" (which never sends the
  code itself). An ambiguous result never sets the stop. 0x02 (no right),
  0x11 / 0x12 (cannot arm) are plain refusals.
- **Ambiguous results**: there is no request id in this protocol. After a
  command (0x7F..0x89) timed out, a 0xEF answer within 10 s may be its late
  answer: the next command gets "sent, without confirmation". A stray 0xEF
  with nothing in flight puts the line in step again.
- **Ids**: `panel:satel`, `partition:<n>`, `zone:<n>`, `output:<n>`: one
  panel per integration, numbered by the panel; a new IP keeps them. The
  zone state feature is keyed by its kind; a device published again keeps
  the features of the created device it no longer has.
- **Rate limits**: the publisher of gladys-envisalink / gladys-risco (same
  author): only changed values, a heartbeat every 30 min plus a per-feature
  offset, 240 states/min of which 60 kept for the panel and partitions
  (zones and outputs share the rest), 120 events/min, `alarm_triggered`
  never dropped and tried 3 times.
- **Units and categories**: only core ones (`input`, `text`, `siren`,
  `tamper`, `button`, `opening-sensor`, `motion-sensor`, `smoke-sensor`,
  `leak-sensor`), no unit at all.
- **Not checked**: Docker is not installed on this PC, so no image build and
  no end-to-end test in a container; the store validator
  (`npx github:GladysAssistant/integration-store .`) cannot be run from the
  agent session; never run against a real panel.
