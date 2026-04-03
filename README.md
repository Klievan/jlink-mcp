<p align="center">
  <img src="https://img.shields.io/badge/MCP-Server-blue?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0id2hpdGUiPjxwYXRoIGQ9Ik0xMiAyQzYuNDggMiAyIDYuNDggMiAxMnM0LjQ4IDEwIDEwIDEwIDEwLTQuNDggMTAtMTBTMTcuNTIgMiAxMiAyem0wIDE4Yy00LjQyIDAtOC0zLjU4LTgtOHMzLjU4LTggOC04IDggMy41OCA4IDgtMy41OCA4LTggOHoiLz48L3N2Zz4=" alt="MCP Server">
  <img src="https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/J--Link-SEGGER-00979D?style=for-the-badge" alt="J-Link">
  <img src="https://img.shields.io/badge/ARM-Cortex--M-0091BD?style=for-the-badge" alt="ARM Cortex-M">
</p>

<h1 align="center">jlink-mcp</h1>

<p align="center">
  <strong>Give AI hands to touch silicon.</strong><br>
  An MCP server that lets LLMs debug embedded devices through SEGGER J-Link probes.
</p>

<p align="center">
  <a href="https://github.com/thesprkfactory/jlink-mcp/stargazers"><img src="https://img.shields.io/github/stars/thesprkfactory/jlink-mcp?style=flat-square" alt="GitHub Stars"></a>
  <a href="https://github.com/thesprkfactory/jlink-mcp/blob/main/LICENSE"><img src="https://img.shields.io/github/license/thesprkfactory/jlink-mcp?style=flat-square" alt="License"></a>
  <a href="https://www.npmjs.com/package/jlink-mcp"><img src="https://img.shields.io/npm/v/jlink-mcp?style=flat-square&color=cb0000" alt="npm"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=thesprkfactory.jlink-mcp"><img src="https://img.shields.io/visual-studio-marketplace/v/thesprkfactory.jlink-mcp?style=flat-square&label=VSCode" alt="VSCode Marketplace"></a>
  <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-Compatible-green?style=flat-square" alt="MCP Compatible"></a>
</p>

---

## What is this?

