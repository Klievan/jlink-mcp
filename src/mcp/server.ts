import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ProbeBackend, parseLittleEndian32 } from "../probe/backend";
import { createProbeBackend, ProbeFactoryConfig } from "../probe/factory";
import { GDBClient } from "../gdb/gdb-client";
import { RTTClient, ParsedLogLine } from "../rtt/rtt-client";
import { TelnetProxy } from "../telnet/telnet-proxy";
import { SvdRegistry, decodeValue, formatDecoded } from "../svd";
import { ProcessManager } from "../utils/process-manager";
import { log } from "../utils/logger";

export class JLinkMcpServer {
  private server: McpServer;
  private processManager: ProcessManager;
  private probe: ProbeBackend;
  private gdb: GDBClient;
  private rttClient: RTTClient;
  private telnetProxy: TelnetProxy;
  private svd: SvdRegistry;

  constructor(probeConfig?: ProbeFactoryConfig, rttPort?: number, telnetConfig?: { listenPort?: number; sourceHost?: string; sourcePort?: number }, gdbPath?: string, svdPath?: string) {
    this.processManager = new ProcessManager();
    this.probe = createProbeBackend(
      probeConfig || { type: "jlink" },
      this.processManager
    );

    this.gdb = new GDBClient(gdbPath || "arm-none-eabi-gdb");
    this.svd = new SvdRegistry(svdPath);
    // Let the probe backend route CPU-control and read commands through
    // the GDB session when it's connected, instead of spawning a
    // competing probe-CLI process that would evict the GDB server.
    this.probe.setGdbBridge(this.gdb);
    const effectiveRttPort = rttPort ?? this.probe.getRTTPort();
    this.rttClient = new RTTClient("localhost", effectiveRttPort > 0 ? effectiveRttPort : 19021);
    this.telnetProxy = new TelnetProxy(
      telnetConfig?.listenPort ?? 19400,
      telnetConfig?.sourceHost ?? "localhost",
      telnetConfig?.sourcePort ?? (effectiveRttPort > 0 ? effectiveRttPort : 19021)
    );

    this.server = new McpServer({
      name: "jlink-mcp",
      version: "0.3.2",
    });

    this.registerTools();
    this.registerResources();
    this.registerPrompts();
  }

  /**
   * Returns an MCP error response if device is not configured, or null if OK.
   * Call at the top of any tool handler that talks to hardware.
   */
  private requireDevice(): { content: [{ type: "text"; text: string }] } | null {
    if (!this.probe.isDeviceConfigured()) {
      return {
        content: [{
          type: "text",
          text: `ERROR: No target device configured for ${this.probe.displayName}.\n\nBefore using debugging tools, you must set the target device. Please:\n1. Call list_devices to scan for connected probes\n2. Call set_device with the correct device name (e.g., "nRF52840_XXAA", "STM32F407VG")\n\nCommon device names: nRF52840_XXAA, nRF5340_xxAA_APP, STM32F407VG, STM32L476RG, STM32H743ZI, RP2040_M0_0`,
        }],
      };
    }
    return null;
  }

