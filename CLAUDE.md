# J-Link MCP Server

VSCode extension and standalone MCP server for SEGGER J-Link debug probes.
Enables LLM-driven embedded debugging with 31 tools, RTT log streaming, and telnet proxy.

## Building

```bash
npm install
npm run compile
```

## VSCode Extension (native MCP integration)

Install the extension in VSCode 1.99+. It registers an MCP server definition provider
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
- `src/mcp/server.ts` - MCP server: 31 tools, 4 resources, 4 prompts
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
- VSCode 1.99+ for native MCP integration
