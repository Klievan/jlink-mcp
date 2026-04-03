/**
 * ProbeBackend is the abstraction layer for debug probes.
 * Each probe type (J-Link, OpenOCD, Black Magic Probe, probe-rs)
 * implements this interface. The MCP server calls only these methods.
 */

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

  get state(): ProbeState { return this._state; }

  get rttConnected(): boolean { return this._rttConnected; }
  set rttConnected(v: boolean) {
    // RTT can only be connected if GDB server is running
    if (v && this._state !== ProbeState.GDB_RUNNING) {
      this._rttConnected = false;
      return;
    }
    this._rttConnected = v;
  }

  /** Transition state with validation */
  protected setState(newState: ProbeState): void {
    this._state = newState;
    // If we lose target attach, RTT is invalid
    if (newState === ProbeState.DISCONNECTED || newState === ProbeState.PROBE_CONNECTED) {
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

  // ── Device control ───────────────────────────────────────────────

  abstract getDeviceInfo(): Promise<CommandResult>;
  abstract halt(): Promise<CommandResult>;
  abstract resume(): Promise<CommandResult>;
  abstract reset(halt?: boolean): Promise<CommandResult>;
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

  /** RTT telnet port when GDB server is running (-1 if not supported) */
  getRTTPort(): number { return -1; }

  // ── Lifecycle ────────────────────────────────────────────────────

  abstract dispose(): void;

  // ══════════════════════════════════════════════════════════════════
  // SHARED UTILITIES (used by all backends)
  // ══════════════════════════════════════════════════════════════════

  /** Parse register dump text into structured key-value pairs */
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
      while ((match = simple.exec(trimmed)) !== null) {
        let name = match[1];
        const value = match[2];
        // Normalize SP(R13) → SP
        const parenMatch = name.match(/^(\w+)\(\w+\)$/);
        if (parenMatch) name = parenMatch[1];
        regs[name] = `0x${value}`;
      }

      // "XPSR = 41000000: APSR = nZcvq, ..."
      const xpsrMatch = trimmed.match(/APSR\s*=\s*(\w+)/);
      if (xpsrMatch) regs["APSR"] = xpsrMatch[1];
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

  /** Parse hex dump lines from probe output */
  parseMemoryDump(raw: string): MemoryDumpLine[] {
    const results: MemoryDumpLine[] = [];
    for (const line of raw.split("\n")) {
      // J-Link format: "E000ED28 = 00 00 00 00 ..."
      const jlinkMatch = line.match(/^([0-9A-Fa-f]{8})\s*=\s*(.+?)\s{2,}(.*)$/);
      if (jlinkMatch) {
        results.push({ address: `0x${jlinkMatch[1]}`, hex: jlinkMatch[2].trim(), ascii: jlinkMatch[3].trim() });
        continue;
      }
      // OpenOCD / GDB format: "0xe000ed28: 00 00 00 00 ..."
      const ocdMatch = line.match(/^(0x[0-9a-fA-F]+)\s*:\s*(.+?)(?:\s{2,}(.*))?$/);
      if (ocdMatch) {
        results.push({ address: ocdMatch[1], hex: ocdMatch[2].trim(), ascii: (ocdMatch[3] || "").trim() });
      }
    }
    return results;
  }

  /** Read fault registers and decode them (ARM Cortex-M specific) */
  async readFaultRegisters(): Promise<{
    result: CommandResult;
    decoded: string;
    raw: { cfsr: number; hfsr: number; mmfar: number; bfar: number };
  }> {
    const result = await this.readMemory(0xE000ED28, 20);
    const dump = this.parseMemoryDump(result.rawOutput);

    let cfsr = 0, hfsr = 0, mmfar = 0, bfar = 0;
    if (dump.length > 0) {
      const allHex = dump.map((d) => d.hex).join(" ");
      const bytes = allHex.split(/\s+/).filter(Boolean);
      if (bytes.length >= 16) {
        cfsr = parseLittleEndian32(bytes, 0);
        hfsr = parseLittleEndian32(bytes, 4);
        mmfar = parseLittleEndian32(bytes, 12);
        bfar = parseLittleEndian32(bytes, 16);
      }
    }

    return { result, decoded: decodeFaultRegisters(cfsr, hfsr, mmfar, bfar), raw: { cfsr, hfsr, mmfar, bfar } };
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

export function decodeFaultRegisters(cfsr: number, hfsr: number, mmfar: number, bfar: number): string {
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
    if (hfsr & 0x80000000) lines.push("  - DEBUGEVT: Debug event triggered HardFault");
  }

  return lines.join("\n");
}