  private registerTools(): void {
    const probe = this.probe;

    // ═══════════════════════════════════════════════════════════════
    // DEVICE CONFIGURATION (always available, even without device set)
    // ═══════════════════════════════════════════════════════════════

    this.server.tool(
      "list_devices",
      "Scan for connected debug probes and show what hardware is attached. Use this first if you don't know what device is connected.",
      {},
      async () => {
        const result = await probe.listDevices();
        const lines = [
          `Probe: ${probe.displayName}`,
          `Currently configured device: ${probe.getDeviceName()}`,
          `Device configured: ${probe.isDeviceConfigured() ? "Yes" : "NO - use set_device to configure"}`,
          "",
          "--- Scan Results ---",
          result.output || result.rawOutput || "(no output)",
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }
    );

    this.server.tool(
      "set_device",
      "Set the target device name at runtime. Required before any debugging commands will work. Examples: 'nRF52840_XXAA', 'nRF5340_xxAA_APP', 'STM32F407VG', 'STM32L476RG'.",
      {
        device: z.string().describe("Target device name (e.g., 'nRF52840_XXAA', 'STM32F407VG')"),
      },
      async ({ device }) => {
        probe.setDevice(device);
        return { content: [{ type: "text", text: `Device set to "${device}". You can now use all debugging tools.` }] };
      }
    );

    // ═══════════════════════════════════════════════════════════════
    // COMPOSITE / WORKFLOW TOOLS
    // ═══════════════════════════════════════════════════════════════

    this.server.tool(
      "start_debug_session",
      `One-call setup: starts GDB server via ${probe.displayName}, connects RTT (if supported), waits for initial output. This is the recommended first tool to call. If no device is configured, use list_devices and set_device first.`,
      {},
      async () => {
        const guard = this.requireDevice();
        if (guard) return guard;
        await this.ensureGdbSession();
        const steps: string[] = [];

        if (!probe.isGDBServerRunning()) {
          const gdbResult = await probe.startGDBServer();
          steps.push(gdbResult.success ? `GDB Server: started (${probe.displayName})` : `GDB Server: ${gdbResult.message}`);
          if (!gdbResult.success) return { content: [{ type: "text", text: steps.join("\n") }] };
          await sleep(2000);
        } else {
          steps.push("GDB Server: already running");
        }

        // The GDB server halts the core when it attaches. Leaving it that way
        // makes this tool stop the user's firmware and then report "No RTT
        // output yet" — which reads as RTT being broken rather than as the
        // target having been stopped by the very call meant to start observing
        // it. Resume before connecting RTT, and say so.
        //
        // Order matters as well as the act: the probe locates the RTT control
        // block by scanning RAM when RTT connects, and firmware that sets that
        // block up at boot must have reached that point first. Connect too
        // early and the scan finds nothing and is never retried.
        // Resume happens inside connectRttToRunningTarget below, which owns
        // the ordering both this tool and the flash restore path need.

        if (probe.supportsRTT() && !this.rttClient.isConnected()) {
          try {
            this.rttClient.clearBuffer(); // Clear stale buffers from previous sessions
            const { resumed: didResume } = await this.connectRttToRunningTarget();
            steps.push(didResume
              ? "Target: resumed (the GDB server halts the core when it attaches)"
              : "Target: could not resume — RTT may stay silent");
            probe.rttConnected = true;
            steps.push(`RTT: connected (port ${probe.getRTTPort()})`);
            await sleep(1500);
          } catch (err) {
            probe.rttConnected = false;
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
          steps.push(
            "\nNo RTT output yet. If the target logs over RTT: check it is running, and " +
            "note the probe locates the RTT control block by scanning RAM at connect time — " +
            "firmware that initialises that block at boot must have reached that point first."
          );
        }

        // What this session is missing, once, at the moment it starts. Only
        // the absent ones are listed; a fully configured session sees none of
        // this.
        const missing: string[] = [];
        if (this.svdMissing) missing.push("SVD — peripheral reads stay raw hex; set SVD_PATH");
        if (this.probe.getRttControlBlockAddress() === undefined && this.probe.supportsRTT()) {
          missing.push("JLINK_RTT_ADDR — RTT cannot be recovered after a reset or flash");
        }
        missing.push('ELF — backtraces show ??; gdb_load { elfFile: "..." }');
        steps.push(`\nNot loaded: ${missing.join(" · ")}`);

        return { content: [{ type: "text", text: steps.join("\n") }] };
      }
    );

    this.server.tool(
      "snapshot",
      "Capture complete device state: CPU registers (compact), fault status, recent RTT output, and stack dump.",
      { rttLines: z.number().min(0).max(200).optional().describe("RTT lines to include (default 30)") },
      async ({ rttLines }) => {
        const guard = this.requireDevice();
        if (guard) return guard;
        await this.ensureGdbSession();
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
        const guard = this.requireDevice();
        if (guard) return guard;
        await this.ensureGdbSession();
        const sections: string[] = ["## Crash Diagnosis"];

        // Halt before reading anything. A crashed target is usually spinning
        // in its fault handler, which a synchronous remote counts as running
        // — so every read gets refused and the diagnosis comes back empty,
        // decoding as "No faults detected" on a board that has plainly
        // crashed. Diagnosing a crash means stopping the CPU; that is not a
        // side effect to avoid, it is the prerequisite.
        const halted = await probe.halt();
        if (!halted.success) {
          sections.push(`(warning: could not halt the target — readings may be incomplete)`);
        }

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
        sections.push(`CFSR=0x${faultData.raw.cfsr.toString(16).padStart(8, "0")} HFSR=0x${faultData.raw.hfsr.toString(16).padStart(8, "0")} DFSR=0x${faultData.raw.dfsr.toString(16).padStart(8, "0")} MMFAR=0x${faultData.raw.mmfar.toString(16).padStart(8, "0")} BFAR=0x${faultData.raw.bfar.toString(16).padStart(8, "0")}`);
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
        const guard = this.requireDevice();
        if (guard) return guard;
        await this.ensureGdbSession();
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
        const g = this.requireDevice(); if (g) return g;
        await this.ensureGdbSession();
        const r = await probe.halt();
        return { content: [{ type: "text", text: r.success ? "CPU halted" : `Failed: ${r.output}` }] };
      }
    );

    this.server.tool("resume", "Resume the target CPU", {},
      async () => {
        const g = this.requireDevice(); if (g) return g;
        await this.ensureGdbSession();
        const r = await probe.resume();
        return { content: [{ type: "text", text: r.success ? "CPU resumed" : `Failed: ${r.output}` }] };
      }
    );

    this.server.tool("reset",
      "Reset the target device. Halting leaves the core stopped at the reset vector, " +
      "which is where you want it before flashing, or to watch startup run.",
      {
        halt: z.boolean().optional().describe("Halt at the reset vector after reset (default: false)"),
        strategy: z.number().optional().describe(
          "J-Link reset type. Omit to let J-Link pick the right one for the device, which is " +
          "what SEGGER recommends and is almost always correct. 0 = normal; 1 = core only, via " +
          "VECTRESET, leaving peripherals running; 2 = drive the reset pin, which fails if that " +
          "pin is not wired. See https://kb.segger.com/J-Link_Reset_Strategies"
        ),
      },
      async ({ halt, strategy }) => {
        const g = this.requireDevice(); if (g) return g;
        await this.ensureGdbSession();
        const r = await probe.reset(halt ?? false, strategy);
        // `r.output` is empty for a command the GDB client refused, so
        // reporting only that produced a bare "Failed: " with the reason
        // dropped. resultText falls back to the underlying error and its
        // suggested action.
        if (!r.success) {
          return { content: [{ type: "text", text: `Reset failed: ${JLinkMcpServer.resultText(r, "no reason reported")}` }] };
        }

        // A reset does not stop the target logging, but it does stop the probe
        // collecting — measured across a reset, the target's write pointer
        // advanced 582 -> 802 while the host's read pointer stayed at 0. Left
        // alone, every later rtt_read reports "No RTT output yet", which reads
        // exactly like a quiet target.
        let rttNote = "";
        if (probe.rttConnected) {
          const restarted = await probe.restartRTT();
          rttNote = restarted.ok ? " RTT collection restarted." : ` RTT: ${restarted.detail}`;
        }

        return { content: [{ type: "text", text:
          `Device reset${halt ? " (halted at the reset vector)" : " (running)"}.${rttNote}` }] };
      }
    );

    this.server.tool("step", "Step one CPU instruction",
      {},
      async () => {
        const g = this.requireDevice(); if (g) return g;
        await this.ensureGdbSession();
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
        const g = this.requireDevice(); if (g) return g;
        await this.ensureGdbSession();
        const addr = parseInt(address, 16);
        if (isNaN(addr)) return { content: [{ type: "text", text: "Error: invalid hex address" }] };
        const r = await probe.readMemory(addr, length);
        const dump = probe.parseMemoryDump(r.rawOutput);
        if (dump.length > 0) return { content: [{ type: "text", text: dump.map((d) => `${d.address}: ${d.hex}  ${d.ascii}`).join("\n") }] };
        return { content: [{ type: "text", text: JLinkMcpServer.resultText(r, "Could not read memory") }] };
      }
    );

    this.server.tool("write_memory", "Write a 32-bit value to memory",
      {
        address: z.string().describe("Hex address"),
        value: z.string().describe("Hex value (e.g., '0xDEADBEEF')"),
      },
      async ({ address, value }) => {
        const g = this.requireDevice(); if (g) return g;
        await this.ensureGdbSession();
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
        const g = this.requireDevice(); if (g) return g;
        await this.ensureGdbSession();
        const r = await probe.readAllRegisters();
        const regs = probe.parseRegisters(r.rawOutput);
        if (regs) return { content: [{ type: "text", text: probe.formatRegistersCompact(regs) }] };
        return { content: [{ type: "text", text: r.output }] };
      }
    );

    this.server.tool("read_register", "Read a specific CPU register by name",
      { register: z.string().describe("Register name (e.g., 'PC', 'SP', 'R0')") },
      async ({ register }) => {
        const g = this.requireDevice(); if (g) return g;
        await this.ensureGdbSession();
        const r = await probe.readRegister(register);
        return { content: [{ type: "text", text: JLinkMcpServer.resultText(r, "Could not read register") }] };
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
        const g = this.requireDevice(); if (g) return g;
        const addr = baseAddress ? parseInt(baseAddress, 16) : undefined;
        const text = await this.withGdbSessionRestored("flashing", async () => {
          const r = await probe.flash(filePath, addr);
          return { success: r.success, text: r.success ? `Flashed ${filePath}` : `Flash failed: ${JLinkMcpServer.resultText(r, "unknown error")}` };
        });
        return { content: [{ type: "text", text }] };
      }
    );

    this.server.tool("erase", "Erase target flash memory", {},
      async () => {
        const g = this.requireDevice(); if (g) return g;
        const text = await this.withGdbSessionRestored("erasing", async () => {
          const r = await probe.erase();
          return { success: r.success, text: r.success ? "Chip erased" : `Erase failed: ${JLinkMcpServer.resultText(r, "unknown error")}` };
        });
        return { content: [{ type: "text", text }] };
      }
    );

    // ═══════════════════════════════════════════════════════════════
    // PERIPHERALS (CMSIS-SVD)
    // ═══════════════════════════════════════════════════════════════

    this.server.tool("list_peripherals",
      "List the target's peripherals and base addresses, from its CMSIS-SVD description. Requires an SVD file to be configured.",
      { filter: z.string().optional().describe("Case-insensitive substring, e.g. 'uart' or 'timer'") },
      async ({ filter }) => {
        const why = this.svd.unavailableReason();
        if (why) return { content: [{ type: "text", text: why + this.hint("svd",
          "Set SVD_PATH (or jlinkMcp.svdPath) to a CMSIS-SVD file for this part to get named fields and decoded values.") }] };
        const list = this.svd.listPeripherals(filter);
        if (list.length === 0) {
          return { content: [{ type: "text", text: `No peripherals match ${JSON.stringify(filter)}.` }] };
        }
        const dev = this.svd.getDevice();
        const lines = list.map((p) =>
          `0x${p.baseAddress.toString(16).toUpperCase().padStart(8, "0")}  ${p.name.padEnd(16)} ${p.registers.length} registers` +
          (p.description ? `  — ${p.description.replace(/\s+/g, " ").slice(0, 60)}` : ""));
        return { content: [{ type: "text", text: `${dev?.name ?? "device"}: ${list.length} peripherals\n\n${lines.join("\n")}` }] };
      }
    );

    this.server.tool("read_peripheral",
      "Read every register of a peripheral from the target and decode each one's bit fields by name. This is read_memory plus the meaning of what was read.",
      {
        peripheral: z.string().describe("Peripheral name, e.g. 'FICR', 'UARTE0'"),
        registers: z.array(z.string()).optional().describe("Only these registers (default: all readable ones)"),
      },
      async ({ peripheral, registers }) => {
        const why = this.svd.unavailableReason();
        if (why) return { content: [{ type: "text", text: why + this.hint("svd",
          "Set SVD_PATH (or jlinkMcp.svdPath) to a CMSIS-SVD file for this part to get named fields and decoded values.") }] };
        const g = this.requireDevice(); if (g) return g;
        await this.ensureGdbSession();

        const p = this.svd.findPeripheral(peripheral);
        if (!p) {
          const near = this.svd.listPeripherals(peripheral).slice(0, 8).map((x) => x.name);
          return { content: [{ type: "text", text: `No peripheral named ${JSON.stringify(peripheral)}.` +
            (near.length ? ` Did you mean: ${near.join(", ")}?` : " Use list_peripherals.") }] };
        }

        // Write-only registers (Nordic's TASKS_*) read as garbage and would be
        // decoded into confident nonsense, so they are skipped rather than
        // reported. Reading every register of a large peripheral is also slow;
        // the `registers` argument exists for that.
        let chosen = p.registers.filter((r) => !/^write-only$/i.test(r.access ?? ""));
        if (registers?.length) {
          const want = new Set(registers.map((r) => r.toLowerCase()));
          chosen = chosen.filter((r) => want.has(r.name.toLowerCase()) || want.has(r.name.toLowerCase().split(".").pop()!));
        }
        if (chosen.length === 0) {
          return { content: [{ type: "text", text: `No readable registers matched in ${p.name}.` }] };
        }
        const MAX = 48;
        const truncated = chosen.length > MAX;
        chosen = chosen.slice(0, MAX);

        const out: string[] = [`${p.name} @ 0x${p.baseAddress.toString(16).toUpperCase().padStart(8, "0")}`];
        for (const reg of chosen) {
          const r = await probe.readMemory(reg.address, 4);
          const dump = probe.parseMemoryDump(r.rawOutput);
          const bytes = dump.flatMap((d) => d.hex.split(/\s+/)).filter(Boolean);
          if (bytes.length < 4) {
            out.push(`${reg.name}: could not read — ${JLinkMcpServer.resultText(r, "no data")}`);
            continue;
          }
          const value = parseLittleEndian32(bytes, 0);
          out.push(formatDecoded(reg, value, decodeValue(reg, value)));
        }
        if (truncated) out.push(`\n(showing first ${MAX} registers; pass \`registers\` to narrow)`);
        return { content: [{ type: "text", text: out.join("\n") }] };
      }
    );

    this.server.tool("decode_register",
      "Decode a value into named bit fields using the target's SVD. Reads from the device unless a value is supplied — useful for interpreting a number you already have.",
      {
        peripheral: z.string().describe("Peripheral name, e.g. 'UARTE0'"),
        register: z.string().describe("Register name, e.g. 'ENABLE' or 'INFO.PART'"),
        value: z.string().optional().describe("Hex value to decode instead of reading the device"),
      },
      async ({ peripheral, register, value }) => {
        const why = this.svd.unavailableReason();
        if (why) return { content: [{ type: "text", text: why + this.hint("svd",
          "Set SVD_PATH (or jlinkMcp.svdPath) to a CMSIS-SVD file for this part to get named fields and decoded values.") }] };

        const reg = this.svd.findRegister(peripheral, register);
        if (!reg) {
          const near = this.svd.suggestRegisters(peripheral, register);
          return { content: [{ type: "text", text: `${peripheral} has no register ${JSON.stringify(register)}.` +
            (near.length ? ` Did you mean: ${near.join(", ")}?` : "") }] };
        }

        let v: number;
        if (value !== undefined) {
          const parsed = parseInt(value.replace(/^0x/i, ""), 16);
          if (isNaN(parsed)) return { content: [{ type: "text", text: `Not a hex value: ${value}` }] };
          v = parsed >>> 0;
        } else {
          const g = this.requireDevice(); if (g) return g;
          await this.ensureGdbSession();
          const r = await probe.readMemory(reg.address, 4);
          const bytes = probe.parseMemoryDump(r.rawOutput).flatMap((d) => d.hex.split(/\s+/)).filter(Boolean);
          if (bytes.length < 4) {
            return { content: [{ type: "text", text: `Could not read ${reg.name}: ${JLinkMcpServer.resultText(r, "no data")}` }] };
          }
          v = parseLittleEndian32(bytes, 0);
        }
        const text = formatDecoded(reg, v, decodeValue(reg, v)) +
          (reg.description ? `\n\n${reg.description.replace(/\s+/g, " ")}` : "");
        return { content: [{ type: "text", text }] };
      }
    );

    // ═══════════════════════════════════════════════════════════════
    // BREAKPOINTS
    // ═══════════════════════════════════════════════════════════════

    this.server.tool("set_breakpoint", "Set a hardware breakpoint",
      { address: z.string().describe("Hex address") },
      async ({ address }) => {
        const addr = parseInt(address, 16);
        const g = this.requireDevice(); if (g) return g;
        await this.ensureGdbSession();
        const r = await probe.setBreakpoint(addr);
        return { content: [{ type: "text", text: r.success ? `Breakpoint set at 0x${addr.toString(16)}` : `Failed: ${r.output}` }] };
      }
    );

    this.server.tool("clear_breakpoints",
      "Clear all breakpoints, including any left armed in the debug hardware by an earlier session",
      {},
      async () => {
        const g = this.requireDevice(); if (g) return g;
        await this.ensureGdbSession();
        // Clearing the debugger's own list is not enough. A comparator armed
        // by a session that has since exited is invisible to `delete`, stays
        // armed across reset and reflash, and traps whatever the current image
        // happens to put at that address. Observed here: a comparator armed
        // against one fixture's spin loop kept trapping a completely different
        // firmware that reused the address.
        //
        // So "clear all breakpoints" clears the hardware too, which is what
        // the name promises.
        await probe.clearBreakpoints();
        const disarm = await probe.disarmDebugState();
        return { content: [{ type: "text", text: disarm.ok
          ? "Breakpoints cleared (debug comparators disarmed)"
          : `Breakpoints cleared, but ${disarm.detail}` }] };
      }
    );

    // ═══════════════════════════════════════════════════════════════
    // GDB SERVER
    // ═══════════════════════════════════════════════════════════════

    this.server.tool("gdb_server_start", `Start ${probe.displayName} GDB server`, {},
      async () => { const g = this.requireDevice(); if (g) return g;
        await this.ensureGdbSession(); const r = await probe.startGDBServer(); return { content: [{ type: "text", text: r.message }] }; }
    );

    this.server.tool("gdb_server_stop", `Stop ${probe.displayName} GDB server and disconnect RTT`, {},
      async () => {
        const cleared = this.gdb.isConnected() ? await this.clearDebugState() : "";
        this.rttClient.disconnect();
        probe.rttConnected = false;
        const r = probe.stopGDBServer();
        return { content: [{ type: "text", text: `${r.message}${cleared}` }] };
      }
    );

    this.server.tool("gdb_server_status", "Get GDB server, RTT, and telnet proxy status", {},
      async () => {
        const status = { probeState: probe.getStatus(), rtt: this.rttClient.getStats(), telnetProxy: this.telnetProxy.getStatus() };
        return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
      }
    );

    // ═══════════════════════════════════════════════════════════════
    // GDB (source-level debugging)
    // ═══════════════════════════════════════════════════════════════

    this.server.tool(
      "gdb_connect",
      "Connect a GDB client to the running GDB server. Enables source-level debugging: backtraces, variable inspection, conditional breakpoints, stepping by source line. Optionally load an ELF file for symbol info.",
      {
        elfFile: z.string().optional().describe("Path to .elf file with debug symbols (enables source-level debugging)"),
        host: z.string().optional().describe("GDB server host (default: localhost)"),
        port: z.number().optional().describe("GDB server port (default: 2331)"),
      },
      async ({ elfFile, host, port }) => {
        // Auto-start GDB server if not running
        if (!probe.isGDBServerRunning()) {
          const g = this.requireDevice(); if (g) return g;
        await this.ensureGdbSession();
          const startResult = await probe.startGDBServer();
          if (!startResult.success) return { content: [{ type: "text", text: `Failed to start GDB server: ${startResult.message}` }] };
          await sleep(2000); // Wait for server to bind port
        }
        const gdbPort = port ?? probe.getGDBServerStatus().gdbPort;
        const result = await this.gdb.connect(host ?? "localhost", gdbPort, elfFile);
        return { content: [{ type: "text", text: result.success ? result.output : `Failed: ${result.error || result.output}` }] };
      }
    );

    this.server.tool(
      "gdb_command",
      "Send any GDB command and get the response. For execution commands (continue, step, next, finish, until), blocks until the target stops or times out. If the target doesn't stop, use gdb_wait to poll. Examples: 'bt' (backtrace), 'info threads', 'print myVar', 'break main', 'continue', 'next', 'step', 'finish', 'info registers', 'x/10xw 0x20000000'",
      {
        command: z.string().describe("GDB command to execute"),
        timeout: z.number().optional().describe("Timeout in ms for run commands (default 15000)"),
      },
      async ({ command, timeout }) => {
        // Don't early-return if disconnected — gdb.command() will auto-reconnect
        const result = await this.gdb.command(command, timeout ?? 15000);
        let text = result.output;
        if (result.stopReason && result.stopReason !== "running") {
          text += `\n\nStopped: ${result.stopReason}`;
        }
        if (result.error) text += `\nError: ${result.error}`;
        return { content: [{ type: "text", text: text || "(no output)" }] };
      }
    );

    this.server.tool(
      "gdb_wait",
      "Poll for target stop after a continue/step that timed out. Returns the stop reason (breakpoint hit, signal, finished stepping, etc.) when the target halts.",
      {
        timeout: z.number().optional().describe("How long to wait in ms (default 30000)"),
      },
      async ({ timeout }) => {
        if (!this.gdb.isConnected()) {
          return { content: [{ type: "text", text: "GDB not connected" }] };
        }
        const result = await this.gdb.wait(timeout ?? 30000);
        return { content: [{ type: "text", text: result.stopReason === "running" ? "Target still running" : `${result.output}` }] };
      }
    );

    this.server.tool(
      "gdb_load",
      "Load an ELF file into GDB. By default loads symbols only (for source-level debugging: backtraces with file:line, variable names). Set flash=true to also program it onto the target.",
      {
        elfFile: z.string().describe("Path to .elf file with debug symbols"),
        flash: z.boolean().optional().describe("Also flash the ELF to the target (default: false, symbols only)"),
      },
      async ({ elfFile, flash }) => {
        const loadSymbols = await this.gdb.loadSymbols(elfFile);

        // Announcing "Symbols loaded" for a load that did not happen is the
        // worst possible answer here: the caller stops trying, and every
        // later backtrace comes back anonymous for a reason it has been told
        // is already solved. Seen on hardware, reported as `Symbols loaded: `
        // with nothing after the colon.
        if (!loadSymbols.success) {
          return { content: [{ type: "text", text:
            `Symbols NOT loaded: ${JLinkMcpServer.resultText(loadSymbols, "no reason reported")}` }] };
        }

        if (!flash) {
          return { content: [{ type: "text", text: `Symbols loaded: ${loadSymbols.output}\n\nBacktraces and variable inspection will now show source file:line info. Use flash=true to also program the target.` }] };
        }
        const loadFlash = await this.gdb.command("load", 60000);
        return { content: [{ type: "text", text: `Symbols: ${loadSymbols.output}\nFlash: ${loadFlash.output}` }] };
      }
    );

    this.server.tool(
      "gdb_backtrace",
      "Get a stack backtrace. With debug symbols loaded, shows function names, file paths, and line numbers.",
      {
        full: z.boolean().optional().describe("Include local variables in each frame (default false)"),
      },
      async ({ full }) => {
        const result = await this.gdb.backtrace(full ?? false);
        const text = JLinkMcpServer.resultText(result, "(no backtrace available)");

        // Read the frames rather than tracking whether gdb_load was called:
        // symbols loaded from a stale ELF still leave `??`, and the frames are
        // what the caller is actually looking at.
        const unresolved = /\?\?/.test(text);
        return { content: [{ type: "text", text: text + (unresolved
          ? this.hint("elf", 'No symbols: gdb_load { elfFile: "..." } for names and file:line.', true)
          : "") }] };
      }
    );

    this.server.tool(
      "gdb_disconnect",
      "Disconnect the GDB client (does not stop the GDB server)",
      {},
      async () => {
        // Clear breakpoints first. Debug resources — FPB comparators, vector
        // catches — are not cleared by the reset a probe issues, so a session
        // that just walks away leaves them armed. The target then takes a
        // debug event with no debugger attached, which escalates straight to
        // HardFault: observed on hardware as a board that ran fine until it
        // had once been debugged, then HardFaulted three instructions into
        // reset with CFSR clear and HFSR.DEBUGEVT set.
        const cleared = this.gdb.isConnected() ? await this.clearDebugState() : "";
        this.gdb.disconnect();
        return { content: [{ type: "text", text: `GDB client disconnected${cleared}` }] };
      }
    );

    // ═══════════════════════════════════════════════════════════════
    // RTT
    // ═══════════════════════════════════════════════════════════════

    this.server.tool("rtt_connect", `Connect to RTT${probe.supportsRTT() ? "" : " (not supported by " + probe.displayName + ")"}`, {},
      async () => {
        if (!probe.supportsRTT()) return { content: [{ type: "text", text: `RTT is not supported by ${probe.displayName}` }] };
        if (!probe.isGDBServerRunning()) return { content: [{ type: "text", text: "GDB server must be running for RTT. Use start_debug_session or gdb_server_start first." }] };
        try {
          this.rttClient.clearBuffer();
          await this.rttClient.connect();
          probe.rttConnected = true;
          return { content: [{ type: "text", text: "Connected to RTT" }] };
        }
        catch (err) { probe.rttConnected = false; return { content: [{ type: "text", text: `Failed: ${err instanceof Error ? err.message : String(err)}` }] }; }
      }
    );

    this.server.tool("rtt_disconnect", "Disconnect from RTT", {},
      async () => { this.rttClient.disconnect(); probe.rttConnected = false; return { content: [{ type: "text", text: "Disconnected from RTT" }] }; }
    );

    this.server.tool("rtt_read", "Read recent RTT log lines (clean, parsed Zephyr format)",
      { count: z.number().min(1).max(500).optional().describe("Lines to read (default 50)") },
      async ({ count }) => {
        if (!this.rttClient.isConnected()) return { content: [{ type: "text", text: "RTT not connected. Use start_debug_session first." }] };
        const lines = this.rttClient.getLines(count ?? 50);
        return { content: [{ type: "text", text: lines.length > 0
          ? lines.join("\n")
          : "No RTT output yet." + this.rttEmptyHint() }] };
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
        if (results.length === 0) return { content: [{ type: "text", text: "No matches found" + this.rttEmptyHint() }] };
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

    this.server.tool("telnet_proxy_start",
      "Start a TCP relay that re-serves the RTT stream on another port, so an external decoder (Trice, Pigweed, or your own) can consume it alongside this server. It relays bytes; it does not decode them.",
      {},
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
        const g = this.requireDevice(); if (g) return g;
        await this.ensureGdbSession();
        const r = await probe.executeRaw(commands);
        return { content: [{ type: "text", text: JLinkMcpServer.resultText(r, "(no output)") }] };
      }
    );

    this.server.tool("get_config", "Get current probe and server configuration", {},
      async () => {
        // The configured target device belongs here: this is the tool an LLM
        // calls to ask "what am I pointed at?", and without it `set_device`
        // has no observable effect through the config surface at all.
        return { content: [{ type: "text", text: JSON.stringify({
          probe: probe.type,
          displayName: probe.displayName,
          device: probe.getDeviceName(),
          deviceConfigured: probe.isDeviceConfigured(),
          supportsRTT: probe.supportsRTT(),
          gdbServer: probe.getGDBServerStatus(),
        }, null, 2) }] };
      }
    );
  }

  /**
   * Render a probe/GDB result as text, preferring the most specific thing we
   * have: parsed output, then raw output, then the error the layer below
   * produced, and only then a generic fallback.
   *
   * The layer below often knows exactly what went wrong — "Target is running;
   * GDB cannot accept commands until it stops" — and dropping that in favour
   * of "Could not read memory" hands the caller a dead end. Observed on
   * hardware: reading during a run returned the generic string while the
   * client had produced an actionable one.
   */
  /**
   * Capability hints already emitted this session.
   *
   * A hint is worth roughly twenty tokens. Repeating one every call is how a
   * helpful line turns into noise that crowds out the output it was meant to
   * annotate, so most fire once and then stay quiet.
   */
  private readonly hintsShown = new Set<string>();

  /**
   * A short note about something the session is missing, attached to the
   * result that is worse for missing it.
   *
   * Deliberately at the point of degradation rather than in a preamble: a
   * model reads the output of the call it just made, and may never read a
   * banner from three calls ago. Two failure modes reported from real use —
   * never loading the ELF, and never supplying an SVD — are both invisible
   * unless the disappointing answer says what would have made it better.
   *
   * `repeat` is for the ELF hint alone. If a caller is still getting
   * unresolved frames on its fourth backtrace, saying so again is the entire
   * point; the others are advice, and advice ignored once is ignored.
   */
  private hint(key: string, text: string, repeat = false): string {
    if (!repeat && this.hintsShown.has(key)) return "";
    this.hintsShown.add(key);
    return `\n\n${text}`;
  }

  /**
   * Note for an RTT read that came back empty, when the control block address
   * is unknown.
   *
   * Silence has two causes that look identical from here: a quiet device, and
   * a probe that stopped collecting. The second happens at every reset and
   * flash, and cannot be recovered without the address — which J-Link finds by
   * scanning RAM and never reports back. So an empty read is the moment to
   * mention it.
   */
  private rttEmptyHint(): string {
    if (this.probe.getRttControlBlockAddress() !== undefined) return "";
    return this.hint("rtt-addr",
      "RTT empty. If it stopped after a reset or flash, set JLINK_RTT_ADDR to your _SEGGER_RTT symbol so it can be recovered.");
  }

  /** True when no SVD is loaded, so peripheral reads cannot be decoded. */
  private get svdMissing(): boolean {
    return !!this.svd.unavailableReason();
  }

  private static resultText(
    r: { success?: boolean; output?: string; rawOutput?: string; error?: string; suggestedAction?: string },
    fallback: string
  ): string {
    // For a failure the reason outranks the output. A failing reset carried a
    // careful explanation in `error` and the raw text `@"Resetting target"` in
    // `rawOutput` — and reporting the output meant the reply said the target
    // had been reset while the result said it had not.
    const reason = [r.error, r.suggestedAction].filter((x) => x && x.trim()).join(" ");
    if (r.success === false && reason) return reason;

    if (r.output?.trim()) return r.output;
    if (r.rawOutput?.trim()) return r.rawOutput;
    if (reason) return reason;
    return fallback;
  }

  /**
   * Drop every breakpoint before a session ends.
   *
   * Best-effort and never fatal: failing to tidy up must not stop the caller
   * disconnecting. Returns a note to append to the tool's reply so the action
   * is visible rather than silent.
   */
  private async clearDebugState(): Promise<string> {
    const notes: string[] = [];

    // `delete breakpoints` is a command like any other, and a synchronous
    // remote will not read one while the target runs. Halting is not optional
    // here — it is what makes the rest of this function do anything at all.
    await this.probe.halt();

    try {
      const r = await this.probe.clearBreakpoints();
      notes.push(r.success ? "breakpoints cleared" : "WARNING: could not clear breakpoints");
    } catch {
      notes.push("WARNING: could not clear breakpoints");
    }

    // Zero the FPB comparators directly as well. Clearing breakpoints through
    // the debugger only removes the ones it knows about — a session that died
    // abruptly, or one whose breakpoints were set by other means, leaves
    // comparators armed that no `delete` will reach. Those are what turn a
    // healthy board into one that HardFaults three instructions into reset,
    // and a probe-issued reset does not clear them.
    try {
      const d = await this.probe.disarmDebugState();
      notes.push(d.ok ? "debug hardware disarmed" : `WARNING: ${d.detail}`);
    } catch {
      notes.push("WARNING: could not disarm debug hardware");
    }
    return ` (${notes.join("; ")})`;
  }

  /**
   * Run a probe-CLI operation that needs exclusive access to the probe, and
   * put any live GDB session back afterwards.
   *
   * flash and erase must spawn JLinkExe — GDB has no equivalent for writing a
   * .hex — and a J-Link serves one client at a time. Doing that alongside a
   * running GDB server evicts the server: the child GDB stays alive attached
   * to a dead socket, and the caller only finds out when their next command
   * fails for reasons that look nothing like "your flash did this".
   *
   * So take the session down deliberately, do the work, and bring it back.
   * Every step is reported: silently losing a debug session is the bug, and
   * silently restoring one would only be a quieter version of the same
   * problem. If the restore fails the caller is told exactly what state they
   * are in rather than left to discover it.
   */
  private async withGdbSessionRestored(
    label: string,
    fn: () => Promise<{ success: boolean; text: string }>
  ): Promise<string> {
    const probe = this.probe;
    const hadServer = probe.isGDBServerRunning();
    const hadClient = this.gdb.isConnected();
    const hadRtt = probe.rttConnected;
    const notes: string[] = [];

    if (hadServer || hadClient) {
      notes.push(`Stopped the GDB session for ${label} (a probe serves one client at a time).`);
      if (hadClient) this.gdb.disconnect();
      if (hadRtt) { this.rttClient.disconnect(); probe.rttConnected = false; }
      if (hadServer) probe.stopGDBServer();
      await sleep(500);
    }

    const result = await fn();

    if (!hadServer && !hadClient) return result.text;

    const restored: string[] = [];
    const failed: string[] = [];
    if (hadServer) {
      const r = await probe.startGDBServer();
      if (r.success) { restored.push("GDB server"); await sleep(2000); }
      else failed.push(`GDB server (${r.message})`);
    }
    if (hadClient && !failed.length) {
      const r = await this.gdb.connect("localhost", probe.getGDBServerStatus().gdbPort);
      if (r.success) restored.push("GDB client");
      else failed.push(`GDB client (${r.error || r.output})`);
    }
    if (!hadRtt) {
      // Say it. RTT not being restored is invisible otherwise — the reply reads
      // "Restored: GDB server, GDB client." and a caller has no way to tell
      // whether RTT was deliberately absent or quietly dropped.
      notes.push("RTT was not connected before this, so it was not restored.");
    }
    if (hadRtt && !failed.length) {
      // Resume before reconnecting. The server just halted the core on attach,
      // and RTT connected to a halted target finds no control block and stays
      // silent — which after a flash reads as "flashing broke RTT".
      try {
        const { note } = await this.connectRttToRunningTarget();
        restored.push(`RTT${note}`);
      } catch (e: any) { failed.push(`RTT (${e?.message ?? e})`); }
    }

    if (restored.length) notes.push(`Restored: ${restored.join(", ")}.`);
    if (failed.length) {
      notes.push(`COULD NOT RESTORE: ${failed.join("; ")}. Reconnect with gdb_connect before debugging further.`);
    }
    return [result.text, ...notes].join("\n");
  }

  /**
   * Attach our GDB client when the server is running without one.
   *
   * The J-Link GDB Server halts the core on attach and holds it, and it also
   * hosts the RTT telnet port — so anything using RTT needs the server up.
   * But CPU-control routing keys off whether a *client* is connected, so a
   * server with no client is the one configuration where every halt, reset,
   * step and read spawns a competing JLinkExe and evicts the server. RTT dies
   * with it, and the target is left halted with nothing driving it.
   *
   * That is reachable from the documented happy path: start_debug_session
   * brings up the server and RTT, and the next reset kills the stream.
   *
   * Connecting a client puts everything back on one channel. The alternative
   * — bracketing each call with a server stop and restart, as flash does —
   * would drop the RTT stream on every single control operation, which is a
   * worse answer to the same question.
   */
  private async ensureGdbSession(): Promise<void> {
    if (!this.probe.isGDBServerRunning()) return;
    if (this.gdb.isConnected()) return;
    try {
      await this.gdb.connect("localhost", this.probe.getGDBServerStatus().gdbPort);
    } catch {
      // Best-effort. If it fails the caller still gets the JLinkExe path,
      // which is the behaviour they had before.
    }
  }

  /**
   * Connect RTT to a target that is actually executing.
   *
   * Two things have to be true before RTT produces anything, and both are
   * easy to get wrong independently:
   *
   *  - The core must be running. The GDB server halts it on attach and holds
   *    it, so anything that brings the server up has stopped the firmware.
   *  - The firmware must have reached the point where it builds its RTT
   *    control block. The probe finds that block by scanning RAM when RTT
   *    connects, and does not retry — connect too early and RTT is silent
   *    forever, with no error anywhere.
   *
   * The failure is silent in both directions: the up channel produces nothing
   * and the down channel swallows commands, so it reads as "RTT is broken"
   * rather than "the target was not running yet". This has now been fixed
   * twice in two different call sites; it lives in one place so there is not
   * a third.
   */
  private async connectRttToRunningTarget(): Promise<{ resumed: boolean; note: string }> {
    const resumed = await this.probe.resume();
    // Give the firmware time to reach its RTT init before the scan happens.
    await sleep(500);
    await this.rttClient.connect();
    this.probe.rttConnected = true;

    // Connecting our telnet client is not the same as the probe collecting.
    // J-Link scans for the control block once, at its own moment, and after a
    // flash — which resets the target — that scan can land while the firmware
    // has not yet initialised the block. Nothing retries it. Measured after a
    // flash: the firmware had written 490 bytes and the probe had collected
    // none of them, so every read said "No RTT output yet" while the device
    // was talking the whole time.
    //
    // Pointing it at a known address is not a retry of the scan; it replaces
    // it. Best-effort, and silent when no address is configured, because the
    // stream may well be fine — the scan usually does land.
    // Needs a GDB client, since the restart has to travel to the GDB server
    // that owns the RTT port rather than to a JLinkExe of our own.
    await this.ensureGdbSession();
    await this.probe.restartRTT();

    return {
      resumed: resumed.success,
      note: resumed.success ? "" : " (warning: could not resume the target, so RTT may stay silent)",
    };
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

## IMPORTANT: Device setup
If no device is configured, you MUST do this first:
1. Call **list_devices** to scan for connected probes
2. Call **set_device** with the target name (e.g., "nRF52840_XXAA", "STM32F407VG", "STM32L073RZ")
Then call **start_debug_session** to begin.

## Key tools:
- **list_devices** - Scan for connected probes (always works, even without device set)
- **set_device** - Set target device name (REQUIRED before debugging)
- **start_debug_session** - One-call setup: GDB server + RTT + boot log
- **snapshot** - Full device state in one call
- **diagnose_crash** - Auto-decode fault registers
- **gdb_connect** / **gdb_command** - Full GDB debugging (source-level with .elf symbols)
- **gdb_load** - Load .elf for symbols (set flash=true to also program)
- **rtt_read** / **rtt_search** - Device logs (${this.probe.supportsRTT() ? "supported" : "not supported by " + probeName})
- **read_memory** / **read_registers** - Inspect device state
- halt/resume/reset/step - CPU control
- flash/erase - Firmware programming

## ARM Cortex-M memory map:
- 0x00000000: Vector table
- 0x20000000: SRAM
- 0xE000ED28: CFSR (fault status)

Start by checking list_devices, then set_device, then start_debug_session.` }}],
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
    this.gdb.disconnect();
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
