# J-Link MCP Server

This is a VSCode extension and standalone MCP server for SEGGER J-Link debug probes.

## Building

```bash
npm install
npm run compile
```

## Running standalone MCP server (for Claude Desktop / Claude Code)

```bash
node out/mcp/standalone.js
```

## MCP Configuration

Add to your Claude Desktop config or `.mcp.json`:

```json
{
  "mcpServers": {
    "jlink": {
      "command": "node",
      "args": ["out/mcp/standalone.js"],
      "cwd": "/path/to/mcpserver"
    }
  }
}
```

## Architecture

- `src/jlink/commander.ts` - J-Link Commander (JLinkExe) wrapper
- `src/jlink/gdb-server.ts` - JLinkGDBServer lifecycle management
- `src/rtt/rtt-client.ts` - RTT telnet client for reading device output
- `src/telnet/telnet-proxy.ts` - TCP proxy for Trice/Pigweed detokenizer
- `src/mcp/server.ts` - MCP server with all tools, resources, and prompts
- `src/mcp/standalone.ts` - Standalone entry point (stdio transport)
- `src/extension.ts` - VSCode extension entry point

## Prerequisites

- SEGGER J-Link software installed (JLinkExe, JLinkGDBServer)
- A J-Link debug probe connected to a target device
- Configure device name in VSCode settings: `jlinkMcp.jlink.device`
