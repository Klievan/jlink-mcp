<p align="center">
  <img src="logo.png" alt="jlink-mcp logo" width="200">
</p>

<h1 align="center">jlink-mcp</h1>

<p align="center">
  <strong>Give AI hands to touch silicon.</strong><br>
  An MCP server that lets LLMs debug embedded devices through SEGGER J-Link probes.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/MCP-Server-blue?style=for-the-badge" alt="MCP Server">
  <img src="https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/J--Link-SEGGER-00979D?style=for-the-badge" alt="J-Link">
  <img src="https://img.shields.io/badge/ARM-Cortex--M-0091BD?style=for-the-badge" alt="ARM Cortex-M">
</p>

<p align="center">
  <a href="https://github.com/Klievan/jlink-mcp/stargazers"><img src="https://img.shields.io/github/stars/Klievan/jlink-mcp?style=flat-square" alt="GitHub Stars"></a>
  <a href="https://github.com/Klievan/jlink-mcp/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Klievan/jlink-mcp?style=flat-square" alt="License"></a>
  <a href="https://www.npmjs.com/package/jlink-mcp"><img src="https://img.shields.io/npm/v/jlink-mcp?style=flat-square&color=cb0000" alt="npm"></a>
  <a href="https://www.npmjs.com/package/jlink-mcp"><img src="https://img.shields.io/npm/dt/jlink-mcp?style=flat-square&color=cb0000" alt="npm downloads"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=Klievan.jlink-mcp"><img src="https://img.shields.io/visual-studio-marketplace/v/Klievan.jlink-mcp?style=flat-square&label=VSCode" alt="VSCode Marketplace"></a>
  <a href="https://smithery.ai/server/@Klievan/jlink-mcp"><img src="https://smithery.ai/badge/@Klievan/jlink-mcp" alt="Smithery"></a>
  <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-Compatible-green?style=flat-square" alt="MCP Compatible"></a>
  <a href="https://github.com/Klievan/jlink-mcp/actions/workflows/ci.yml"><img src="https://github.com/Klievan/jlink-mcp/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/Klievan/jlink-mcp/actions/workflows/hil.yml"><img src="https://img.shields.io/badge/tested%20on-real%20nRF52840-brightgreen?style=flat-square" alt="Hardware tested"></a>
</p>

---

## See it work

<p align="center">
  <img src="demo/jlink-mcp-demo.gif" alt="A terminal session: the MCP server finds the probe, flashes firmware, opens a debug session, streams RTT logs, injects a fault, and decodes the resulting HardFault — naming the faulting instruction." width="100%">
</p>

<p align="center">
  <em>Real MCP tool calls against a real nRF52840-DK. Reproduce it yourself: <code>npm run demo</code></em>
</p>

Your firmware just crashed. One tool call:

```
> diagnose_crash

## Crash Diagnosis

### CPU State
Core: PC=0x000000B8 SP=0x2003FFA8 R0=0x0000000A R1=0x000007FF R2=0x00000001 ...
Status: XPSR=0x21000003 CONTROL=0x00000000 PRIMASK=0x00000000 ...
Stack: MSP=0x2003FFA8 PSP=0x00000000

⚠ CPU is in exception handler (IPSR=0x00000003)

### Fault Registers
CFSR=0x01000000 HFSR=0x40000000 DFSR=0x00000000 MMFAR=0xe000edf8 BFAR=0xe000edf8

### Decoded Faults
## UsageFault (UFSR):
  - UNALIGNED: Unaligned memory access
## HardFault (HFSR):
  - FORCED: Forced HardFault (escalated from configurable fault)

### Exception Stack Frame
  R0    = 0x0000000A     R1  = 0x000007FF
  R12   = 0x00000000     LR  = 0x000001F5
  PC    = 0x00000254     xPSR = 0x21000000

→ Faulting instruction at PC=0x00000254

### Recent Errors/Warnings from RTT
  [WRN] sensor_drv: sample out of range, clamping seq=2
```

