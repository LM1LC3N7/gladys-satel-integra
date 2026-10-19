# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported to JavaScript from the project below. The ported parts
were rewritten, not copied; the changes are described below.

## satel-integra

<https://github.com/c-soft/satel_integra> (package `satel-integra`, version
1.5.0, tag `1.5.0`), by Krzysztof Machelski and its contributors, the library
of the Home Assistant Satel Integra integration. MIT License (`LICENSE` of the
repository). Its notice:

```
MIT License

Copyright (c) 2017, Krzysztof Machelski

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Ported from `satel_integra/`:

- `utils.py`, `const.py`, `messages.py`, in `src/satel/frame.js`: the frame
  layout (FE FE, command, data, checksum, FE 0D), the FE -> FE F0 escape, the
  checksum of the Satel description, the little-endian bit masks of the
  partitions, zones and outputs, the device numbers (256 sent as 0), the
  user code field (digits padded with F to 8 bytes), the names of 0xEE.
- `encryption.py`, `transport.py`, in `src/satel/crypto.js`: the AES layer
  of the ETHM-1 Plus (key derived from the integration key, the block
  chaining, the 6-byte header with the rolling counter, id_s and id_r, the
  length byte on the wire, the id_s check of the answers).
- `commands.py`, `models/*.py`, `satel_integra.py`, in
  `src/satel/protocol.js`: the read and write commands, the result codes of
  0xEF, the INTEGRA models of 0x7E, the status flags of 0x1A, the 0xEE
  selectors, the monitoring mask of 0x7F, the order in which the partition
  lists give the alarm state.
- `connection.py`, `transport.py`, `queue.py`, `satel_integra.py`, in
  `src/satel/client.js`: the "Busy" check after connecting, the first
  request that proves the link, the monitoring, one request at a time with
  the answer expected (the same command, or 0xEF), the 5 s answer timeout,
  the keep-alive (0x1A after 15 s without a request), the arming (0x80 to
  0x83), disarming (0x84) and output (0x88 / 0x89, 32-byte list) commands.

The in-memory module of the tests (`test/helpers/fakeSatel.js`) follows the
behaviour described by satel-integra's ETHM simulator
(`tools/ethm_simulator/`, same repository and licence, after 1.5.0).

Changed: the frames cut in one linear pass with a bounded length; the AES
PDUs read by a bounded state machine; the zone tamper (0x01) and zone alarm
(0x02) lists followed too (from the Satel description, not in
satel-integra); zone and output lists of 16 or 32 bytes both taken; every
followed list and the names of the configured objects read once after the
monitoring starts; reconnection with growing waits (10 s to 5 min, at least
60 s after "Busy"), never two connections at once and at least 5 s between
two; a watchdog; a command never written after its deadline and its option
read again right before the write; after a command timed out, a result is
treated as ambiguous for 10 s; a user code refused by the panel is never
sent again by itself. Zone temperatures, partition clearing (0x85) and the
event log are not ported.