**jlink-mcp** connects AI assistants (Claude, Copilot, etc.) to your embedded hardware via [SEGGER J-Link](https://www.segger.com/products/debug-probes/j-link/) debug probes using the [Model Context Protocol](https://modelcontextprotocol.io).

Instead of manually typing J-Link commands, your AI assistant can:

- **Read registers and memory** to understand device state
- **Flash firmware** and reset devices
- **Stream RTT logs** and search them by level/module/regex
- **Diagnose crashes** by auto-decoding ARM Cortex-M fault registers
- **Control execution** — halt, step, resume, breakpoints
- **Start GDB servers** for full debugging sessions

> Also supports **OpenOCD** (ST-Link, CMSIS-DAP, FTDI) and **Black Magic Probe** backends.

## Quick Start

### Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "jlink": {
      "command": "node",
      "args": ["/path/to/jlink-mcp/out/mcp/standalone.js"],
      "env": {
        "JLINK_DEVICE": "nRF52840_XXAA"
      }
    }
  }
}
```

### Claude Code

Add `.mcp.json` to your project root:

```json
{
  "mcpServers": {
    "jlink": {
      "command": "node",
      "args": ["out/mcp/standalone.js"],
      "cwd": "/path/to/jlink-mcp",
      "env": {
        "JLINK_DEVICE": "nRF52840_XXAA"
      }
    }
  }
}
```

### VSCode Extension

Install the extension (requires VSCode 1.99+). It auto-registers the MCP server via the native `vscode.lm` API. Configure the device in settings:

```
jlinkMcp.jlink.device = "nRF52840_XXAA"
```

Copilot Chat and Claude in VSCode will automatically discover all 31 tools.

### From Source

```bash
git clone https://github.com/thesprkfactory/jlink-mcp.git
cd jlink-mcp
npm install
npm run compile
JLINK_DEVICE=nRF52840_XXAA node out/mcp/standalone.js
```

## Tools (31)

### Workflow Tools (start here)

| Tool | Description |
|------|-------------|
| `start_debug_session` | **One-call setup.** Starts GDB server + connects RTT + returns boot log. |
| `snapshot` | Captures full device state: registers, fault status, stack dump, RTT output. |
| `diagnose_crash` | Auto-reads and decodes ARM Cortex-M fault registers (CFSR, HFSR, MMFAR, BFAR) with exception stack frame. |

### Device Control

| Tool | Description |
|------|-------------|
| `device_info` | Probe type, target CPU, compact register summary |
| `halt` | Halt CPU |
| `resume` | Resume CPU |
| `reset` | Reset device (optionally halt after reset) |
| `step` | Single-step one instruction |

### Memory & Registers

| Tool | Description |
|------|-------------|
| `read_memory` | Read memory at address (clean hex dump output) |
| `write_memory` | Write 32-bit value to address |
| `read_registers` | All CPU registers in compact format |
| `read_register` | Read specific register (PC, SP, R0-R12, etc.) |

### Flash

| Tool | Description |
|------|-------------|
| `flash` | Flash .hex/.bin/.elf firmware to device |
| `erase` | Erase entire flash |

### Breakpoints

| Tool | Description |
|------|-------------|
| `set_breakpoint` | Set hardware breakpoint at address |
| `clear_breakpoints` | Clear all breakpoints |

### GDB Server

| Tool | Description |
|------|-------------|
| `gdb_server_start` | Start probe's GDB server |
| `gdb_server_stop` | Stop GDB server + disconnect RTT |
| `gdb_server_status` | GDB server, RTT, and proxy status |

### RTT (Real-Time Transfer)

| Tool | Description |
|------|-------------|
| `rtt_connect` | Connect to RTT telnet port |
| `rtt_disconnect` | Disconnect from RTT |
| `rtt_read` | Read recent log lines (ANSI stripped, Zephyr format parsed) |
| `rtt_search` | **Filter logs** by level (`err`/`wrn`/`inf`/`dbg`), module, or regex |
| `rtt_send` | Send data to device via RTT down-channel |
| `rtt_clear` | Clear RTT buffer |

### Telnet Proxy (Trice / Pigweed)

| Tool | Description |
|------|-------------|
| `telnet_proxy_start` | Start TCP proxy that tees RTT for external detokenizers |
| `telnet_proxy_stop` | Stop proxy |
| `telnet_proxy_status` | Proxy connection status |
| `telnet_proxy_read` | Read raw proxy buffer |

### Advanced

| Tool | Description |
|------|-------------|
| `probe_command` | Execute raw probe commands |
| `get_config` | Current probe and server configuration |

## Multi-Probe Support

jlink-mcp supports multiple debug probe backends through a common `ProbeBackend` abstraction:

| Backend | Probe Hardware | Status | RTT Support |
|---------|---------------|--------|-------------|
| **J-Link** | SEGGER J-Link, J-Link OB, J-Link EDU | Production | Yes |
| **OpenOCD** | ST-Link, CMSIS-DAP, FTDI, J-Link (via OpenOCD) | Beta | No |
| **Black Magic Probe** | BMP (built-in GDB server on serial) | Beta | No |
| **probe-rs** | All probe-rs supported probes | Planned | Planned |

### Selecting a Backend

```bash
# J-Link (default)
PROBE_TYPE=jlink JLINK_DEVICE=nRF52840_XXAA node out/mcp/standalone.js

# OpenOCD with ST-Link
PROBE_TYPE=openocd \
  OPENOCD_INTERFACE=interface/stlink.cfg \
  OPENOCD_TARGET=target/stm32f4x.cfg \
  node out/mcp/standalone.js

# Black Magic Probe
PROBE_TYPE=blackmagic \
  BMP_SERIAL_PORT=/dev/ttyACM0 \
  node out/mcp/standalone.js
```

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    MCP Client                        │
│          (Claude, Copilot, any MCP client)           │
└──────────────────────┬──────────────────────────────┘
                       │ JSON-RPC over stdio
┌──────────────────────▼──────────────────────────────┐
│                  jlink-mcp                           │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ 31 Tools │  │4 Resources│  │    4 Prompts      │  │
│  └────┬─────┘  └────┬─────┘  └───────┬───────────┘  │
│       │              │                │              │
│  ┌────▼──────────────▼────────────────▼───────────┐  │
│  │              ProbeBackend                       │  │
│  │  ┌─────────┐ ┌─────────┐ ┌──────────────────┐  │  │
│  │  │ J-Link  │ │ OpenOCD │ │ Black Magic Probe│  │  │
│  │  └────┬────┘ └────┬────┘ └────────┬─────────┘  │  │
│  └───────┼───────────┼───────────────┼─────────────┘  │
│          │           │               │              │
│  ┌───────▼───┐ ┌─────▼────┐ ┌───────▼──────────┐  │
│  │ RTTClient │ │TelnetProxy│ │  ProcessManager  │  │
│  └───────────┘ └──────────┘ └──────────────────┘  │
└─────────────────────────────────────────────────────┘
                       │
          ┌────────────▼────────────┐
          │    Debug Probe (USB)    │
          │  → Target MCU (SWD/JTAG)│
          └─────────────────────────┘
```

