# Changelog

## Unreleased

Another hardware round, and another set of operations that reported success
while doing nothing. Each one here was hidden behind the one before it: fixing
reset made reset actually happen, which exposed the teardown; fixing the
teardown exposed a GDB server that had already exited; fixing that left one
clean question about RTT, which a diagnostic answered in a single run.

### Fixed

- **`reset` did nothing at all, and said it worked.** The J-Link GDB server is
  a synchronous remote and stops reading stdin while the target runs, so every
  command of the reset sequence was refused in turn and the failure discarded.
  A reset is a recovery action — the moment you reach for one is exactly when
  the target is running — so it now halts out of band first. `reset(halt)`
  also verifies its own postcondition, following VTOR to the reset vector
  rather than assuming the vector table sits at zero.
- **Session teardown never disarmed anything.** `disarmDebugState()` writes FPB
  comparators, DWT functions, `FP_CTRL` and `DEMCR` through the debug channel,
  and teardown happens while the target is running by definition — so the
  whole routine was refused, write by write, and reported "debug hardware
  disarmed" regardless. The guarantee that a session leaves the target
  bootable had never actually held over a live session. It halts first now.
- **A GDB server was reported running when it had already exited.** Startup
  returned on the spawn without waiting to see whether it got the probe. A
  J-Link serves one client at a time, so when another process still holds it
  the server prints "Connecting to J-Link failed" and exits about 200 ms
  later. One test suite tore down and the next started 2.2 s later, lost the
  probe, and ran its entire length with no GDB server and no RTT. Startup now
  waits for the server's own readiness banner and retries a busy probe: a USB
  device is not free the instant the process holding it is signalled.
- **RTT went silent after a target reset.** Sampling SEGGER's control block
  from both ends showed the target's write pointer moving 582 to 802 while the
  host's read pointer stayed at 0 — the firmware was still logging and the
  probe had stopped collecting. Reconnecting the telnet client cannot help;
  that is downstream of the collector. `reset` now restarts collection via
  `SetRTTAddr`, and where it cannot it says so rather than leaving a dead
  stream looking like a quiet target.

### Changed

- **Reset strategy is selectable**, via `strategy` on the `reset` tool
  (`RSetType` / `monitor reset <type>`). Omitting it lets J-Link pick the right
  sequence for the device, which is what SEGGER recommends. The hand-rolled
  `DEMCR.VC_CORERESET` vector catch is gone: J-Link's default Cortex-M strategy
  already does exactly that, and doing it by hand opted out of the per-device
  handling. Backends with no numeric reset types refuse an explicit strategy
  rather than quietly resetting some other way.

- **An assignment that was silently discarded** took RTT out for the rest of a
  session. `rttConnected` decides whether a flash restores RTT afterwards, and
  its setter refused the assignment unless a state enum read `GDB_RUNNING` —
  but that enum covers both "the target is attached" and "the server is up",
  and any probe-CLI call runs a preflight that sets `TARGET_ATTACHED`. RTT
  connects just after a resume, which is such a call, so the refusal landed on
  the following line every time. The guard now asks whether a GDB server is
  running, which is the actual rule: the server hosts the RTT port.

### Added

- **`JLINK_RTT_ADDR`** / `jlinkMcp.rtt.controlBlockAddress` — the address of
  your firmware's `_SEGGER_RTT` symbol. J-Link locates the control block by
  scanning RAM and never reports the address back, so supplying it is what
  allows RTT to survive a reset.
- **Reset strategy selection** on the `reset` tool, and a postcondition check
  on `reset(halt)` that follows VTOR to the reset vector.

## 0.4.0

The first release with a hardware test suite behind it. Every fix below was
found by running the server against a real nRF52840-DK, and most of them were
failures that reported success — the kind you cannot find by reading the code.

### Fixed — tools that lied

- **`diagnose_crash` reported "No faults detected" during real crashes.** Twice,
  for two different reasons: the memory-dump parser dropped half of every line
  at J-Link's mid-line byte-group separator, and later, a target spinning in
  its own fault handler counts as "running" to a synchronous remote, so the
  register reads were refused and refused reads defaulted to zero. It now halts
  before reading, and a failed read says so instead of reporting health.
- **Every GDB-routed tool returned empty output** while `gdb_server_status`
  reported the server healthy. Response completion matched a `(gdb)` prompt
  that GDB emits at startup, before any command is sent, so every reply was off
  by one. Commands now carry MI tokens.
- **`read_memory` returned the wrong number of bytes.** J-Link parses `mem`'s
  length as bare hex, so `read_memory(addr, 256)` read 598 bytes.
- **`read_register` was rejected for its own documented examples.** `rreg PC`
  answers "Illegal register name" — and so does `rreg R15`. It now reads the
  full set and picks the register out.
- **RTT dropped and garbled lines.** ANSI escapes were stripped per TCP chunk,
  so a sequence split across a read leaked raw bytes into the log and broke
  level/module filtering for that line.

### Fixed — sessions that broke silently

- **`flash` and `erase` killed a live GDB session.** They must spawn JLinkExe,
  and a probe serves one client, so the server was evicted and the client left
  on a dead socket. They now take the session down deliberately and restore it,
  reporting each step.
- **Disconnecting left the target unbootable.** Sessions ended with breakpoint
  comparators still armed; a probe-issued reset does not clear them, so the next
  boot took a debug event with nothing attached and HardFaulted. Teardown now
  clears breakpoints and disarms the FPB and DWT comparators.
- **`start_debug_session` halted your firmware and then reported no output.**
  The GDB server halts the core when it attaches. It now resumes before
  connecting RTT, and says so.
- **A running target could not be halted.** With a synchronous remote GDB stops
  reading stdin while the target executes, so no command could reach it. `halt`
  now interrupts out-of-band.
- **Concurrent tool calls could clobber each other's replies.** GDB commands are
  now queued.
- Commands issued while the target runs are refused promptly with an actionable
  message, rather than waiting out a 10-second timeout and returning nothing.

### Fixed — VSCode extension

- **Nine of sixteen settings did nothing.** They appeared in the settings UI and
  were never passed to the server: the whole telnet-proxy group, SWO port, and
  more. Every declared setting is now wired, with a test that fails if the two
  ever diverge again.
- **OpenOCD and Black Magic Probe were unreachable from the extension.** There
  was no setting to select the backend, despite both being documented. Added
  `jlinkMcp.probeType` plus full settings for both.

### Added

- `jlinkMcp.gdbPath` — choose the GDB used for source-level debugging
  (`gdb-multiarch` works if you have no ARM-specific build)
- `jlinkMcp.openocd.*` and `jlinkMcp.blackmagic.*` settings
- A hardware-in-the-loop test suite, and a fast tier that replays real captured
  probe output so format regressions are caught without a probe
- `demo/` — a scripted debugging session driven through the real server

### Removed

- `jlinkMcp.trice.*` and `jlinkMcp.pigweed.*`. These configured a detokenizer
  that was never implemented — the telnet proxy relays bytes and nothing decodes
  them. Settings for an absent feature are worse than no settings: you supply a
  token database and wait for decoded output that is never coming. The proxy
  itself is unchanged and still useful; point your own decoder at it.

### Changed

- `telnet_proxy_start` now describes what it does — relay the RTT stream to
  another port — rather than implying it decodes anything.
- Requires VSCode 1.110+ (unchanged in `engines`; the docs previously said 1.99).
