# Contributing

Thanks for looking. A few things about this project that are unusual enough to
be worth saying before you start.

## The one rule that matters

**Assert on content, never on `success === true`.**

Every bug this project has shipped reported success while quietly losing data:
`diagnose_crash` announcing "No faults detected" during real crashes, every
GDB-routed tool returning empty output while the server called itself healthy,
memory reads returning 598 bytes when asked for 256. A test suite that checks
"the call did not error" would have passed on all of them.

If your change touches output an LLM will read, assert on what it says.

## Do not derive tool behaviour by reasoning

J-Link parses `mem`'s length argument as bare hex. `rreg` rejects the register
names it prints as valid. GDB emits a prompt before any command is sent. A
write to `0xF0000000` does not fault on nRF52840, but a jump there does.

Each of those cost a hardware round because it was reasoned about rather than
checked. If you need to know how a tool behaves, run it.

## Testing

```bash
npm test          # ~215 tests, seconds, no hardware
npm run test:hil  # hardware tier; needs HIL=1 and a probe attached
```

The two tiers are connected: the hardware tier runs with `JLINK_MCP_LOG_RAW=1`
and captures raw probe output, `test/golden/promote.js` extracts it, and the
fast tier replays those real transcripts. So a format regression is caught in
seconds on any laptop, and the slow hardware run only gates merges.

`test/golden/*.txt` are **inputs**. Do not reformat them — the tabs and escape
bytes are the coverage.

## Hardware tests

Reading a running target is impossible, not slow: the J-Link GDB Server is a
synchronous remote, so GDB will not answer while the core executes. Use
`withTargetHalted()`. The harness throws if you forget, because remembering did
not work three times running.

Two fixtures live in `test/hil/fixture/`:

- `fixture.hex` — hand-assembled, with exact known instruction addresses that
  S1–S3 assert against. Kept precisely for that exactness.
- `rtt-fixture.hex` — compiled C with RTT, a command channel, symbols and fault
  injection. Rebuild with `build-rtt-fixture.sh`; CI never builds it, so a
  toolchain difference cannot change what the tests run against.

## Pull requests

Explain what went wrong and how you know, not just what changed. If hardware
told you something, quote it — the commit log is the only place that evidence
survives.