### Source Layout

```
src/
├── probe/
│   ├── backend.ts      # ProbeBackend abstract class + shared utilities
│   ├── jlink.ts        # SEGGER J-Link implementation
│   ├── openocd.ts      # OpenOCD implementation
│   ├── blackmagic.ts   # Black Magic Probe implementation
│   └── factory.ts      # Probe creation from config
├── mcp/
│   ├── server.ts       # MCP server (31 tools, 4 resources, 4 prompts)
│   └── standalone.ts   # Standalone entry (stdio transport)
├── rtt/
│   └── rtt-client.ts   # RTT client with ANSI stripping + Zephyr log parsing
├── telnet/
│   └── telnet-proxy.ts # TCP proxy for Trice/Pigweed detokenizer
├── utils/
│   ├── config.ts       # VSCode settings / env var config
│   ├── logger.ts       # Logging
│   └── process-manager.ts # Child process lifecycle
└── extension.ts        # VSCode extension + MCP provider registration
```

## Design Decisions (LLM-Optimized)

This server was built by having an AI use it against real hardware, then fixing every friction point:

- **Output parsing** strips 40+ lines of J-Link connection banners. Only data comes back.
- **Registers** are compact: `Core: PC=0xBF54 SP=0x20062880 ...` instead of 65 raw lines.
- **FP registers** only shown if non-zero (they're usually all zeros).
- **RTT output** has ANSI escape codes stripped and Zephyr log format parsed into structured fields.
- **Composite tools** (`start_debug_session`, `snapshot`, `diagnose_crash`) replace multi-step workflows with single calls.
- **Fault decoding** is automatic — reads CFSR/HFSR/MMFAR/BFAR and explains each bit.
- **`rtt_search`** lets you find errors without reading the entire log.

## Environment Variables

### J-Link

| Variable | Default | Description |
|----------|---------|-------------|
| `PROBE_TYPE` | `jlink` | Probe backend: `jlink`, `openocd`, `blackmagic` |
| `JLINK_DEVICE` | `Unspecified` | Target device (e.g., `nRF52840_XXAA`, `STM32F407VG`) |
| `JLINK_INSTALL_DIR` | Auto-detect | Path to SEGGER J-Link installation |
| `JLINK_INTERFACE` | `SWD` | Debug interface: `SWD` or `JTAG` |
| `JLINK_SPEED` | `4000` | Connection speed in kHz |
| `JLINK_SERIAL` | | J-Link serial number (multi-probe) |
| `JLINK_GDB_PORT` | `2331` | GDB server port |
| `JLINK_RTT_PORT` | `19021` | RTT telnet port |

### OpenOCD

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENOCD_BINARY` | `openocd` | Path to openocd binary |
| `OPENOCD_INTERFACE` | `interface/stlink.cfg` | Interface config file |
| `OPENOCD_TARGET` | `target/stm32f4x.cfg` | Target config file |
| `OPENOCD_GDB_PORT` | `3333` | GDB server port |
| `OPENOCD_TELNET_PORT` | `4444` | Telnet command port |

### Black Magic Probe

| Variable | Default | Description |
|----------|---------|-------------|
| `BMP_GDB_PATH` | `arm-none-eabi-gdb` | Path to GDB binary |
| `BMP_SERIAL_PORT` | `/dev/ttyACM0` | BMP serial port |
| `BMP_TARGET_INDEX` | `1` | Target index after scan |

## Prerequisites

- **[SEGGER J-Link Software](https://www.segger.com/downloads/jlink/)** installed (JLinkExe, JLinkGDBServer)
- A J-Link debug probe connected to an ARM Cortex-M target
- Node.js 18+

For other backends: OpenOCD or arm-none-eabi-gdb as appropriate.

## Contributing

Adding a new probe backend:

1. Create `src/probe/yourprobe.ts` implementing `ProbeBackend`
2. Add a case to `src/probe/factory.ts`
3. That's it — all 31 MCP tools work automatically

## License

MIT - see [LICENSE](LICENSE)

---

<p align="center">
  Built by <a href="https://github.com/thesprkfactory">The Sprk Factory</a>
</p>
