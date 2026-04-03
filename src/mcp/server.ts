import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ProbeBackend } from "../probe/backend";
import { createProbeBackend, ProbeFactoryConfig } from "../probe/factory";
import { RTTClient, ParsedLogLine } from "../rtt/rtt-client";
import { TelnetProxy } from "../telnet/telnet-proxy";
import { ProcessManager } from "../utils/process-manager";
import { log } from "../utils/logger";

export class JLinkMcpServer {
  private server: McpServer;
  private processManager: ProcessManager;
  private probe: ProbeBackend;
  private rttClient: RTTClient;
  private telnetProxy: TelnetProxy;

  constructor(probeConfig?: ProbeFactoryConfig, rttPort?: number, telnetConfig?: { listenPort?: number; sourceHost?: string; sourcePort?: number }) {
    this.processManager = new ProcessManager();
    this.probe = createProbeBackend(
      probeConfig || { type: "jlink" },
      this.processManager
    );

    const effectiveRttPort = rttPort ?? this.probe.getRTTPort();
    this.rttClient = new RTTClient("localhost", effectiveRttPort > 0 ? effectiveRttPort : 19021);
    this.telnetProxy = new TelnetProxy(
      telnetConfig?.listenPort ?? 19400,
      telnetConfig?.sourceHost ?? "localhost",
      telnetConfig?.sourcePort ?? (effectiveRttPort > 0 ? effectiveRttPort : 19021)
    );

    this.server = new McpServer({
      name: "jlink-mcp",
      version: "0.1.1",
    });

    this.registerTools();
    this.registerResources();
    this.registerPrompts();
  }

