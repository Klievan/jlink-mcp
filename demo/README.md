# Demo

A scripted debugging session driven through the real MCP server.

```bash
npm run compile
node demo/story.js          # run it
FAST=1 node demo/story.js   # same, without the pauses for a viewer
```

## What it does

Five acts, about 45 seconds: find the probe, flash the firmware, open a debug
session in one call, filter the device's own logs, inject an unaligned access,
and diagnose the resulting fault.

Every line is a real MCP tool call against real silicon over the same stdio
transport an LLM would use. **Nothing is staged.** With the board unplugged
this fails rather than printing something plausible — which matters, because
the whole claim being demonstrated is that the tool tells you the truth about
your hardware.

## Recording it

```bash
brew install vhs
vhs demo/story.tape         # -> demo/jlink-mcp-demo.gif
```

The `.tape` is committed so the GIF can be regenerated when output formats
change. A hand-recorded GIF goes stale silently, and a stale demo is worse
than none: it shows output the tool no longer produces.

## Requirements

- An nRF52840-DK (any J-Link probe and Cortex-M target works with edits)
- SEGGER J-Link tools installed
- `test/hil/fixture/rtt-fixture.hex` — committed; rebuild with
  `test/hil/fixture/build-rtt-fixture.sh` if you change the fixture source

## Note on the firmware

The demo flashes `rtt-fixture.hex`, the same fixture the hardware test suite
uses: a spin loop with RTT logging and fault injection on request. **It
overwrites whatever is currently on the board.**
