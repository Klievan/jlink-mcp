/**
 * ProbeBackend is the abstraction layer for debug probes.
 * Each probe type (J-Link, OpenOCD, Black Magic Probe, probe-rs)
 * implements this interface. The MCP server calls only these methods.
 */

import { log } from "../utils/logger";

// ══════════════════════════════════════════════════════════════════════
// State machine
// ══════════════════════════════════════════════════════════════════════

export enum ProbeState {
  DISCONNECTED = "disconnected",
  PROBE_CONNECTED = "probe_connected",
  TARGET_ATTACHED = "target_attached",
  GDB_RUNNING = "gdb_running",
}

/** Structured error codes returned by probe operations */
export enum ProbeErrorCode {
  PROBE_NOT_FOUND = "PROBE_NOT_FOUND",
  TARGET_UNREACHABLE = "TARGET_UNREACHABLE",
  ATTACH_FAILED = "ATTACH_FAILED",
  ATTACH_UNDER_RESET_FAILED = "ATTACH_UNDER_RESET_FAILED",
  STATE_DESYNC = "STATE_DESYNC",
  DEVICE_NOT_CONFIGURED = "DEVICE_NOT_CONFIGURED",
  GDB_SERVER_FAILED = "GDB_SERVER_FAILED",
  RTT_NOT_AVAILABLE = "RTT_NOT_AVAILABLE",
  TIMEOUT = "TIMEOUT",
  PROBE_BUSY = "PROBE_BUSY",
}

export interface CommandResult {
  success: boolean;
  /** Raw output from the probe tool */
  rawOutput: string;
  /** Cleaned output (boilerplate stripped) */
  output: string;
  error?: string;
  /** Structured error code for programmatic handling */
  errorCode?: ProbeErrorCode;
  /** What stage succeeded before failure */
  lastSuccessfulStage?: string;
  /** Suggested recovery action */
  suggestedAction?: string;
}

export interface MemoryDumpLine {
  address: string;
  hex: string;
  ascii: string;
}

export interface GDBServerInfo {
  running: boolean;
  gdbPort: number;
  /** Port for RTT telnet access (J-Link specific, -1 if not supported) */
  rttTelnetPort: number;
  rttControlBlockAddress?: number;
}

export interface ProbeStatus {
  state: ProbeState;
  probeType: ProbeType;
  deviceConfigured: boolean;
  deviceName: string;
  gdbServer: GDBServerInfo;
  rttConnected: boolean;
}

export type ProbeType = "jlink" | "openocd" | "blackmagic" | "probe-rs";

/**
 * Minimal surface a backend needs to route CPU-control and read commands
 * through a running GDB session instead of spawning its own probe-CLI
 * process. Implemented by `GDBClient`; injected by the MCP server via
 * `ProbeBackend.setGdbBridge()`.
 *
 * Kept intentionally small so backends don't depend on the concrete
 * GDB client class.
 */
export interface GdbBridge {
  isConnected(): boolean;
  command(cmd: string, timeout?: number): Promise<{
    success: boolean;
    output: string;
    error?: string;
    stopReason?: string;
  }>;
  /**
   * Stop a running target out-of-band.
   *
   * Separate from `command` because it cannot go through the command channel:
   * with a synchronous remote, GDB blocks while the target runs and stops
   * reading stdin entirely, so a halt typed as a command is never seen.
   * Optional so alternative bridges need not implement it.
   */
  interrupt?(timeout?: number): Promise<{
    success: boolean;
    output: string;
    error?: string;
    stopReason?: string;
  }>;
}

/**
 * Abstract base for all debug probe backends.
 * Implementations only need to override the abstract methods.
 * Shared utilities (register parsing, fault decoding, memory parsing)
 * are provided by the base class.
 */
export abstract class ProbeBackend {
  abstract readonly type: ProbeType;
  abstract readonly displayName: string;

  // ── State machine ────────────────────────────────────────────────

  protected _state: ProbeState = ProbeState.DISCONNECTED;
  private _rttConnected = false;
  private _lock: Promise<void> = Promise.resolve();
  /**
   * Optional GDB session the backend can route commands through. Injected
   * by the MCP server after both objects are constructed. When present
   * and connected, backends should prefer this over spawning a competing
   * probe-CLI process, since the underlying probe can only serve one
   * session at a time.
   */
  protected gdbBridge?: GdbBridge;

