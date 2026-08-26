# Tests

Two tiers, with a deliberate flow of data between them.

## Tier 1 — unit (`test/unit/`) — this directory, today

Replays the golden transcripts in `test/golden/` through the parsers. No probe,
no devkit, no runner. Runs in a few seconds on any machine and gates every push.

```bash
npm test
```

Everything the MCP server hands an LLM passes through a parser: register dumps,
memory dumps, GDB/MI records, RTT log lines. Those parsers consume loosely
specified vendor text, which means the realistic failure is not a crash — it is
a parser that quietly returns nothing and a tool that reports success while
emitting less than it should. That failure mode is invisible to any test that
only asserts `success === true`, so the assertions here are about *content*.

Three bugs found by writing this tier, all of which reported success while
losing data:

- `parseMemoryDump` stopped at J-Link's mid-line `8|8` byte separator and
  dropped half of every dump line, starving `readFaultRegisters` of its
  16-byte minimum so `diagnose_crash` reported "no faults detected" during a
  live crash.
- `stripAnsi` ran per TCP chunk rather than per line, so an escape sequence
  split across a socket read leaked raw bytes into the log text and broke
  level/module filtering for that line.
- `parseRegisters` could not read GDB's column format at all, silently
  removing the stack dump from `snapshot` and both the CPU State and
  Exception Stack Frame sections from `diagnose_crash`.

## Tier 2 — hardware-in-the-loop (`test/hil/`) — not built yet

Drives the real `out/mcp/standalone.js` over stdio with an MCP client against
an nRF52840-DK on a self-hosted runner. Planned suites S0–S11 cover discovery,
flash, halt/inspect/resume, memory and peripherals, breakpoints, RTT, crash
diagnosis, recovery, and session lifecycle.

The HIL tier's other job is to **capture** golden transcripts. Anything it
parses gets written back to `test/golden/`, so real device output becomes the
fixture the fast tier replays forever after. See `test/golden/README.md` for
which fixtures are still provisional.

## Writing a test

`test/helpers.ts` provides:

- `golden(name)` — read a transcript verbatim (never trims; whitespace is under test)
- `FakeGdbBridge` — records commands sent to GDB, replies from a prefix-matched table
- `StubBackend` — a `ProbeBackend` with the abstract surface stubbed, for testing
  the shared parsing utilities without spawning processes

Assert on parsed structure and on the text a user actually sees. `assert.ok(result.success)`
is not a test — it is the thing that let all three bugs above ship.