  private registerTools(): void {
    const probe = this.probe;

    // ═══════════════════════════════════════════════════════════════
    // COMPOSITE / WORKFLOW TOOLS
    // ═══════════════════════════════════════════════════════════════

    this.server.tool(
      "start_debug_session",
      `One-call setup: starts GDB server via ${probe.displayName}, connects RTT (if supported), waits for initial output. This is the recommended first tool to call.`,
      {},
      async () => {
        const steps: string[] = [];

        if (!probe.isGDBServerRunning()) {
          const gdbResult = await probe.startGDBServer();
          steps.push(gdbResult.success ? `GDB Server: started (${probe.displayName})` : `GDB Server: ${gdbResult.message}`);
          if (!gdbResult.success) return { content: [{ type: "text", text: steps.join("\n") }] };
          await sleep(2000);
        } else {
          steps.push("GDB Server: already running");
        }

        if (probe.supportsRTT() && !this.rttClient.isConnected()) {
          try {
            await this.rttClient.connect();
            steps.push(`RTT: connected (port ${probe.getRTTPort()})`);
            await sleep(1500);
          } catch (err) {
            steps.push(`RTT: failed - ${err instanceof Error ? err.message : String(err)}`);
          }
        } else if (!probe.supportsRTT()) {
          steps.push(`RTT: not supported by ${probe.displayName}`);
        } else {
          steps.push("RTT: already connected");
        }

        const lines = this.rttClient.getLines(100);
        if (lines.length > 0) {
          steps.push(`\n--- Device Output (${lines.length} lines) ---`);
          steps.push(lines.join("\n"));
        } else {
          steps.push("\nNo RTT output yet.");
        }

        return { content: [{ type: "text", text: steps.join("\n") }] };
      }
    );

    this.server.tool(
      "snapshot",
      "Capture complete device state: CPU registers (compact), fault status, recent RTT output, and stack dump.",
      { rttLines: z.number().min(0).max(200).optional().describe("RTT lines to include (default 30)") },
      async ({ rttLines }) => {
        const sections: string[] = [];

        const regResult = await probe.readAllRegisters();
        const regs = probe.parseRegisters(regResult.rawOutput);
        if (regs) {
          sections.push("## Registers");
          sections.push(probe.formatRegistersCompact(regs));
        } else {
          sections.push("## Registers\n" + (regResult.output || "Failed to read"));
        }

        const faultData = await probe.readFaultRegisters();
        sections.push("\n## Fault Status");
        sections.push(faultData.decoded);

        if (regs?.["SP"]) {
          const sp = parseInt(regs["SP"], 16);
          if (!isNaN(sp) && sp > 0) {
            const stackResult = await probe.readMemory(sp, 64);
            const stackDump = probe.parseMemoryDump(stackResult.rawOutput);
            if (stackDump.length > 0) {
              sections.push("\n## Stack (64 bytes from SP)");
              sections.push(stackDump.map((d) => `${d.address}: ${d.hex}  ${d.ascii}`).join("\n"));
            }
          }
        }

        const lines = this.rttClient.getLines(rttLines ?? 30);
        if (lines.length > 0) {
          sections.push(`\n## RTT Output (last ${lines.length} lines)`);
          sections.push(lines.join("\n"));
        }

        return { content: [{ type: "text", text: sections.join("\n") }] };
      }
    );

    this.server.tool(
      "diagnose_crash",
      "Auto-read and decode ARM Cortex-M fault registers (CFSR, HFSR, MMFAR, BFAR), exception stack frame, and recent errors.",
      {},
      async () => {
        const sections: string[] = ["## Crash Diagnosis"];

        const regResult = await probe.readAllRegisters();
        const regs = probe.parseRegisters(regResult.rawOutput);
        if (regs) {
          sections.push("\n### CPU State");
          sections.push(probe.formatRegistersCompact(regs));
          const ipsr = regs["IPSR"];
          if (ipsr && ipsr !== "0x000" && ipsr !== "0x00000000") {
            sections.push(`\n⚠ CPU is in exception handler (IPSR=${ipsr})`);
          }
        }

        const faultData = await probe.readFaultRegisters();
        sections.push("\n### Fault Registers");
        sections.push(`CFSR=0x${faultData.raw.cfsr.toString(16).padStart(8, "0")} HFSR=0x${faultData.raw.hfsr.toString(16).padStart(8, "0")} MMFAR=0x${faultData.raw.mmfar.toString(16).padStart(8, "0")} BFAR=0x${faultData.raw.bfar.toString(16).padStart(8, "0")}`);
        sections.push("\n### Decoded Faults");
        sections.push(faultData.decoded);

        if (regs) {
          const spAddr = regs["PSP"] && regs["PSP"] !== "0x00000000"
            ? parseInt(regs["PSP"], 16)
            : parseInt(regs["MSP"] || "0", 16);
          if (spAddr > 0 && spAddr < 0xFFFFFFFF) {
            const frameResult = await probe.readMemory(spAddr, 32);
            const frameDump = probe.parseMemoryDump(frameResult.rawOutput);
            if (frameDump.length > 0) {
              sections.push("\n### Exception Stack Frame");
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

        const errLines = this.rttClient.search({ level: "err", count: 10 });
        const wrnLines = this.rttClient.search({ level: "wrn", count: 5 });
        if (errLines.length > 0 || wrnLines.length > 0) {
          sections.push("\n### Recent Errors/Warnings from RTT");
          for (const l of [...errLines, ...wrnLines]) {
            sections.push(`  [${l.level === "err" ? "ERR" : "WRN"}] ${l.module || "?"}: ${l.message}`);
          }
        }

        return { content: [{ type: "text", text: sections.join("\n") }] };
      }
    );

    // ═══════════════════════════════════════════════════════════════
    // DEVICE CONTROL
    // ═══════════════════════════════════════════════════════════════

    this.server.tool("device_info",
      `Get connected device info via ${probe.displayName}. Returns probe type, target CPU, and compact register summary.`,
      {},
      async () => {
        const result = await probe.getDeviceInfo();
        const regs = probe.parseRegisters(result.rawOutput);
        if (regs) {
          return { content: [{ type: "text", text: `Probe: ${probe.displayName}\n\n${probe.formatRegistersCompact(regs)}` }] };
        }
        return { content: [{ type: "text", text: result.output || result.rawOutput }] };
      }
    );

    this.server.tool("halt", "Halt the target CPU", {},
      async () => {
        const r = await probe.halt();
        return { content: [{ type: "text", text: r.success ? "CPU halted" : `Failed: ${r.output}` }] };
      }
    );

    this.server.tool("resume", "Resume the target CPU", {},
      async () => {
        const r = await probe.resume();
        return { content: [{ type: "text", text: r.success ? "CPU resumed" : `Failed: ${r.output}` }] };
      }
    );

    this.server.tool("reset", "Reset the target device",
      { halt: z.boolean().optional().describe("Halt after reset (default: false)") },
      async ({ halt }) => {
        const r = await probe.reset(halt ?? false);
        return { content: [{ type: "text", text: r.success ? `Device reset${halt ? " (halted)" : " (running)"}` : `Failed: ${r.output}` }] };
      }
    );

    this.server.tool("step", "Step one CPU instruction",
      {},
      async () => {
        const r = await probe.step();
        const regs = probe.parseRegisters(r.rawOutput);
        if (regs) return { content: [{ type: "text", text: `Stepped. PC=${regs["PC"] || "?"} LR=${regs["LR"] || "?"} SP=${regs["SP"] || "?"}` }] };
        return { content: [{ type: "text", text: r.output }] };
      }
    );

    // ═══════════════════════════════════════════════════════════════
    // MEMORY
    // ═══════════════════════════════════════════════════════════════

    this.server.tool("read_memory", "Read memory from the target. Returns clean hex dump.",
      {
        address: z.string().describe("Hex address (e.g., '0x20000000')"),
        length: z.number().min(1).max(4096).describe("Bytes to read (max 4096)"),
      },
      async ({ address, length }) => {
        const addr = parseInt(address, 16);
        if (isNaN(addr)) return { content: [{ type: "text", text: "Error: invalid hex address" }] };
        const r = await probe.readMemory(addr, length);
        const dump = probe.parseMemoryDump(r.rawOutput);
        if (dump.length > 0) return { content: [{ type: "text", text: dump.map((d) => `${d.address}: ${d.hex}  ${d.ascii}`).join("\n") }] };
        return { content: [{ type: "text", text: r.output || "Could not read memory" }] };
      }
    );

    this.server.tool("write_memory", "Write a 32-bit value to memory",
      {
        address: z.string().describe("Hex address"),
        value: z.string().describe("Hex value (e.g., '0xDEADBEEF')"),
      },
      async ({ address, value }) => {
        const addr = parseInt(address, 16), val = parseInt(value, 16);
        if (isNaN(addr) || isNaN(val)) return { content: [{ type: "text", text: "Error: invalid hex" }] };
        const r = await probe.writeMemory(addr, val);
        return { content: [{ type: "text", text: r.success ? `Wrote 0x${val.toString(16)} to 0x${addr.toString(16)}` : `Failed: ${r.output}` }] };
      }
    );

    // ═══════════════════════════════════════════════════════════════
    // REGISTERS
    // ═══════════════════════════════════════════════════════════════

    this.server.tool("read_registers", "Read all CPU registers (compact format, FP only if non-zero).", {},
      async () => {
        const r = await probe.readAllRegisters();
        const regs = probe.parseRegisters(r.rawOutput);
        if (regs) return { content: [{ type: "text", text: probe.formatRegistersCompact(regs) }] };
        return { content: [{ type: "text", text: r.output }] };
      }
    );

    this.server.tool("read_register", "Read a specific CPU register by name",
      { register: z.string().describe("Register name (e.g., 'PC', 'SP', 'R0')") },
      async ({ register }) => {
        const r = await probe.readRegister(register);
        return { content: [{ type: "text", text: r.output || r.rawOutput }] };
      }
    );

    // ═══════════════════════════════════════════════════════════════
    // FLASH
    // ═══════════════════════════════════════════════════════════════

    this.server.tool("flash", "Flash firmware to the target device",
      {
        filePath: z.string().describe("Path to firmware file (.hex, .bin, .elf)"),
        baseAddress: z.string().optional().describe("Base address for .bin files (hex)"),
      },
      async ({ filePath, baseAddress }) => {
        const addr = baseAddress ? parseInt(baseAddress, 16) : undefined;
        const r = await probe.flash(filePath, addr);
        return { content: [{ type: "text", text: r.success ? `Flashed ${filePath}` : `Flash failed: ${r.output}` }] };
      }
    );

    this.server.tool("erase", "Erase target flash memory", {},
      async () => {
        const r = await probe.erase();
        return { content: [{ type: "text", text: r.success ? "Chip erased" : `Erase failed: ${r.output}` }] };
      }
    );

    // ═══════════════════════════════════════════════════════════════
    // BREAKPOINTS
    // ═══════════════════════════════════════════════════════════════

    this.server.tool("set_breakpoint", "Set a hardware breakpoint",
      { address: z.string().describe("Hex address") },
      async ({ address }) => {
        const addr = parseInt(address, 16);
        const r = await probe.setBreakpoint(addr);
        return { content: [{ type: "text", text: r.success ? `Breakpoint set at 0x${addr.toString(16)}` : `Failed: ${r.output}` }] };
      }
    );

    this.server.tool("clear_breakpoints", "Clear all breakpoints", {},
      async () => { await probe.clearBreakpoints(); return { content: [{ type: "text", text: "Breakpoints cleared" }] }; }
    );

    // ═══════════════════════════════════════════════════════════════
    // GDB SERVER
    // ═══════════════════════════════════════════════════════════════

    this.server.tool("gdb_server_start", `Start ${probe.displayName} GDB server`, {},
      async () => { const r = await probe.startGDBServer(); return { content: [{ type: "text", text: r.message }] }; }
    );

    this.server.tool("gdb_server_stop", `Stop ${probe.displayName} GDB server and disconnect RTT`, {},
      async () => { this.rttClient.disconnect(); const r = probe.stopGDBServer(); return { content: [{ type: "text", text: r.message }] }; }
    );

    this.server.tool("gdb_server_status", "Get GDB server, RTT, and telnet proxy status", {},
      async () => {
        const status = { probe: probe.displayName, gdbServer: probe.getGDBServerStatus(), rtt: this.rttClient.getStats(), telnetProxy: this.telnetProxy.getStatus() };
        return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
      }
    );

    // ═══════════════════════════════════════════════════════════════
    // RTT
    // ═══════════════════════════════════════════════════════════════

    this.server.tool("rtt_connect", `Connect to RTT${probe.supportsRTT() ? "" : " (not supported by " + probe.displayName + ")"}`, {},
      async () => {
        if (!probe.supportsRTT()) return { content: [{ type: "text", text: `RTT is not supported by ${probe.displayName}` }] };
        try { await this.rttClient.connect(); return { content: [{ type: "text", text: "Connected to RTT" }] }; }
        catch (err) { return { content: [{ type: "text", text: `Failed: ${err instanceof Error ? err.message : String(err)}` }] }; }
      }
    );

    this.server.tool("rtt_disconnect", "Disconnect from RTT", {},
      async () => { this.rttClient.disconnect(); return { content: [{ type: "text", text: "Disconnected from RTT" }] }; }
    );

    this.server.tool("rtt_read", "Read recent RTT log lines (clean, parsed Zephyr format)",
      { count: z.number().min(1).max(500).optional().describe("Lines to read (default 50)") },
      async ({ count }) => {
        if (!this.rttClient.isConnected()) return { content: [{ type: "text", text: "RTT not connected. Use start_debug_session first." }] };
        const lines = this.rttClient.getLines(count ?? 50);
        return { content: [{ type: "text", text: lines.length > 0 ? lines.join("\n") : "No RTT output yet." }] };
      }
    );

    this.server.tool("rtt_search", "Search/filter RTT logs by level, module, or regex",
      {
        level: z.string().optional().describe("Log level: 'err', 'wrn', 'inf', 'dbg'"),
        module: z.string().optional().describe("Module name (partial match)"),
        pattern: z.string().optional().describe("Regex or text pattern"),
        count: z.number().min(1).max(500).optional().describe("Max results (default 50)"),
      },
      async ({ level, module, pattern, count }) => {
        const results = this.rttClient.search({ level, module, pattern, count: count ?? 50 });
        if (results.length === 0) return { content: [{ type: "text", text: "No matches found" }] };
        return { content: [{ type: "text", text: `Found ${results.length} matches:\n${results.map(formatLogLine).join("\n")}` }] };
      }
    );

    this.server.tool("rtt_send", "Send data to device via RTT down-channel",
      { data: z.string().describe("Data to send") },
      async ({ data }) => {
        const sent = this.rttClient.send(data);
        return { content: [{ type: "text", text: sent ? `Sent ${data.length} bytes` : "Failed: RTT not connected" }] };
      }
    );

    this.server.tool("rtt_clear", "Clear RTT buffer", {},
      async () => { this.rttClient.clearBuffer(); return { content: [{ type: "text", text: "RTT buffer cleared" }] }; }
    );

    // ═══════════════════════════════════════════════════════════════
    // TELNET PROXY
    // ═══════════════════════════════════════════════════════════════

    this.server.tool("telnet_proxy_start", "Start TCP proxy for Trice/Pigweed detokenizer", {},
      async () => { const r = await this.telnetProxy.start(); return { content: [{ type: "text", text: r.message }] }; }
    );
    this.server.tool("telnet_proxy_stop", "Stop telnet proxy", {},
      async () => { this.telnetProxy.stop(); return { content: [{ type: "text", text: "Telnet proxy stopped" }] }; }
    );
    this.server.tool("telnet_proxy_status", "Get telnet proxy status", {},
      async () => { return { content: [{ type: "text", text: JSON.stringify(this.telnetProxy.getStatus(), null, 2) }] }; }
    );
    this.server.tool("telnet_proxy_read", "Read raw data from telnet proxy buffer",
      { lines: z.number().min(1).max(500).optional().describe("Lines (default 100)") },
      async ({ lines }) => {
        const data = this.telnetProxy.getBuffer(lines ?? 100);
        return { content: [{ type: "text", text: data.length > 0 ? data.join("\n") : "No data" }] };
      }
    );

    // ═══════════════════════════════════════════════════════════════
    // RAW / CONFIG
    // ═══════════════════════════════════════════════════════════════

    this.server.tool("probe_command", `Execute raw ${probe.displayName} commands`,
      { commands: z.array(z.string()).describe("Commands to execute") },
      async ({ commands }) => {
        const r = await probe.executeRaw(commands);
        return { content: [{ type: "text", text: r.output || "(no output)" }] };
      }
    );

    this.server.tool("get_config", "Get current probe and server configuration", {},
      async () => {
        return { content: [{ type: "text", text: JSON.stringify({ probe: probe.type, displayName: probe.displayName, supportsRTT: probe.supportsRTT(), gdbServer: probe.getGDBServerStatus() }, null, 2) }] };
      }
    );
  }

  private registerResources(): void {
    this.server.resource("rtt-output", "rtt://output",
      { description: "Clean RTT output (ANSI stripped, Zephyr logs parsed)", mimeType: "text/plain" },
      async () => ({ contents: [{ uri: "rtt://output", text: this.rttClient.getLines(200).join("\n"), mimeType: "text/plain" }] })
    );

    this.server.resource("gdb-server-log", "probe://gdb-server-log",
      { description: `Recent ${this.probe.displayName} GDB server output`, mimeType: "text/plain" },
      async () => ({ contents: [{ uri: "probe://gdb-server-log", text: this.probe.getGDBServerOutput(200).join("\n"), mimeType: "text/plain" }] })
    );

    this.server.resource("system-status", "probe://status",
      { description: "Overall system status", mimeType: "application/json" },
      async () => {
        const status = { probe: this.probe.type, displayName: this.probe.displayName, gdbServer: this.probe.getGDBServerStatus(), rtt: this.rttClient.getStats(), telnetProxy: this.telnetProxy.getStatus(), runningProcesses: this.processManager.listRunning() };
        return { contents: [{ uri: "probe://status", text: JSON.stringify(status, null, 2), mimeType: "application/json" }] };
      }
    );
  }

  private registerPrompts(): void {
    const probeName = this.probe.displayName;

    this.server.prompt("debug-embedded", "Start an embedded debugging session.", {},
      async () => ({
        messages: [{ role: "user", content: { type: "text", text:
`You are an embedded debugging assistant with a ${probeName} debug probe.

## Quick start
Call start_debug_session first.

## Key tools:
- **start_debug_session** - One-call setup, returns boot log
- **snapshot** - Full device state in one call
- **diagnose_crash** - Auto-decode fault registers
- **rtt_read** / **rtt_search** - Device logs (${this.probe.supportsRTT() ? "supported" : "not supported by " + probeName})
- **read_memory** / **read_registers** - Inspect state
- halt/resume/reset/step - CPU control
- flash/erase - Firmware programming
- probe_command - Raw ${probeName} commands

## ARM Cortex-M memory map:
- 0x00000000: Vector table
- 0x20000000: SRAM
- 0xE000ED28: CFSR (fault status)

Start with start_debug_session.` }}],
      })
    );

    this.server.prompt("crash-analysis", "Diagnose a crash. Use diagnose_crash tool.", {},
      async () => ({
        messages: [{ role: "user", content: { type: "text", text: "My device crashed. Use diagnose_crash first, then explain what happened." } }],
      })
    );

    this.server.prompt("analyze-rtt-output", "Analyze RTT output for errors and anomalies", {},
      async () => {
        const lines = this.rttClient.getLines(200);
        const errs = this.rttClient.search({ level: "err", count: 20 });
        const wrns = this.rttClient.search({ level: "wrn", count: 20 });
        const sections = [];
        if (errs.length > 0) sections.push("## Errors:\n" + errs.map(formatLogLine).join("\n"));
        if (wrns.length > 0) sections.push("## Warnings:\n" + wrns.map(formatLogLine).join("\n"));
        sections.push("## Full log:\n" + (lines.length > 0 ? lines.join("\n") : "(No RTT data)"));
        return { messages: [{ role: "user", content: { type: "text", text: `Analyze this RTT output for faults, errors, anomalies:\n\n${sections.join("\n\n")}` } }] };
      }
    );

    this.server.prompt("peripheral-inspect", "Inspect peripheral registers",
      { peripheral: z.string().optional().describe("Peripheral name"), baseAddress: z.string().optional().describe("Base address hex") },
      async ({ peripheral, baseAddress }) => ({
        messages: [{ role: "user", content: { type: "text", text: `Inspect ${peripheral || "peripheral"} registers.${baseAddress ? ` Base: ${baseAddress}.` : ""} Use read_memory to read the block and decode bit fields.` } }],
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
    this.probe.dispose();
    this.processManager.killAll();
  }
}

function formatLogLine(l: ParsedLogLine): string {
  if (l.deviceTime && l.level && l.module) return `[${l.deviceTime}] <${l.level}> ${l.module}: ${l.message}`;
  return l.message;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