  get state(): ProbeState { return this._state; }

  get rttConnected(): boolean { return this._rttConnected; }
  set rttConnected(v: boolean) {
    // RTT can only be connected if GDB server is running.
    //
    // This refusal is silent, and silence is why it is worth logging. The flag
    // is what decides whether a flash restores RTT afterwards, so a discarded
    // `= true` turns into "Restored: GDB server, GDB client." with RTT missing
    // and nothing saying why — which is what S7 shows, three runs running,
    // while two fixes aimed elsewhere changed nothing.
    if (v && this._state !== ProbeState.GDB_RUNNING) {
      log(`[probe] refusing rttConnected = true: state is ${this._state}, not ${ProbeState.GDB_RUNNING}`);
      this._rttConnected = false;
      return;
    }
    this._rttConnected = v;
  }

  /** Transition state with validation */
  protected setState(newState: ProbeState): void {
    this._state = newState;
    // If we lose target attach, RTT is invalid.
    if (newState === ProbeState.DISCONNECTED || newState === ProbeState.PROBE_CONNECTED) {
      if (this._rttConnected) log(`[probe] clearing rttConnected: state -> ${newState}`);
      this._rttConnected = false;
    }
  }

  getStatus(): ProbeStatus {
    return {
      state: this._state,
      probeType: this.type,
      deviceConfigured: this.isDeviceConfigured(),
      deviceName: this.getDeviceName(),
      gdbServer: this.getGDBServerStatus(),
      rttConnected: this._rttConnected,
    };
  }