Fault decoded, exception frame unwound, faulting instruction named, and the
device's own log correlated — from one call, without a human reading a
datasheet to find out what bit 24 of CFSR means.

### And it knows what the silicon is

Point it at your target's CMSIS-SVD file and peripheral registers stop being
hex:

```
> read_peripheral FICR

FICR @ 0x10000000
INFO.PART @ 0x10000100 = 0x00052840  (read-only)
  [31:0]    PART             0x52840 → N52840
INFO.RAM @ 0x1000010C = 0x00000100  (read-only)
  [31:0]    RAM              0x100 → K256
INFO.FLASH @ 0x10000110 = 0x00000400  (read-only)
  [31:0]    FLASH            0x400 → K1024
```

`0x400` means 1024 KB of flash — but only if you know that, and an LLM guessing
at bit layouts is exactly the failure this avoids. The addresses come from the
vendor's own description, and the meanings from its enumerations.

*Both transcripts are verbatim output from an nRF52840-DK in this project's
hardware test suite.*

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

Install the extension (requires VSCode 1.110+, matching `engines.vscode`). It auto-registers the MCP server via the native `vscode.lm` API. Configure the device in settings:

```
jlinkMcp.jlink.device = "nRF52840_XXAA"
```

Copilot Chat and Claude in VSCode will automatically discover all 31 tools.

### From Source

```bash
git clone https://github.com/Klievan/jlink-mcp.git
cd jlink-mcp
npm install
npm run compile
JLINK_DEVICE=nRF52840_XXAA node out/mcp/standalone.js
```

## Tools (42)

### Workflow Tools (start here)

| Tool | Description |
|------|-------------|
| `start_debug_session` | **One-call setup.** Starts GDB server + connects RTT + returns boot log. |
| `snapshot` | Captures full device state: registers, fault status, stack dump, RTT output. |
| `diagnose_crash` | Auto-reads and decodes ARM Cortex-M fault registers (CFSR, HFSR, MMFAR, BFAR) with exception stack frame. |

### Device Setup

| Tool | Description |
|------|-------------|
| `list_devices` | Scan for connected probes and show the configured target |
| `set_device` | Change the target device at runtime — no restart needed |
| `get_config` | Current probe, target device, and GDB server state |

### Device Control

