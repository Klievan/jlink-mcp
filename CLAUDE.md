# J-Link MCP Server

VSCode extension and standalone MCP server for SEGGER J-Link debug probes.
Enables LLM-driven embedded debugging with 47 tools, RTT log streaming, and telnet proxy.

## Building

```bash
npm install
npm run compile
```

## Testing

```bash
npm test          # unit tier: ~187 tests, seconds, no hardware
npm run test:hil  # hardware tier: needs HIL=1 and a real probe; skips otherwise
```

Two tiers, with a deliberate flow between them. The hardware tier captures raw
probe output (`JLINK_MCP_LOG_RAW=1`); `test/golden/promote.js` extracts it into
`test/golden/`; the unit tier replays those real transcripts. So a format
regression is caught in seconds on any machine, and the slow hardware run only
gates merges.

**Assert on parsed content, never on `success === true`.** Every bug this
project has shipped reported success while silently losing data —
`diagnose_crash` saying "no faults detected" during real crashes, every
GDB-routed tool returning empty output while the server reported itself
healthy. A suite that checks the call did not error would have passed on all
of them.

**Do not derive tool behaviour by reasoning.** J-Link parses `mem`'s length as
bare hex, `rreg` rejects the register names it prints as valid, GDB emits a
prompt before any command is sent. Each of those cost a hardware round because
it was reasoned about rather than checked. `reference_jlink_gdb_quirks` in
memory lists the ones already paid for.

**Reading a running target is impossible, not slow.** The J-Link GDB Server is
a synchronous remote. Use `withTargetHalted()` in HIL tests — the harness
throws if you forget, because remembering did not work three times running.

Hardware runs on a self-hosted runner with an nRF52840-DK. Two fixtures:
`fixture.hex` is hand-assembled with exact known instruction addresses (S1-S3
assert against them); `rtt-fixture.hex` is compiled C with RTT, a command
channel, symbols and fault injection (S6-S7). Rebuild the latter with
`test/hil/fixture/build-rtt-fixture.sh` — CI never builds it, so a toolchain
difference cannot change what the tests run against.

See `test/README.md` and `test/golden/README.md`.

## VSCode Extension (native MCP integration)

Install the extension in VSCode 1.110+. It registers an MCP server definition provider
via `vscode.lm.registerMcpServerDefinitionProvider()`, so Copilot Chat, Claude, and any
MCP-aware client auto-discover the J-Link tools. No manual `.mcp.json` needed.

Configuration is read from VSCode settings (`jlinkMcp.*`) and passed as env vars to the
standalone server process that VSCode spawns.

## Standalone MCP server (for Claude Desktop / Claude Code)

```bash
JLINK_DEVICE=nRF5340_xxAA_APP node out/mcp/standalone.js
```

Env vars: `JLINK_DEVICE`, `JLINK_INSTALL_DIR`, `JLINK_INTERFACE`, `JLINK_SPEED`,
`JLINK_SERIAL`, `JLINK_GDB_PORT`, `JLINK_RTT_PORT`.

## MCP Configuration (manual, for Claude Desktop / Claude Code)

```json
{
  "mcpServers": {
    "jlink": {
      "command": "node",
      "args": ["out/mcp/standalone.js"],
      "cwd": "/path/to/mcpserver",
      "env": { "JLINK_DEVICE": "nRF5340_xxAA_APP" }
    }
  }
}
```

## Architecture

- `src/jlink/commander.ts` - J-Link Commander (JLinkExe) wrapper with output parsing
- `src/jlink/gdb-server.ts` - JLinkGDBServer lifecycle management
- `src/rtt/rtt-client.ts` - RTT telnet client with ANSI stripping and Zephyr log parsing
- `src/telnet/telnet-proxy.ts` - TCP proxy for Trice/Pigweed detokenizer
- `src/mcp/server.ts` - MCP server: 47 tools, 4 resources, 4 prompts
- `src/mcp/standalone.ts` - Standalone entry point (stdio transport, env var config)
- `src/extension.ts` - VSCode extension: MCP provider, commands, status bar, output channels

## Key tools for LLMs

- `start_debug_session` - One-call GDB + RTT setup, returns boot log
- `snapshot` - Full device state (regs + faults + stack + RTT) in one call
- `diagnose_crash` - Auto-decode ARM Cortex-M fault registers
- `rtt_search` - Filter RTT logs by level/module/regex

## Prerequisites

- SEGGER J-Link software installed (JLinkExe, JLinkGDBServer)
- A J-Link debug probe connected to a target device
- Configure device name in VSCode settings: `jlinkMcp.jlink.device`
- VSCode 1.110+ for native MCP integration (enforced by `engines.vscode`; the
  extension is typed against that API level, so lowering it needs verifying
  when `vscode.lm.registerMcpServerDefinitionProvider` actually landed)