  /**
   * Acquire exclusive access to the probe. Prevents concurrent commands
   * from racing the same J-Link session.
   */
  protected async acquireLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this._lock;
    let releaseFn: () => void;
    this._lock = new Promise<void>((resolve) => { releaseFn = resolve; });
    await prev;
    try {
      return await fn();
    } finally {
      releaseFn!();
    }
  }

  /**
   * Preflight check: verify target is reachable by reading DHCSR.
   * Returns null if OK, or an error CommandResult if unreachable.
   * Subclasses can override for probe-specific preflight.
   */
  async preflight(): Promise<CommandResult | null> {
    // Read Debug Halting Control and Status Register
    const result = await this.readMemory(0xE000EDF0, 4);
    if (!result.success) {
      return {
        success: false,
        rawOutput: result.rawOutput,
        output: "Preflight failed: cannot read DHCSR (0xE000EDF0). Target may be unreachable.",
        error: result.error,
        errorCode: ProbeErrorCode.TARGET_UNREACHABLE,
        lastSuccessfulStage: "probe_connected",
        suggestedAction: "Try reset({halt: true}) or use the recovery tool. Check SWD/JTAG wiring.",
      };
    }
    this.setState(ProbeState.TARGET_ATTACHED);
    return null;
  }

  /**
   * Run a command with preflight validation and auto-recovery.
   * Wraps the command in a lock to prevent concurrent access.
   */
  async withPreflight(
    operation: string,
    fn: () => Promise<CommandResult>,
    skipPreflight = false
  ): Promise<CommandResult> {
    return this.acquireLock(async () => {
      if (!skipPreflight && this.isDeviceConfigured()) {
        const check = await this.preflight();
        if (check) {
          // Try recovery once
          const recovered = await this.recover();
          if (!recovered) {
            return {
              ...check,
              lastSuccessfulStage: "recovery_attempted",
              suggestedAction: `Recovery failed. Try: 1) reset with halt, 2) power cycle the target, 3) check SWD wiring. Operation was: ${operation}`,
            };
          }
        }
      }

      const result = await fn();

      // Update state based on result
      if (result.success && this._state === ProbeState.DISCONNECTED) {
        this.setState(ProbeState.TARGET_ATTACHED);
      }
      if (!result.success && result.rawOutput) {
        // Detect common failure patterns and classify
        const raw = result.rawOutput.toLowerCase();
        if (raw.includes("cannot connect") || raw.includes("inittarget() returned error") || raw.includes("could not connect")) {
          result.errorCode = result.errorCode || ProbeErrorCode.TARGET_UNREACHABLE;
          result.suggestedAction = result.suggestedAction || "Target unreachable. Try: reset with halt, reduce SWD speed, or power cycle.";
          this.setState(ProbeState.PROBE_CONNECTED);
        }
        if (raw.includes("failed to open dll") || raw.includes("no j-link found") || raw.includes("could not find")) {
          result.errorCode = result.errorCode || ProbeErrorCode.PROBE_NOT_FOUND;
          result.suggestedAction = result.suggestedAction || "No probe found. Check USB connection.";
          this.setState(ProbeState.DISCONNECTED);
        }
      }

      return result;
    });
  }

  /**
   * Recovery sequence. Subclasses should override to implement
   * probe-specific recovery (restart server, reconnect under reset, etc.)
   * Returns true if recovery succeeded.
   */
  async recover(): Promise<boolean> {
    return false;
  }

  /** Inject a GDB session for command routing. See {@link GdbBridge}. */
  setGdbBridge(bridge: GdbBridge | undefined): void {
    this.gdbBridge = bridge;
  }

  // ── Device control ───────────────────────────────────────────────

  abstract getDeviceInfo(): Promise<CommandResult>;
  abstract halt(): Promise<CommandResult>;
  abstract resume(): Promise<CommandResult>;
  /**
   * Reset the target, optionally leaving it stopped at the reset vector.
   *
   * `strategy` is a probe-specific reset type. Omitting it — letting the probe
   * choose — is the right default nearly always. A backend that cannot honour
   * an explicit strategy must fail rather than reset by some other means: a
   * caller who names a strategy has a reason, and quietly substituting another
   * is how a reset comes back "successful" having done something else.
   */
  abstract reset(halt?: boolean, strategy?: number): Promise<CommandResult>;
  abstract step(): Promise<CommandResult>;

  // ── Memory ───────────────────────────────────────────────────────

  abstract readMemory(address: number, length: number): Promise<CommandResult>;
  abstract writeMemory(address: number, value: number): Promise<CommandResult>;

  // ── Registers ────────────────────────────────────────────────────

  abstract readAllRegisters(): Promise<CommandResult>;
  abstract readRegister(name: string): Promise<CommandResult>;

  // ── Flash ────────────────────────────────────────────────────────

  abstract flash(filePath: string, baseAddress?: number): Promise<CommandResult>;
  abstract erase(): Promise<CommandResult>;

  // ── Breakpoints ──────────────────────────────────────────────────

  abstract setBreakpoint(address: number): Promise<CommandResult>;
  abstract clearBreakpoints(): Promise<CommandResult>;

  // ── GDB Server ───────────────────────────────────────────────────

  abstract startGDBServer(): Promise<{ success: boolean; message: string }>;
  abstract stopGDBServer(): { success: boolean; message: string };
  abstract isGDBServerRunning(): boolean;
  abstract getGDBServerStatus(): GDBServerInfo;
  abstract getGDBServerOutput(lines?: number): string[];

  // ── Raw commands ─────────────────────────────────────────────────

  abstract executeRaw(commands: string[]): Promise<CommandResult>;

  // ── Device configuration ──────────────────────────────────────────

  /** Whether a target device has been configured */
  abstract isDeviceConfigured(): boolean;

  /** Get the currently configured device name */
  abstract getDeviceName(): string;

  /** Set the target device at runtime (no restart needed) */
  abstract setDevice(device: string): void;

  /** List connected probes / scan for devices. Returns human-readable text. */
  abstract listDevices(): Promise<CommandResult>;

  // ── RTT support (optional - not all probes support this) ─────────

  /** Whether this probe supports RTT */
  supportsRTT(): boolean { return false; }

  /**
   * Restart host-side RTT collection after a target reset.
   *
   * A reset does not stop the target writing to its RTT buffer, but on J-Link
   * it does stop the probe draining it — so every later read reports nothing,
   * which is indistinguishable from a quiet target. Backends that can recover
   * from that override this; the rest say plainly that they cannot, because
   * an unrecoverable stream reported as empty is the more expensive answer.
   */
  async restartRTT(): Promise<{ ok: boolean; detail: string }> {
    return { ok: false, detail: `${this.displayName} cannot restart RTT collection` };
  }

  /** RTT telnet port when GDB server is running (-1 if not supported) */
  getRTTPort(): number { return -1; }

  // ── Lifecycle ────────────────────────────────────────────────────

  abstract dispose(): void;

  // ══════════════════════════════════════════════════════════════════
  // SHARED UTILITIES (used by all backends)
  // ══════════════════════════════════════════════════════════════════

  /**
   * Parse register dump text into structured key-value pairs.
   *
   * Handles two wire formats:
   *  - J-Link Commander `regs`: `NAME = VALUE`, several per line.
   *  - GDB `info registers` / `info all-registers`: whitespace columns,
   *    `name  0xhex  decimal`, one per line, lowercase names.
   *
   * Both normalize to uppercase names and `0x`-prefixed, 8-digit
   * zero-padded values, so downstream consumers (`formatRegistersCompact`,
   * `diagnose_crash`'s `!== "0x00000000"` checks) behave identically
   * regardless of which channel served the read.
   */
  parseRegisters(raw: string): Record<string, string> | null {
    const regs: Record<string, string> = {};

    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // "R0 = 20060050, R1 = 00000000, ..."
      // "PC = 0000BF54, CycleCnt = 0000855D"
      // "SP(R13)= 20062880"
      const simple = /(\w[\w()]*)\s*=\s*([0-9A-Fa-f]{2,8})/g;
      let match;
      let matchedSimple = false;
      while ((match = simple.exec(trimmed)) !== null) {
        matchedSimple = true;
        let name = match[1];
        const value = match[2];
        // Normalize SP(R13) → SP
        const parenMatch = name.match(/^(\w+)\(\w+\)$/);
        if (parenMatch) name = parenMatch[1];
        regs[name] = `0x${value.padStart(8, "0")}`;
      }

      // GDB columns: "r0    0x20060050    537130576"
      //              "pc    0xbf54        0xbf54 <main+20>"
      // Only considered when the `=` form didn't match, so J-Link output
      // can never fall through into this branch.
      if (!matchedSimple) {
        const gdbMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9_]*)\s+0x([0-9a-fA-F]+)(?:\s|$)/);
        if (gdbMatch) {
          regs[gdbMatch[1].toUpperCase()] = `0x${gdbMatch[2].toUpperCase().padStart(8, "0")}`;
        }
      }

      // "XPSR = 41000000: APSR = nZcvq, ..."
      const xpsrMatch = trimmed.match(/APSR\s*=\s*(\w+)/);
      if (xpsrMatch) regs["APSR"] = xpsrMatch[1];
    }

    // GDB reports the combined XPSR but not the IPSR field that
    // `diagnose_crash` uses to detect "we're inside an exception handler".
    // Derive it from XPSR bits [8:0], formatted the same 3-digit way
    // J-Link prints it so the existing comparisons keep working.
    if (regs["XPSR"] && !regs["IPSR"]) {
      const xpsr = parseInt(regs["XPSR"], 16);
      if (!isNaN(xpsr)) regs["IPSR"] = `0x${(xpsr & 0x1ff).toString(16).toUpperCase().padStart(3, "0")}`;
    }

    return Object.keys(regs).length > 0 ? regs : null;
  }

  /** Format registers as a compact, LLM-friendly summary */
  formatRegistersCompact(regs: Record<string, string>): string {
    const core = ["PC", "SP", "LR", "R0", "R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10", "R11", "R12"];
    const status = ["XPSR", "CONTROL", "PRIMASK", "BASEPRI", "FAULTMASK"];
    const stack = ["MSP", "PSP", "MSPLIM", "PSPLIM"];

    const lines: string[] = [];
    const coreVals = core.filter((r) => regs[r]).map((r) => `${r}=${regs[r]}`);
    if (coreVals.length > 0) lines.push("Core: " + coreVals.join(" "));

    const statusVals = status.filter((r) => regs[r]).map((r) => `${r}=${regs[r]}`);
    if (statusVals.length > 0) lines.push("Status: " + statusVals.join(" "));

    const stackVals = stack.filter((r) => regs[r]).map((r) => `${r}=${regs[r]}`);
    if (stackVals.length > 0) lines.push("Stack: " + stackVals.join(" "));

    const fpNonZero = Object.entries(regs)
      .filter(([k, v]) => k.startsWith("FPS") && v !== "0x00000000")
      .map(([k, v]) => `${k}=${v}`);
    if (fpNonZero.length > 0) lines.push("FP (non-zero): " + fpNonZero.join(" "));

    return lines.join("\n");
  }

  /**
   * Parse hex dump lines from probe output.
   *
   * The hex column is matched as an explicit run of byte pairs rather than
   * "anything up to two spaces". J-Link separates the two 8-byte halves of a
   * 16-byte line with a *double* space, exactly like the column before the
   * ASCII field:
   *
   *     E000ED28 = 00 00 00 00 00 00 00 00  01 00 00 00 74 28 06 20  ......t(.
   *                └──────── 8 bytes ─────┘└┘└──────── 8 bytes ────┘└┘└ ascii
   *
   * A non-greedy `(.+?)\s{2,}` stops at the first of those separators and
   * silently drops the second half of every line, which left
   * `readFaultRegisters` short of its 16-byte minimum and reporting
   * CFSR/HFSR/MMFAR/BFAR as all-zero — i.e. "no faults detected" on a live
   * crash.
   */
  parseMemoryDump(raw: string): MemoryDumpLine[] {
    const results: MemoryDumpLine[] = [];
    const HEX_RUN = String.raw`((?:[0-9A-Fa-f]{2}\s+)*[0-9A-Fa-f]{2})`;
    // J-Link format: "E000ED28 = 00 00 00 00 ..."
    const jlinkRe = new RegExp(String.raw`^([0-9A-Fa-f]{8})\s*=\s*${HEX_RUN}(?:\s{2,}(.*))?$`);
    // OpenOCD / GDB format: "0xe000ed28: 00 00 00 00 ..."
    const ocdRe = new RegExp(String.raw`^(0x[0-9a-fA-F]+)\s*:\s*${HEX_RUN}(?:\s{2,}(.*))?$`);

    for (const line of raw.split("\n")) {
      const jlinkMatch = line.match(jlinkRe);
      if (jlinkMatch) {
        results.push({ address: `0x${jlinkMatch[1]}`, hex: jlinkMatch[2].trim(), ascii: (jlinkMatch[3] || "").trim() });
        continue;
      }
      const ocdMatch = line.match(ocdRe);
      if (ocdMatch) {
        results.push({ address: ocdMatch[1], hex: ocdMatch[2].trim(), ascii: (ocdMatch[3] || "").trim() });
      }
    }
    return results;
  }

  /**
   * Disarm the Cortex-M debug hardware so the target is left bootable.
   *
   * A breakpoint comparator left armed in the Flash Patch and Breakpoint unit
   * re-triggers on every subsequent run. With no debugger attached the debug
   * event escalates to HardFault, and the CPU parks in its fault handler
   * permanently — inherited by every later session, and not cleared by a
   * probe-issued reset, which by design leaves the debug block alone so a
   * debugger keeps control across target resets.
   *
   * Zeroing the comparators is the part that matters. FP_CTRL.ENABLE is
   * re-enabled by the J-Link DLL on every attach, so disabling the unit is
   * not durable on its own — it is only safe while the comparators are clear.
   *
   * Best-effort: this runs during teardown, where failing to tidy up must not
   * prevent the caller from disconnecting.
   */
  async disarmDebugState(): Promise<{ ok: boolean; detail: string }> {
    // Halt first. Every write below goes through the debug channel, and a
    // synchronous remote refuses commands outright while the target runs —
    // so on a running target this whole routine was rejected, write by write,
    // and reported "debug hardware disarmed" anyway:
    //
    //   [GDB] > (refused, target running) set {unsigned int}0xe0002008 = 0x0
    //   [GDB] > (refused, target running) set {unsigned int}0xe000200c = 0x0
    //   ... every comparator, then FP_CTRL and DEMCR
    //
    // Teardown is exactly when the target is running, so that was the normal
    // case, not an edge one: the "leave the target bootable" guarantee had
    // never actually held over a live session.
    await this.halt();

    // FP_COMP0..7. Cortex-M4's FPB has up to six code comparators plus two
    // literal ones, and the register file is contiguous — stopping at six
    // leaves the last two armed. Writing past the implemented set is harmless.
    const fpComparators = Array.from({ length: 8 }, (_, i) => 0xe0002008 + i * 4);

    // DWT_FUNCTION0..3 at 0xE0001028 + 0x10*n. A DWT watchpoint traps exactly
    // like a breakpoint and survives a reset exactly as durably, so clearing
    // only the FPB leaves half the problem in place.
    const dwtFunctions = Array.from({ length: 4 }, (_, i) => 0xe0001028 + i * 0x10);

    const writes: [number, number, string][] = [
      ...fpComparators.map((a, i) => [a, 0x00000000, `FP_COMP${i}`] as [number, number, string]),
      ...dwtFunctions.map((a, i) => [a, 0x00000000, `DWT_FUNCTION${i}`] as [number, number, string]),
      // KEY=1, ENABLE=0. The key bit is required for any write to take.
      [0xe0002000, 0x00000002, "FP_CTRL"],
      // Clears every vector-catch enable, which can trap just as durably.
      [0xe000edfc, 0x00000000, "DEMCR"],
    ];

    const failed: string[] = [];
    for (const [addr, value, name] of writes) {
      try {
        const r = await this.writeMemory(addr, value);
        if (!r.success) failed.push(name);
      } catch {
        failed.push(name);
      }
    }
    return failed.length
      ? { ok: false, detail: `could not disarm ${failed.join(", ")}` }
      : { ok: true, detail: "debug hardware disarmed" };
  }

  /** Read fault registers and decode them (ARM Cortex-M specific) */
  async readFaultRegisters(): Promise<{
    result: CommandResult;
    decoded: string;
    raw: { cfsr: number; hfsr: number; dfsr: number; mmfar: number; bfar: number };
  }> {
    const result = await this.readMemory(0xE000ED28, 20);
    const dump = this.parseMemoryDump(result.rawOutput);

    // A read that did not happen is not a report of zeroes. Defaulting to 0
    // here decodes as "No faults detected", which is the most dangerous
    // sentence this tool can produce: it is exactly what a healthy target
    // says, so a failed read is indistinguishable from good news.
    //
    // Seen on hardware twice, by different routes — once when the dump parser
    // dropped half of every line, and once when the target was spinning in
    // its own fault handler, which a synchronous remote treats as "running"
    // and therefore refuses to read.
    if (!result.success || dump.length === 0) {
      return {
        result,
        decoded:
          "Could not read the fault registers — this is NOT a report that the target is healthy.\n" +
          "The target may be running (halt it first: a CPU spinning in a fault handler still counts as running).\n" +
          (result.error ? `Underlying error: ${result.error}` : ""),
        raw: { cfsr: 0, hfsr: 0, dfsr: 0, mmfar: 0, bfar: 0 },
      };
    }

    let cfsr = 0, hfsr = 0, dfsr = 0, mmfar = 0, bfar = 0;
    if (dump.length > 0) {
      const allHex = dump.map((d) => d.hex).join(" ");
      const bytes = allHex.split(/\s+/).filter(Boolean);
      if (bytes.length >= 16) {
        cfsr = parseLittleEndian32(bytes, 0);
        hfsr = parseLittleEndian32(bytes, 4);
        // 0xE000ED30, between HFSR and MMFAR. It names which debug event
        // fired, which is the only way to tell a leftover breakpoint apart
        // from a genuine fault when HFSR reports DEBUGEVT and CFSR is clear.
        dfsr = parseLittleEndian32(bytes, 8);
        mmfar = parseLittleEndian32(bytes, 12);
        bfar = parseLittleEndian32(bytes, 16);
      }
    }

    return {
      result,
      decoded: decodeFaultRegisters(cfsr, hfsr, mmfar, bfar, dfsr),
      raw: { cfsr, hfsr, dfsr, mmfar, bfar },
    };
  }
}