| Tool | Description |
|------|-------------|
| `device_info` | Probe type, target CPU, compact register summary |
| `halt` | Halt CPU |
| `resume` | Resume CPU |
| `reset` | Reset device. `halt` stops it at the reset vector; `strategy` picks a [J-Link reset type](https://kb.segger.com/J-Link_Reset_Strategies), or omit it and let J-Link choose |
| `step` | Single-step one instruction |

### Peripherals (CMSIS-SVD)

Set `jlinkMcp.svdPath` to your target's SVD — the same file Cortex-Debug takes
as `svdFile`. Vendors publish one per part.

| Tool | Description |
|------|-------------|
| `list_peripherals` | Every peripheral and base address on the chip |
| `read_peripheral` | Read a peripheral's registers and decode each one's bit fields by name |
| `decode_register` | Decode one register — read from the device, or interpret a value you already have |

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

### Source-Level Debugging

Attach a real GDB client for symbol-aware work — backtraces, variable
inspection, and stepping by source line rather than by instruction.

| Tool | Description |
|------|-------------|
| `gdb_connect` | Attach a GDB client (auto-starts the server; optional ELF for symbols) |
| `gdb_load` | Load an ELF for debug symbols, optionally flashing it too |
| `gdb_backtrace` | Call stack, optionally with locals in each frame |
| `gdb_command` | Run any GDB command — `print sensor_state`, `info threads`, `break main` |
| `gdb_wait` | Wait for the target to stop (after a continue or a breakpoint) |
| `gdb_disconnect` | Detach the client, clearing breakpoints and debug hardware |

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

This server was built by having an AI use it against real hardware, then fixing every friction point.

### What `read_registers` would give you

Raw `JLinkExe` output for `halt; regs` — **77 lines**, of which about six carry
information. Every token here costs context, and the register values are buried
in the middle:

```
SEGGER J-Link Commander V9.70 (Compiled Aug 19 2026 12:16:13)
DLL version V9.70, compiled Aug 19 2026 12:15:25
Connecting to J-Link ...O.K.
Firmware: J-Link OB-nRF5340-NordicSemi compiled Jun 11 2026 13:12:28
Hardware version: V1.00
J-Link uptime (since boot): 0d 00h 34m 29s
S/N: 1050298247
License(s): RDI, FlashBP, FlashDL, JFlash, GDB
...30 more lines of connect banner...
PC = 00000044, CycleCnt = 00EB67E5
R0 = 20000000, R1 = 9D56C547, R2 = 00000000, R3 = 00000000
...
FPS0 = 00000000, FPS1 = 00000000, FPS2 = 00000000, FPS3 = 00000000
...28 more lines of zeroed FP registers...
```

### What it actually gives you

**Three lines.** Same information, grouped by what you would ask for:

```
Core: PC=0x00000046 SP=0x20010000 R0=0x20000000 R1=0x01D43416 R2=0x00000000 ...
Status: XPSR=0x01000000 CONTROL=0x00000000 PRIMASK=0x00000000 BASEPRI=0x00000000
Stack: MSP=0x20010000 PSP=0x00000000
```

Both captured from the same board. The rest of the design follows the same rule
— return what was asked for, and nothing else:

- **Output parsing** strips the connection banner. Only data comes back.
- **Registers** are compact and grouped (core / status / stack).
- **FP registers** only shown if non-zero (they're usually all zeros).
- **RTT output** has ANSI escape codes stripped and Zephyr log format parsed into structured fields.
- **Composite tools** (`start_debug_session`, `snapshot`, `diagnose_crash`) replace multi-step workflows with single calls.
- **Fault decoding** is automatic — reads CFSR/HFSR/MMFAR/BFAR and explains each bit.
- **`rtt_search`** lets you find errors without reading the entire log.
- **Peripheral registers** decode through the vendor's own CMSIS-SVD, so the
  model reads `RAM = K256` rather than guessing what `0x100` means in that
  field of that register.
- **Failures say what to do.** "Target is running; use halt" beats "could not
  read memory", and a fault-register read that did not happen reports itself
  rather than decoding zeroes into "no faults detected".

## Verified on real hardware

Most of what can go wrong between an LLM and a debug probe fails *quietly*: a
tool returns success with an empty payload, a parser drops half a line, a
session dies and the next command reports something plausible instead. None of
that is visible from reading the code, and a test suite that asserts "the call
did not error" passes on all of it.

So this project runs a hardware tier: **58 tests against a real nRF52840-DK**
on a self-hosted runner, driving the actual MCP server over stdio exactly as a
client would. It covers probe discovery, flash and verify, halt/step/resume
under a live GDB session, memory and peripheral reads, RTT streaming and
filtering, and crash diagnosis against faults injected on demand.

It has caught bugs that had been shipping green, including:

- `diagnose_crash` reporting **"No faults detected" during real crashes** — the
  memory-dump parser was dropping half of every line
- **every GDB-routed tool returning empty output** while the server reported
  itself healthy
- sessions leaving the target **unbootable**, with breakpoint comparators still
  armed that no reset clears
- `reset` reporting success while **doing nothing at all** — the GDB server is a
  synchronous remote and refuses commands while the target runs, so every
  command of the reset sequence was rejected in turn and the failure discarded

Raw probe output captured during those runs is committed as golden transcripts,
so a fast unit tier replays real device bytes in seconds on any machine —
no probe required to catch a format regression.

```bash
npm test          # ~230 tests, seconds, no hardware
npm run test:hil  # hardware tier; needs HIL=1 and a probe
```

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
