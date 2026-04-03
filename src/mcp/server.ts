import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as commander from "../jlink/commander";
import { GDBServerManager } from "../jlink/gdb-server";
import { RTTClient, ParsedLogLine } from "../rtt/rtt-client";
import { TelnetProxy } from "../telnet/telnet-proxy";
import { ProcessManager } from "../utils/process-manager";
import { getConfig } from "../utils/config";
import { log } from "../utils/logger";

export class JLinkMcpServer {
  private server: McpServer;
  private processManager: ProcessManager;
  private gdbServer: GDBServerManager;
  private rttClient: RTTClient;
  private telnetProxy: TelnetProxy;

  constructor() {
    this.processManager = new ProcessManager();
    this.gdbServer = new GDBServerManager(this.processManager);

    const config = getConfig();
    this.rttClient = new RTTClient("localhost", config.jlink.rttTelnetPort);
    this.telnetProxy = new TelnetProxy(
      config.telnetProxy.listenPort,
      config.telnetProxy.sourceHost,
      config.telnetProxy.sourcePort
    );

    this.server = new McpServer({
      name: "jlink-mcp-server",
      version: "1.0.0",
    });

    this.registerTools();
    this.registerResources();
    this.registerPrompts();
  }

  private registerTools(): void {

    // ═══════════════════════════════════════════════════════════════
    // COMPOSITE / WORKFLOW TOOLS (most useful for LLMs)
    // ═══════════════════════════════════════════════════════════════

    this.server.tool(
      "start_debug_session",
      "One-call setup: starts GDB server, connects RTT, waits for initial output, and returns device boot log. This is the recommended first tool to call.",
      {},
      async () => {
        const steps: string[] = [];

        // Start GDB server if not running
        if (!this.gdbServer.isRunning()) {
          const gdbResult = this.gdbServer.start();
          steps.push(gdbResult.success ? `GDB Server: started (port ${getConfig().jlink.gdbPort})` : `GDB Server: ${gdbResult.message}`);
          if (!gdbResult.success) {
            return { content: [{ type: "text", text: steps.join("\n") }] };
          }
          // Give GDB server time to initialize
          await sleep(2000);
        } else {
          steps.push("GDB Server: already running");
        }

        // Connect RTT if not connected
        if (!this.rttClient.isConnected()) {
          try {
            await this.rttClient.connect();
            steps.push(`RTT: connected (port ${getConfig().jlink.rttTelnetPort})`);
            // Wait for initial output
            await sleep(1500);
          } catch (err) {
            steps.push(`RTT: failed to connect - ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          steps.push("RTT: already connected");
        }

        // Read initial RTT output
        const lines = this.rttClient.getLines(100);
        if (lines.length > 0) {
          steps.push(`\n--- Device Output (${lines.length} lines) ---`);
          steps.push(lines.join("\n"));
        } else {
          steps.push("\nNo RTT output yet. Device may not have RTT enabled, or may not have rebooted.");
        }

        return { content: [{ type: "text", text: steps.join("\n") }] };
      }
    );

    this.server.tool(
      "snapshot",
      "Capture a complete device state snapshot in one call: CPU registers (compact), fault status, recent RTT output, and stack dump. Best tool for diagnosing unknown issues.",
      {
        rttLines: z.number().min(0).max(200).optional().describe("Number of recent RTT lines to include (default 30)"),
      },
      async ({ rttLines }) => {
        const sections: string[] = [];

        // 1. Registers (compact format)
        const regResult = await commander.readAllRegisters();
        const regs = commander.parseRegisters(regResult.rawOutput);
        if (regs) {
          sections.push("## Registers");
          sections.push(commander.formatRegistersCompact(regs));
        } else {
          sections.push("## Registers\n" + (regResult.output || "Failed to read registers"));
        }

        // 2. Fault registers
        const faultData = await commander.readFaultRegisters();
        sections.push("\n## Fault Status");
        sections.push(faultData.decoded);

        // 3. Stack dump (32 bytes from SP)
        if (regs?.["SP"]) {
          const sp = parseInt(regs["SP"], 16);
          if (!isNaN(sp) && sp > 0) {
            const stackResult = await commander.readMemory(sp, 64);
            const stackDump = commander.parseMemoryDump(stackResult.rawOutput);
            if (stackDump.length > 0) {
              sections.push("\n## Stack (64 bytes from SP)");
              sections.push(stackDump.map((d) => `${d.address}: ${d.hex}  ${d.ascii}`).join("\n"));
            }
          }
        }

        // 4. RTT output
        const lines = this.rttClient.getLines(rttLines ?? 30);
        if (lines.length > 0) {
          sections.push(`\n## RTT Output (last ${lines.length} lines)`);
          sections.push(lines.join("\n"));
        } else if (this.rttClient.isConnected()) {
          sections.push("\n## RTT Output\n(no output captured yet)");
        }

        return { content: [{ type: "text", text: sections.join("\n") }] };
      }
    );

    this.server.tool(
      "diagnose_crash",
      "Automatically read and decode ARM Cortex-M fault registers (CFSR, HFSR, MMFAR, BFAR), read the exception stack frame, and provide a human-readable crash analysis.",
      {},
      async () => {
        const sections: string[] = ["## Crash Diagnosis"];

        // 1. Registers
        const regResult = await commander.readAllRegisters();
        const regs = commander.parseRegisters(regResult.rawOutput);
        if (regs) {
          sections.push("\n### CPU State");
          sections.push(commander.formatRegistersCompact(regs));

          // Check if we're in an exception handler
          const ipsr = regs["IPSR"];
          if (ipsr && ipsr !== "0x000" && ipsr !== "0x00000000") {
            sections.push(`\n⚠ CPU is in exception handler (IPSR=${ipsr})`);
          }
        }

        // 2. Fault registers (auto-decoded)
        const faultData = await commander.readFaultRegisters();
        sections.push("\n### Fault Registers");
        sections.push(`CFSR=0x${faultData.raw.cfsr.toString(16).padStart(8, "0")} HFSR=0x${faultData.raw.hfsr.toString(16).padStart(8, "0")} MMFAR=0x${faultData.raw.mmfar.toString(16).padStart(8, "0")} BFAR=0x${faultData.raw.bfar.toString(16).padStart(8, "0")}`);
        sections.push("\n### Decoded Faults");
        sections.push(faultData.decoded);

        // 3. Exception stack frame (from PSP or MSP depending on CONTROL)
        if (regs) {
          const spAddr = regs["PSP"] && regs["PSP"] !== "0x00000000"
            ? parseInt(regs["PSP"], 16)
            : parseInt(regs["MSP"] || "0", 16);

          if (spAddr > 0 && spAddr < 0xFFFFFFFF) {
            const frameResult = await commander.readMemory(spAddr, 32);
            const frameDump = commander.parseMemoryDump(frameResult.rawOutput);
            if (frameDump.length > 0) {
              sections.push("\n### Exception Stack Frame");
              // ARM Cortex-M exception frame: R0, R1, R2, R3, R12, LR, PC, xPSR
              const allBytes = frameDump.map((d) => d.hex).join(" ");
              const bytes = allBytes.split(/\s+/).filter(Boolean);
              if (bytes.length >= 32) {
                const frameRegs = ["R0", "R1", "R2", "R3", "R12", "LR", "PC", "xPSR"];
                for (let i = 0; i < frameRegs.length; i++) {
                  const offset = i * 4;
                  if (offset + 3 < bytes.length) {
                    const val = [bytes[offset+3], bytes[offset+2], bytes[offset+1], bytes[offset]].join("");
                    sections.push(`  ${frameRegs[i].padEnd(5)} = 0x${val}`);
                  }
                }
                // Highlight the faulting PC
                if (bytes.length >= 28) {
                  const faultPC = [bytes[27], bytes[26], bytes[25], bytes[24]].join("");
                  sections.push(`\n→ Faulting instruction at PC=0x${faultPC}`);
                }
              } else {
                sections.push(frameDump.map((d) => `${d.address}: ${d.hex}`).join("\n"));
              }
            }
          }
        }

        // 4. Recent RTT for context
        const errLines = this.rttClient.search({ level: "err", count: 10 });
        const wrnLines = this.rttClient.search({ level: "wrn", count: 5 });
        if (errLines.length > 0 || wrnLines.length > 0) {
          sections.push("\n### Recent Errors/Warnings from RTT");
          for (const l of [...errLines, ...wrnLines]) {
            const prefix = l.level === "err" ? "ERR" : "WRN";
            sections.push(`  [${prefix}] ${l.module || "?"}: ${l.message}`);
          }
        }

        return { content: [{ type: "text", text: sections.join("\n") }] };
      }
    );

    // ═══════════════════════════════════════════════════════════════
    // DEVICE CONTROL
    // ═══════════════════════════════════════════════════════════════

    this.server.tool(
      "device_info",
      "Get connected J-Link probe and target device info. Returns probe serial, target CPU, and compact register summary.",
      {},
      async () => {
        const result = await commander.getDeviceInfo();
        const regs = commander.parseRegisters(result.rawOutput);
        if (regs) {
          const config = getConfig();
          const lines = [
            `Device: ${config.jlink.device} via ${config.jlink.interface} @ ${config.jlink.speed} kHz`,
            `J-Link: ${config.jlink.installDir}`,
            "",
            commander.formatRegistersCompact(regs),
          ];
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }
        return { content: [{ type: "text", text: result.output || result.rawOutput }] };
      }
    );

    this.server.tool(
      "halt",
      "Halt the target CPU execution",
      {},
      async () => {
        const result = await commander.haltDevice();
        return { content: [{ type: "text", text: result.success ? "CPU halted" : `Failed: ${result.output}` }] };
      }
    );

    this.server.tool(
      "resume",
      "Resume (go) the target CPU execution",
      {},
      async () => {
        const result = await commander.resumeDevice();
        return { content: [{ type: "text", text: result.success ? "CPU resumed" : `Failed: ${result.output}` }] };
      }
    );

    this.server.tool(
      "reset",
      "Reset the target device",
      { halt: z.boolean().optional().describe("If true, halt after reset (default: false = run after reset)") },
      async ({ halt }) => {
        const result = await commander.resetDevice(halt ?? false);
        return { content: [{ type: "text", text: result.success ? `Device reset${halt ? " (halted)" : " (running)"}` : `Failed: ${result.output}` }] };
      }
    );

    this.server.tool(
      "step",
      "Execute a single CPU instruction (step). Returns new PC and changed registers.",
      {},
      async () => {
        const result = await commander.stepInstruction();
        const regs = commander.parseRegisters(result.rawOutput);
        if (regs) {
          return { content: [{ type: "text", text: `Stepped. PC=${regs["PC"] || "?"} LR=${regs["LR"] || "?"} SP=${regs["SP"] || "?"}` }] };
        }
        return { content: [{ type: "text", text: result.output }] };
      }
    );

    // ═══════════════════════════════════════════════════════════════
    // MEMORY
    // ═══════════════════════════════════════════════════════════════

    this.server.tool(
      "read_memory",
      "Read memory from the target device. Returns a clean hex dump.",
      {
        address: z.string().describe("Memory address in hex (e.g., '0x20000000')"),
        length: z.number().min(1).max(4096).describe("Number of bytes to read (max 4096)"),
      },
      async ({ address, length }) => {
        const addr = parseInt(address, 16);
        if (isNaN(addr)) {
          return { content: [{ type: "text", text: "Error: Invalid address. Use hex like '0x20000000'" }] };
        }
        const result = await commander.readMemory(addr, length);
        const dump = commander.parseMemoryDump(result.rawOutput);
        if (dump.length > 0) {
          const lines = dump.map((d) => `${d.address}: ${d.hex}  ${d.ascii}`);
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }
        // Fallback to cleaned output
        return { content: [{ type: "text", text: result.output || "Could not read memory" }] };
      }
    );

    this.server.tool(
      "write_memory",
      "Write a 32-bit value to a memory address on the target device",
      {
        address: z.string().describe("Memory address in hex (e.g., '0x20000000')"),
        value: z.string().describe("32-bit value in hex (e.g., '0xDEADBEEF')"),
      },
      async ({ address, value }) => {
        const addr = parseInt(address, 16);
        const val = parseInt(value, 16);
        if (isNaN(addr) || isNaN(val)) {
          return { content: [{ type: "text", text: "Error: Invalid hex format" }] };
        }
        const result = await commander.writeMemory(addr, val);
        return { content: [{ type: "text", text: result.success ? `Wrote 0x${val.toString(16)} to 0x${addr.toString(16)}` : `Failed: ${result.output}` }] };
      }
    );

    // ═══════════════════════════════════════════════════════════════
    // REGISTERS
    // ═══════════════════════════════════════════════════════════════

    this.server.tool(
      "read_registers",
      "Read all CPU registers (halts CPU). Returns compact formatted output with core regs, status, stack pointers. FP regs only shown if non-zero.",
      {},
      async () => {
        const result = await commander.readAllRegisters();
        const regs = commander.parseRegisters(result.rawOutput);
        if (regs) {
          return { content: [{ type: "text", text: commander.formatRegistersCompact(regs) }] };
        }
        return { content: [{ type: "text", text: result.output }] };
      }
    );

    this.server.tool(
      "read_register",
      "Read a specific CPU register by name (e.g., R0-R12, SP, PC, LR, MSP, PSP, XPSR, CONTROL, PRIMASK)",
      {
        register: z.string().describe("Register name (e.g., 'PC', 'SP', 'R0', 'LR')"),
      },
      async ({ register }) => {
        const result = await commander.readRegister(register);
        return { content: [{ type: "text", text: result.output || result.rawOutput }] };
      }
    );

    // ═══════════════════════════════════════════════════════════════
    // FLASH
    // ═══════════════════════════════════════════════════════════════

    this.server.tool(
      "flash",
      "Flash a firmware binary/hex file to the target device. Resets and runs after flashing.",
      {
        filePath: z.string().describe("Path to the firmware file (.hex, .bin, .elf)"),
        baseAddress: z.string().optional().describe("Base address for .bin files (hex, e.g., '0x08000000')"),
      },
      async ({ filePath, baseAddress }) => {
        const addr = baseAddress ? parseInt(baseAddress, 16) : undefined;
        const result = await commander.flashFirmware(filePath, addr);
        return { content: [{ type: "text", text: result.success ? `Flashed ${filePath} successfully` : `Flash failed: ${result.output}` }] };
      }
    );

    this.server.tool(
      "erase",
      "Erase the entire flash memory of the target device",
      {},
      async () => {
        const result = await commander.eraseChip();
        return { content: [{ type: "text", text: result.success ? "Chip erased" : `Erase failed: ${result.output}` }] };
      }
    );

    // ═══════════════════════════════════════════════════════════════
    // BREAKPOINTS
    // ═══════════════════════════════════════════════════════════════

    this.server.tool(
      "set_breakpoint",
      "Set a hardware breakpoint at an address",
      { address: z.string().describe("Address in hex (e.g., '0x08000100')") },
      async ({ address }) => {
        const addr = parseInt(address, 16);
        const result = await commander.setBreakpoint(addr);
        return { content: [{ type: "text", text: result.success ? `Breakpoint set at 0x${addr.toString(16)}` : `Failed: ${result.output}` }] };
      }
    );

    this.server.tool(
      "clear_breakpoints",
      "Clear all hardware breakpoints",
      {},
      async () => {
        const result = await commander.clearBreakpoints();
        return { content: [{ type: "text", text: "Breakpoints cleared" }] };
      }
    );

    // ═══════════════════════════════════════════════════════════════
    // GDB SERVER
    // ═══════════════════════════════════════════════════════════════

    this.server.tool(
      "gdb_server_start",
      "Start JLinkGDBServer (enables GDB debugging and RTT telnet access)",
      {},
      async () => {
        const result = this.gdbServer.start();
        return { content: [{ type: "text", text: result.message }] };
      }
    );

    this.server.tool(
      "gdb_server_stop",
      "Stop the running JLinkGDBServer and disconnect RTT",
      {},
      async () => {
        this.rttClient.disconnect();
        const result = this.gdbServer.stop();
        return { content: [{ type: "text", text: result.message }] };
      }
    );

    this.server.tool(
      "gdb_server_status",
      "Get GDB server, RTT, and telnet proxy status in one call",
      {},
      async () => {
        const status = {
          gdbServer: this.gdbServer.getStatus(),
          rtt: this.rttClient.getStats(),
          telnetProxy: this.telnetProxy.getStatus(),
        };
        return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
      }
    );

    // ═══════════════════════════════════════════════════════════════
    // RTT (Real-Time Transfer)
    // ═══════════════════════════════════════════════════════════════

    this.server.tool(
      "rtt_connect",
      "Connect to RTT telnet port. Requires GDB server to be running. Use start_debug_session for one-call setup.",
      {},
      async () => {
        try {
          await this.rttClient.connect();
          return { content: [{ type: "text", text: "Connected to RTT" }] };
        } catch (err) {
          return { content: [{ type: "text", text: `Failed: ${err instanceof Error ? err.message : String(err)}. Is GDB server running? Use start_debug_session instead.` }] };
        }
      }
    );

    this.server.tool(
      "rtt_disconnect",
      "Disconnect from RTT",
      {},
      async () => {
        this.rttClient.disconnect();
        return { content: [{ type: "text", text: "Disconnected from RTT" }] };
      }
    );

    this.server.tool(
      "rtt_read",
      "Read recent RTT log lines from the device. Output is clean (no ANSI codes, no SEGGER banners). Zephyr log format is parsed.",
      {
        count: z.number().min(1).max(500).optional().describe("Number of recent lines to read (default 50)"),
      },
      async ({ count }) => {
        if (!this.rttClient.isConnected()) {
          return { content: [{ type: "text", text: "RTT not connected. Use start_debug_session or rtt_connect first." }] };
        }
        const lines = this.rttClient.getLines(count ?? 50);
        if (lines.length === 0) {
          return { content: [{ type: "text", text: "No RTT output yet. Device may not be producing output or may need a reset." }] };
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }
    );

    this.server.tool(
      "rtt_search",
      "Search/filter RTT logs by level (dbg/inf/wrn/err), module name, or regex pattern. Useful for finding errors or specific subsystem output.",
      {
        level: z.string().optional().describe("Log level filter: 'err', 'wrn', 'inf', 'dbg'"),
        module: z.string().optional().describe("Module name filter (partial match, e.g., 'main', 'inference')"),
        pattern: z.string().optional().describe("Regex or text pattern to search for in messages"),
        count: z.number().min(1).max(500).optional().describe("Max results to return (default 50)"),
      },
      async ({ level, module, pattern, count }) => {
        const results = this.rttClient.search({ level, module, pattern, count: count ?? 50 });
        if (results.length === 0) {
          return { content: [{ type: "text", text: `No matches found${level ? ` for level=${level}` : ""}${module ? ` module=${module}` : ""}${pattern ? ` pattern=${pattern}` : ""}` }] };
        }
        const lines = results.map(formatLogLine);
        return { content: [{ type: "text", text: `Found ${results.length} matches:\n${lines.join("\n")}` }] };
      }
    );

    this.server.tool(
      "rtt_send",
      "Send data to the device via RTT down-channel (host → device)",
      { data: z.string().describe("String data to send to the device") },
      async ({ data }) => {
        const sent = this.rttClient.send(data);
        return { content: [{ type: "text", text: sent ? `Sent ${data.length} bytes` : "Failed: RTT not connected" }] };
      }
    );

    this.server.tool(
      "rtt_clear",
      "Clear the RTT message buffer",
      {},
      async () => {
        this.rttClient.clearBuffer();
        return { content: [{ type: "text", text: "RTT buffer cleared" }] };
      }
    );

    // ═══════════════════════════════════════════════════════════════
    // TELNET PROXY (for Trice / Pigweed)
    // ═══════════════════════════════════════════════════════════════

    this.server.tool(
      "telnet_proxy_start",
      "Start TCP proxy that tees RTT data so external tools (Trice, Pigweed detokenizer) can connect. They connect to the proxy port to receive the RTT stream.",
      {},
      async () => {
        const result = await this.telnetProxy.start();
        return { content: [{ type: "text", text: result.message }] };
      }
    );

    this.server.tool(
      "telnet_proxy_stop",
      "Stop the telnet proxy server",
      {},
      async () => {
        this.telnetProxy.stop();
        return { content: [{ type: "text", text: "Telnet proxy stopped" }] };
      }
    );

    this.server.tool(
      "telnet_proxy_status",
      "Get telnet proxy status",
      {},
      async () => {
        return { content: [{ type: "text", text: JSON.stringify(this.telnetProxy.getStatus(), null, 2) }] };
      }
    );

    this.server.tool(
      "telnet_proxy_read",
      "Read recent raw data from the telnet proxy buffer",
      { lines: z.number().min(1).max(500).optional().describe("Number of recent lines (default 100)") },
      async ({ lines }) => {
        const data = this.telnetProxy.getBuffer(lines ?? 100);
        return { content: [{ type: "text", text: data.length > 0 ? data.join("\n") : "No data in proxy buffer" }] };
      }
    );

    // ═══════════════════════════════════════════════════════════════
    // RAW / CONFIG
    // ═══════════════════════════════════════════════════════════════

    this.server.tool(
      "jlink_command",
      "Execute raw J-Link Commander commands. Output has connection boilerplate stripped. Use for anything not covered by other tools.",
      {
        commands: z.array(z.string()).describe("J-Link Commander commands (e.g., ['halt', 'mem 0x20000000, 64', 'go'])"),
      },
      async ({ commands }) => {
        const result = await commander.executeRawCommands(commands);
        return { content: [{ type: "text", text: result.output || "(no output)" }] };
      }
    );

    this.server.tool(
      "get_config",
      "Get the current J-Link MCP configuration (device, interface, ports, paths)",
      {},
      async () => {
        return { content: [{ type: "text", text: JSON.stringify(getConfig(), null, 2) }] };
      }
    );
  }

  private registerResources(): void {
    this.server.resource(
      "rtt-output",
      "rtt://output",
      { description: "Clean RTT output (ANSI stripped, Zephyr logs parsed)", mimeType: "text/plain" },
      async () => {
        const lines = this.rttClient.getLines(200);
        return { contents: [{ uri: "rtt://output", text: lines.join("\n"), mimeType: "text/plain" }] };
      }
    );

    this.server.resource(
      "gdb-server-log",
      "jlink://gdb-server-log",
      { description: "Recent JLinkGDBServer output log", mimeType: "text/plain" },
      async () => {
        const output = this.gdbServer.getRecentOutput(200);
        return { contents: [{ uri: "jlink://gdb-server-log", text: output.join("\n"), mimeType: "text/plain" }] };
      }
    );

    this.server.resource(
      "telnet-proxy-buffer",
      "jlink://telnet-proxy-buffer",
      { description: "Raw data from the telnet proxy buffer", mimeType: "text/plain" },
      async () => {
        const data = this.telnetProxy.getBuffer(500);
        return { contents: [{ uri: "jlink://telnet-proxy-buffer", text: data.join("\n"), mimeType: "text/plain" }] };
      }
    );

    this.server.resource(
      "system-status",
      "jlink://status",
      { description: "Overall system status: GDB server, RTT, telnet proxy, config", mimeType: "application/json" },
      async () => {
        const status = {
          gdbServer: this.gdbServer.getStatus(),
          rtt: this.rttClient.getStats(),
          telnetProxy: this.telnetProxy.getStatus(),
          runningProcesses: this.processManager.listRunning(),
          config: getConfig(),
        };
        return { contents: [{ uri: "jlink://status", text: JSON.stringify(status, null, 2), mimeType: "application/json" }] };
      }
    );
  }

  private registerPrompts(): void {
    this.server.prompt(
      "debug-embedded",
      "Start an embedded debugging session. Best prompt to begin with.",
      {},
      async () => ({
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: `You are an embedded systems debugging assistant with access to a J-Link debug probe.

## Quick start
Call start_debug_session first - it does GDB server + RTT setup in one call.

## Key tools (use these most):
- **start_debug_session** - One-call setup, returns boot log
- **snapshot** - Full device state in one call (regs + faults + stack + RTT)
- **diagnose_crash** - Auto-decode fault registers after a crash
- **rtt_read** / **rtt_search** - Read or filter device logs
- **read_memory** / **read_registers** - Inspect device state

## Other tools:
- halt/resume/reset/step - CPU control
- flash/erase - Firmware programming
- set_breakpoint/clear_breakpoints - HW breakpoints
- read_register, write_memory - Fine-grained access
- jlink_command - Raw JLinkExe commands
- telnet_proxy_start - Expose RTT for Trice/Pigweed

## ARM Cortex-M memory map:
- 0x00000000: Vector table (initial SP + reset handler)
- 0x20000000: SRAM
- 0xE000ED00: System Control Block
- 0xE000ED28: CFSR (fault status)
- 0xE000E100: NVIC

Please help me debug my device. Start with start_debug_session.`,
          },
        }],
      })
    );

    this.server.prompt(
      "analyze-rtt-output",
      "Analyze RTT output for errors, warnings, timing issues, and anomalies",
      {},
      async () => {
        const lines = this.rttClient.getLines(200);
        const errLines = this.rttClient.search({ level: "err", count: 20 });
        const wrnLines = this.rttClient.search({ level: "wrn", count: 20 });

        const sections = [];
        if (errLines.length > 0) {
          sections.push("## Errors found:\n" + errLines.map(formatLogLine).join("\n"));
        }
        if (wrnLines.length > 0) {
          sections.push("## Warnings found:\n" + wrnLines.map(formatLogLine).join("\n"));
        }
        sections.push("## Full log:\n" + (lines.length > 0 ? lines.join("\n") : "(No RTT data - use start_debug_session first)"));

        return {
          messages: [{
            role: "user",
            content: {
              type: "text",
              text: `Analyze this RTT output. Look for: faults, errors, warnings, unexpected resets, stack overflows, assertion failures, timing anomalies.\n\n${sections.join("\n\n")}`,
            },
          }],
        };
      }
    );

    this.server.prompt(
      "crash-analysis",
      "Diagnose a crash/fault. Use diagnose_crash tool for auto-analysis.",
      {},
      async () => ({
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: `My device has crashed. Use the diagnose_crash tool first - it auto-reads fault registers, exception stack frame, and recent errors. Then explain what happened and suggest fixes.`,
          },
        }],
      })
    );

    this.server.prompt(
      "peripheral-inspect",
      "Inspect ARM Cortex-M peripheral registers by reading memory-mapped I/O",
      {
        peripheral: z.string().optional().describe("Peripheral name (GPIO, UART, SPI, I2C, TIMER)"),
        baseAddress: z.string().optional().describe("Base address of peripheral in hex"),
      },
      async ({ peripheral, baseAddress }) => ({
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: `Inspect the ${peripheral || "peripheral"} registers on my device.${baseAddress ? ` Base address: ${baseAddress}.` : ""} Use read_memory to read the register block and decode the bit fields.`,
          },
        }],
      })
    );
  }

  async startStdio(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    log("MCP Server started on stdio");
  }

  dispose(): void {
    this.rttClient.disconnect();
    this.telnetProxy.stop();
    this.processManager.killAll();
  }
}

function formatLogLine(l: ParsedLogLine): string {
  if (l.deviceTime && l.level && l.module) {
    return `[${l.deviceTime}] <${l.level}> ${l.module}: ${l.message}`;
  }
  return l.message;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