// ══════════════════════════════════════════════════════════════════════
// Shared free functions
// ══════════════════════════════════════════════════════════════════════

export function parseLittleEndian32(bytes: string[], offset: number): number {
  if (offset + 3 >= bytes.length) return 0;
  return (
    (parseInt(bytes[offset], 16)) |
    (parseInt(bytes[offset + 1], 16) << 8) |
    (parseInt(bytes[offset + 2], 16) << 16) |
    (parseInt(bytes[offset + 3], 16) << 24)
  ) >>> 0;
}

export function decodeFaultRegisters(cfsr: number, hfsr: number, mmfar: number, bfar: number, dfsr = 0): string {
  const lines: string[] = [];
  const mmfsr = cfsr & 0xFF;
  const bfsr = (cfsr >> 8) & 0xFF;
  const ufsr = (cfsr >> 16) & 0xFFFF;

  if (cfsr === 0 && hfsr === 0) {
    lines.push("No faults detected (CFSR=0, HFSR=0)");
    return lines.join("\n");
  }

  if (mmfsr) {
    lines.push("## MemManage Fault (MMFSR):");
    if (mmfsr & 0x01) lines.push("  - IACCVIOL: Instruction access violation");
    if (mmfsr & 0x02) lines.push("  - DACCVIOL: Data access violation");
    if (mmfsr & 0x08) lines.push("  - MUNSTKERR: MemManage on unstacking");
    if (mmfsr & 0x10) lines.push("  - MSTKERR: MemManage on stacking");
    if (mmfsr & 0x20) lines.push("  - MLSPERR: MemManage during FP lazy state preservation");
    if (mmfsr & 0x80) lines.push(`  - MMARVALID: Faulting address = 0x${mmfar.toString(16).padStart(8, "0")}`);
  }
  if (bfsr) {
    lines.push("## BusFault (BFSR):");
    if (bfsr & 0x01) lines.push("  - IBUSERR: Instruction bus error");
    if (bfsr & 0x02) lines.push("  - PRECISERR: Precise data bus error");
    if (bfsr & 0x04) lines.push("  - IMPRECISERR: Imprecise data bus error");
    if (bfsr & 0x08) lines.push("  - UNSTKERR: BusFault on unstacking");
    if (bfsr & 0x10) lines.push("  - STKERR: BusFault on stacking");
    if (bfsr & 0x20) lines.push("  - LSPERR: BusFault during FP lazy state preservation");
    if (bfsr & 0x80) lines.push(`  - BFARVALID: Faulting address = 0x${bfar.toString(16).padStart(8, "0")}`);
  }
  if (ufsr) {
    lines.push("## UsageFault (UFSR):");
    if (ufsr & 0x0001) lines.push("  - UNDEFINSTR: Undefined instruction");
    if (ufsr & 0x0002) lines.push("  - INVSTATE: Invalid state (e.g., Thumb bit)");
    if (ufsr & 0x0004) lines.push("  - INVPC: Invalid PC load (bad EXC_RETURN)");
    if (ufsr & 0x0008) lines.push("  - NOCP: No coprocessor");
    if (ufsr & 0x0010) lines.push("  - STKOF: Stack overflow detected");
    if (ufsr & 0x0100) lines.push("  - UNALIGNED: Unaligned memory access");
    if (ufsr & 0x0200) lines.push("  - DIVBYZERO: Division by zero");
  }
  if (hfsr) {
    lines.push("## HardFault (HFSR):");
    if (hfsr & 0x02) lines.push("  - VECTTBL: Vector table read fault");
    if (hfsr & 0x40000000) lines.push("  - FORCED: Forced HardFault (escalated from configurable fault)");
    if (hfsr & 0x80000000) {
      lines.push("  - DEBUGEVT: Debug event triggered HardFault");
      // Decode which debug event. With CFSR clear this is almost always a
      // debug resource left armed by an earlier session rather than a bug in
      // the firmware — the debug block is not cleared by the reset a probe
      // issues, so a stale breakpoint or vector catch keeps firing and, with
      // nothing attached to handle it, escalates to HardFault.
      const causes: string[] = [];
      if (dfsr & 0x01) causes.push("HALTED (step or halt request)");
      if (dfsr & 0x02) causes.push("BKPT (breakpoint — FPB comparator or BKPT instruction)");
      if (dfsr & 0x04) causes.push("DWTTRAP (watchpoint)");
      if (dfsr & 0x08) causes.push("VCATCH (vector catch)");
      if (dfsr & 0x10) causes.push("EXTERNAL (external debug request)");
      if (causes.length) {
        lines.push(`    DFSR=0x${dfsr.toString(16).padStart(8, "0")}: ${causes.join(", ")}`);
        lines.push("    A debug resource is still armed on this target. Clear breakpoints,");
        lines.push("    then reset. Debug state survives the reset a probe issues.");
      }
    }
  }

  return lines.join("\n");
}
