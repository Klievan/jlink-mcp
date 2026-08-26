import { spawn } from "child_process";
import { ProbeBackend, ProbeState, ProbeErrorCode, CommandResult, GDBServerInfo, parseLittleEndian32 } from "./backend";
import { ProcessManager } from "../utils/process-manager";
import { log, logError, logRaw } from "../utils/logger";
import * as path from "path";
import * as fs from "fs";

export interface JLinkConfig {
  installDir: string;
  device: string;
  interface: "SWD" | "JTAG";
  speed: number;
  serialNumber?: string;
  gdbPort: number;
  rttTelnetPort: number;
  /**
   * Address of the SEGGER RTT control block, when it is known.
   *
   * J-Link normally locates this itself by scanning RAM. Knowing it lets us
   * re-point the probe at the block after a target reset, which J-Link does
   * not do on its own — see restartRTT().
   */
  rttControlBlockAddress?: number;
  swoTelnetPort: number;
}

const GDB_SERVER_PROCESS = "jlink-gdb-server";

// Lines that are JLink connection boilerplate
const BOILERPLATE_PATTERNS = [
  /^SEGGER J-Link Commander/, /^DLL version/, /^J-Link Commander will now exit/,
  /^Connecting to J-Link via USB/, /^Firmware: J-Link/, /^Hardware version:/,
  /^J-Link uptime/, /^S\/N:/, /^License\(s\):/, /^USB speed mode:/, /^VTref=/,
  /^Device ".*" selected/, /^Connecting to target via SWD/, /^Connecting to target via JTAG/,
  /^ConfigTargetSettings\(\)/, /^InitTarget\(\)/, /^Found SW-DP with ID/, /^DPIDR:/,
  /^CoreSight/, /^AP map detection/, /^AP\[\d+\]:/, /^CPUID register:/,
  /^Feature set:/, /^Cache:/, /^Found Cortex-/, /^FPUnit:/,
  /^Security extension: /, /^Secure debug:/, /^ROMTbl\[\d+\]/, /^\[\d+\]\[\d+\]:/,
  /^Memory zones:/, /^\s+Zone:/, /^Cortex-M\d+ identified/, /^Type "connect"/,
  /^Please specify/, /^Specify target/, /^$/, /^J-Link>/, /^J-Link\[\d+\]:/,
  /^Syntax:/, /^Sleep\(\d+\)/, /^Script processing completed/,
];

function stripBoilerplate(raw: string): string {
  return raw.split("\n")
    .filter((line) => {
      const t = line.trim();
      return t && !BOILERPLATE_PATTERNS.some((p) => p.test(t));
    })
    .join("\n").trim();
}

function findJLinkInstallDir(): string {
  const candidates = [
    "/opt/SEGGER/JLink", "/usr/local/SEGGER/JLink", "/Applications/SEGGER/JLink",
    "C:\\Program Files\\SEGGER\\JLink", "C:\\Program Files (x86)\\SEGGER\\JLink",
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  for (const base of ["/opt/SEGGER", "/Applications/SEGGER", "/usr/local/SEGGER"]) {
    if (fs.existsSync(base)) {
      try {
        const entries = fs.readdirSync(base).filter((e) => e.startsWith("JLink"));
        if (entries.length > 0) return path.join(base, entries.sort().reverse()[0]);
      } catch { /* ignore */ }
    }
  }
  return "";
}

export class JLinkBackend extends ProbeBackend {
  readonly type = "jlink" as const;
  readonly displayName = "SEGGER J-Link";

  private config: JLinkConfig;
  private processManager: ProcessManager;
  private gdbOutputBuffer: string[] = [];

  constructor(config: Partial<JLinkConfig>, processManager: ProcessManager) {
    super();
    this.processManager = processManager;
    this.config = {
      installDir: config.installDir || findJLinkInstallDir(),
      device: config.device || "Unspecified",
      interface: config.interface || "SWD",
      speed: config.speed || 4000,
      serialNumber: config.serialNumber,
      gdbPort: config.gdbPort || 2331,
      rttTelnetPort: config.rttTelnetPort || 19021,
      rttControlBlockAddress: config.rttControlBlockAddress,
      swoTelnetPort: config.swoTelnetPort || 2332,
    };
  }

  private get jlinkExe(): string {
    const exe = process.platform === "win32" ? "JLink.exe" : "JLinkExe";
    return this.config.installDir ? path.join(this.config.installDir, exe) : exe;
  }

  private get gdbServerExe(): string {
    const exe = process.platform === "win32" ? "JLinkGDBServerCL.exe" : "JLinkGDBServerCLExe";
    return this.config.installDir ? path.join(this.config.installDir, exe) : exe;
  }

  /**
   * Raw JLinkExe execution. Does NOT include preflight/locking.
   * Use the public methods (which call withPreflight) instead.
   *
   * Notes on flags:
   *  - `-ExitOnError 1` is intentionally NOT passed. J-Link Commander
   *    treats the transient "Failed to initialize DAP" line emitted before
   *    a successful `connect under reset` fallback as an error, causing
   *    the interpreter to bail before running the user's script. That
   *    breaks any target where the first attach attempt is unreliable
   *    (e.g. STM32L0 at 4 MHz SWD, MCU running from MSI). We classify
   *    real failures below by parsing stdout instead.
   */
  private async execRaw(commands: string[], speedOverride?: number): Promise<CommandResult> {
    const speed = speedOverride ?? this.config.speed;
    const args = [
      "-device", this.config.device,
      "-if", this.config.interface,
      "-speed", String(speed),
      "-autoconnect", "1",
      "-NoGui", "1",
    ];
    if (this.config.serialNumber) {
      args.push("-SelectEmuBySN", this.config.serialNumber);
    }

    log(`[J-Link] ${commands.join("; ")}${speedOverride ? ` (speed=${speed})` : ""}`);

    return new Promise<CommandResult>((resolve) => {
      const proc = spawn(this.jlinkExe, args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "";

      proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

      proc.stdin?.write(commands.concat(["exit"]).join("\n") + "\n");
      proc.stdin?.end();

      proc.on("error", (err) => {
        clearTimeout(timer);
        logError("J-Link spawn error", err);
        this.setState(ProbeState.DISCONNECTED);
        resolve({ success: false, rawOutput: stdout, output: stdout, error: `Failed to spawn JLinkExe: ${err.message}`, errorCode: ProbeErrorCode.PROBE_NOT_FOUND });
      });
      proc.on("exit", (code) => {
        clearTimeout(timer);
        logRaw("jlink", commands.join("; "), stdout);
        if (code !== 0) logError(`J-Link exited with code ${code}`);
        const result: CommandResult = { success: code === 0, rawOutput: stdout, output: stripBoilerplate(stdout), error: stderr || undefined };
        // Classify failures from stdout. Since -ExitOnError is no longer
        // set, JLinkExe may exit 0 even when the target could not be
        // reached (it drops to the interactive prompt and quietly runs
        // `exit`), so we must also flip `success` when we detect a
        // structural failure — otherwise recovery logic that keys off
        // `result.success` would incorrectly treat this as fine.
        const raw = stdout.toLowerCase();
        if (raw.includes("inittarget() returned error") || raw.includes("could not connect") || raw.includes("cannot connect")) {
          result.success = false;
          result.errorCode = ProbeErrorCode.TARGET_UNREACHABLE;
          result.lastSuccessfulStage = "probe_connected";
          result.suggestedAction = "Target attach failed. Try: reset with halt, reduce speed, or power cycle.";
        } else if (raw.includes("failed to open dll") || raw.includes("no j-link") || raw.includes("no emulators found")) {
          result.success = false;
          result.errorCode = ProbeErrorCode.PROBE_NOT_FOUND;
          result.suggestedAction = "No J-Link probe found. Check USB connection.";
        }
        resolve(result);
      });

      // Cleared on both exit and error. Left pending, this timer keeps the
      // event loop alive for a further 30s after every single J-Link
      // command, delaying process shutdown and holding the closure (and
      // the dead child handle) live for that whole window.
      const timer = setTimeout(() => {
        proc.kill("SIGTERM");
        resolve({ success: false, rawOutput: stdout, output: stripBoilerplate(stdout), error: "J-Link timed out after 30s", errorCode: ProbeErrorCode.TIMEOUT });
      }, 30000);
    });
  }

  /**
   * Deterministic recovery sequence:
   * 1. Stop GDB server if running
   * 2. Try connect under reset
   * 3. If that fails, reduce speed (4000 → 1000 → 400) and retry
   */
  async recover(): Promise<boolean> {
    log("[J-Link] Starting recovery sequence");

    // Stop GDB server to release the probe
    if (this.isGDBServerRunning()) {
      log("[J-Link] Recovery: stopping GDB server");
      this.stopGDBServer();
      await sleep(1000);
    }

    // Try connect under reset at various speeds
    const speeds = [this.config.speed, 1000, 400];
    for (const speed of speeds) {
      log(`[J-Link] Recovery: trying connect under reset at ${speed} kHz`);
      const result = await this.execRaw(["r", "halt", "sleep 200", "regs"], speed);
      if (result.success) {
        log(`[J-Link] Recovery succeeded at ${speed} kHz`);
        if (speed !== this.config.speed) {
          log(`[J-Link] Keeping reduced speed: ${speed} kHz (was ${this.config.speed})`);
          this.config.speed = speed;
        }
        this.setState(ProbeState.TARGET_ATTACHED);
        return true;
      }
    }

    log("[J-Link] Recovery failed at all speeds");
    this.setState(ProbeState.PROBE_CONNECTED);
    return false;
  }

  /**
   * Override preflight to use execRaw directly (avoids deadlock since
   * preflight is called inside acquireLock from withPreflight).
   */
  async preflight(): Promise<CommandResult | null> {
    const result = await this.execRaw([`mem 0xE000EDF0, 4`]);
    if (!result.success) {
      return {
        success: false,
        rawOutput: result.rawOutput,
        output: "Preflight failed: cannot read DHCSR. Target may be unreachable.",
        error: result.error,
        errorCode: ProbeErrorCode.TARGET_UNREACHABLE,
        lastSuccessfulStage: "probe_connected",
        suggestedAction: "Try reset with halt, reduce SWD speed, or power cycle.",
      };
    }
    this.setState(ProbeState.TARGET_ATTACHED);
    return null;
  }

  // ── ProbeBackend implementation ──────────────────────────────────
  // All target-touching methods go through withPreflight for
  // automatic validation, locking, and recovery.
  //
  // Routing note: when a GDB session is connected, the J-Link probe can
  // only serve one client. Spawning JLinkExe alongside a running
  // JLinkGDBServer forces the server's session shut, which is what
  // caused `halt`/`readMemory`/etc. to leave the GDB client seeing a
  // dead remote. So CPU-control and read paths prefer the GDB bridge
  // when it is available; JLinkExe is used only when no GDB session is
  // up (or for operations GDB can't perform, like `mem` before a
  // session exists). Set `JLINK_MCP_GDB_ROUTING=0` to force the legacy
  // JLinkExe path unconditionally.

  /** True when we should prefer the GDB bridge over spawning JLinkExe. */
  private useGdb(): boolean {
    const optOut = process.env.JLINK_MCP_GDB_ROUTING;
    if (optOut === "0" || optOut?.toLowerCase() === "false") return false;
    return !!this.gdbBridge?.isConnected();
  }

  /**
   * Translate a caller-supplied register name into what GDB accepts.
   *
   * The `read_register` tool documents J-Link-style names ('PC', 'SP',
   * 'R0'), but GDB's register names are lowercase and case-sensitive —
   * `info registers PC` fails with "Invalid register `PC'". Strip an
   * optional `$` sigil, lowercase, and map the J-Link-only spellings
   * that have a GDB equivalent.
   */
  private static toGdbRegName(name: string): string {
    const n = name.trim().replace(/^\$/, "").toLowerCase();
    const aliases: Record<string, string> = {
      "sp(r13)": "sp",
      "lr(r14)": "lr",
      "pc(r15)": "pc",
      r13: "sp",
      r14: "lr",
      r15: "pc",
      psr: "xpsr",
      apsr: "xpsr",
      epsr: "xpsr",
      ipsr: "xpsr",
    };
    return aliases[n] ?? n;
  }

  /** Wrap a GDB command result in the shared `CommandResult` shape. */
  private async runViaGdb(cmd: string, timeoutMs: number = 10000): Promise<CommandResult> {
    const r = await this.gdbBridge!.command(cmd, timeoutMs);
    return {
      success: r.success,
      rawOutput: r.output,
      output: r.output,
      error: r.error,
    };
  }

  async getDeviceInfo(): Promise<CommandResult> {
    if (this.useGdb()) return this.runViaGdb("info registers");
    return this.withPreflight("getDeviceInfo", () => this.execRaw(["halt", "regs"]));
  }
  async halt(): Promise<CommandResult> {
    if (this.useGdb()) {
      // Halt out-of-band, not through the command channel.
      //
      // The J-Link GDB Server is a synchronous remote, so while the target
      // runs GDB sits in its resume loop and stops reading stdin altogether.
      // A halt typed as a command — `interrupt` or `monitor halt` — is never
      // read, and just times out. Confirmed on hardware: after one `continue`
      // the GDB server logged nothing further, and every subsequent command
      // sat for the full client timeout. SIGINT is the only channel GDB is
      // still listening on.
      const bridge = this.gdbBridge;
      if (bridge?.interrupt) {
        const r = await bridge.interrupt(5000);
        if (r.success) {
          return { success: true, rawOutput: r.output, output: r.output, error: r.error };
        }
      }
      // No out-of-band channel, or it failed: the target is most likely
      // already stopped, where `monitor halt` is both safe and sufficient.
      return this.runViaGdb("monitor halt", 5000);
    }
    return this.withPreflight("halt", () => this.execRaw(["halt"]));
  }
  async resume(): Promise<CommandResult> {
    if (this.useGdb()) {
      // Kick the target running but don't block waiting for a stop event
      // — resume is fire-and-forget. Short timeout so callers see prompt
      // return.
      return this.runViaGdb("continue", 500);
    }
    return this.withPreflight("resume", () => this.execRaw(["go"]));
  }
  /**
   * Reset the target, optionally leaving it stopped at the reset vector.
   *
   * This used to hand-roll a vector catch: set DEMCR.VC_CORERESET, reset,
   * clear it. That was reinventing something J-Link already does, and doing
   * it worse. Per SEGGER's reset-strategy reference, the default Cortex-M
   * strategy (type 0) *is* a vector-catch reset — "the device should halt
   * immediately after a reset (before it can execute any user-application
   * instruction), which is ensured by setting the VC_CORERESET in the DEMCR"
   * — and the GDB server documents `monitor reset` as "resets and halts the
   * target CPU". Type 0 also lets J-Link pick the per-device sequence, which
   * matters on parts whose reset needs vendor-specific handling; a hand-built
   * sequence silently opts out of that.
   *
   *   https://kb.segger.com/J-Link_Reset_Strategies
   *
   * So the reset itself is J-Link's job. Ours is to check it actually
   * happened — see verifyResetHalt. A reset that quietly does nothing (the
   * probe owned by another process, say) otherwise reports success while the
   * core keeps running, which is how this landed as "PC in main after
   * reset(halt)" and got misread as a missing vector catch.
   *
   * @param strategy Optional J-Link reset type. Omit to let J-Link choose,
   *   which SEGGER recommends. Type 1 resets the core only via VECTRESET and
   *   leaves peripherals alone; type 2 drives the reset pin.
   */
  async reset(halt = false, strategy?: number): Promise<CommandResult> {
    if (this.useGdb()) {
      // Note on sequencing: each of these MUST be a separate `command()`
      // call. GDBClient writes the string straight to stdin and resolves on
      // the first result record, so a "cmd\ncmd" string leaves the second
      // response orphaned in the shared buffer, where it can satisfy the
      // *next* command's completion check and desync every reply after it.
      const mon = strategy === undefined ? "monitor reset" : `monitor reset ${strategy}`;

      // Halt first, because a reset is a recovery action and the moment you
      // reach for one is precisely when the target is running.
      //
      // The J-Link GDB server is a synchronous remote: while the target runs
      // it stops reading stdin, so every command typed at it is silently
      // refused. Measured on hardware — an entire reset sequence refused
      // command by command while the tool still reported success, leaving the
      // core running in main and the PC wherever its delay loop had reached:
      //
      //   [GDB] > (refused, target running) monitor reset
      //   [GDB] > (refused, target running) x/1wx 0xe000edfc
      //   [GDB] > (refused, target running) monitor reset
      //
      // halt() goes out of band over SIGINT, which is the only channel a
      // synchronous remote is still listening on.
      await this.halt();

      if (halt) {
        return this.verifyResetHalt(await this.runViaGdb(mon, 8000));
      }

      const reset = await this.runViaGdb(mon, 8000);
      if (!reset.success) return reset;
      const go = await this.runViaGdb("monitor go", 5000);
      return {
        success: go.success,
        rawOutput: [reset.rawOutput, go.rawOutput].filter(Boolean).join("\n"),
        output: [reset.output, go.output].filter(Boolean).join("\n"),
        error: go.error,
      };
    }

    // Reset doesn't need preflight — it IS the recovery action.
    const setType = strategy === undefined ? [] : [`RSetType ${strategy}`];
    if (halt) {
      // `r` halts on its own; there is no `halt` here on purpose. Adding one
      // cannot help — if `r` stopped at the vector the halt is a no-op, and
      // if it did not, halting late just parks the PC wherever startup had
      // reached and makes a broken reset look like a working one.
      return this.verifyResetHalt(await this.acquireLock(() => this.execRaw([...setType, "r"])));
    }
    return this.acquireLock(() => this.execRaw([...setType, "r", "go"]));
  }

  /** Read one 32-bit little-endian word, or null if the read did not land. */
  private async readWord32(address: number): Promise<number | null> {
    const r = await this.readMemory(address, 4);
    if (!r.success) return null;
    const bytes = this.parseMemoryDump(r.rawOutput).map((d) => d.hex).join(" ").split(/\s+/).filter(Boolean);
    return bytes.length >= 4 ? parseLittleEndian32(bytes, 0) : null;
  }

  /**
   * Confirm a halting reset actually left the core at the reset vector.
   *
   * The check is against the vector table the *target* is using — VTOR, then
   * the word at VTOR+4 — rather than a hardcoded address, so it holds for
   * bootloaders and relocated tables too. The Thumb bit is masked off, and a
   * small window is allowed because some strategies stop a few instructions
   * in.
   *
   * If anything needed for the check cannot be read, the original result is
   * returned untouched. An unverifiable reset is not a failed one, and
   * inventing a failure here would be the same class of lie as the silent
   * success this exists to catch.
   */
  private async verifyResetHalt(reset: CommandResult): Promise<CommandResult> {
    if (!reset.success) return reset;

    const vtor = await this.readWord32(0xe000ed08);
    if (vtor === null) return reset;
    const vector = await this.readWord32((vtor & 0xffffff80) + 4);
    if (vector === null || vector === 0 || vector === 0xffffffff) return reset;

    const pcResult = await this.readRegister("PC");
    const pc = parseInt(pcResult.output.match(/0x([0-9a-fA-F]+)/)?.[1] ?? "", 16);
    if (!Number.isFinite(pc)) return reset;

    const entry = vector & ~1;
    if (pc >= entry && pc <= entry + 0x20) return reset;

    return {
      ...reset,
      success: false,
      errorCode: ProbeErrorCode.TARGET_UNREACHABLE,
      error:
        `Reset reported success but the core is at 0x${pc.toString(16)}, not the reset vector ` +
        `0x${entry.toString(16)} (from VTOR 0x${vtor.toString(16)}).`,
      suggestedAction: this.rttConnected
        ? "RTT is connected, and that is the likely explanation rather than the reset failing. " +
          "J-Link collects RTT in stop mode by default (SetAllowStopMode is enabled): it halts " +
          "the core, reads the buffer, and starts it again. A core cannot be held at the reset " +
          "vector while that is running. Disconnect RTT first if you need the target to stay " +
          "put. See https://kb.segger.com/J-Link_Command_Strings"
        : "Most often another process owns the probe (a GDB server or a second JLinkExe), so the " +
          "reset command was accepted and discarded. Check for other J-Link processes, then " +
          "retry. If the target needs a different reset strategy, pass one — see " +
          "https://kb.segger.com/J-Link_Reset_Strategies",
    };
  }
  async step(): Promise<CommandResult> {
    if (this.useGdb()) return this.runViaGdb("stepi", 5000);
    return this.withPreflight("step", () => this.execRaw(["halt", "s"]));
  }

  /**
   * Read `length` bytes at `address`.
   *
   * The byte count goes to J-Link Commander as bare hex digits.
   *
   * `mem` parses its length as hex, so a decimal count is silently misread:
   * `mem 0x0, 20` returns 0x20 = 32 bytes and `mem 0x0, 256` returns 0x256 =
   * 598. Both observed on hardware. Every caller passing a decimal length —
   * readFaultRegisters asking for 20, snapshot asking for 64 — was
   * over-reading, and any caller counting bytes back got the wrong answer.
   *
   * It must be bare hex, NOT 0x-prefixed: `mem 0xe000edf0, 0x4` is rejected
   * outright, which took out even the DHCSR preflight read and made every
   * memory tool report "Target may be unreachable". Address takes 0x, length
   * does not.
   */
  async readMemory(address: number, length: number): Promise<CommandResult> {
    if (this.useGdb()) return this.readMemoryViaGdb(address, length);
    // Skip preflight when reading DHCSR (that IS the preflight)
    const isDHCSR = address === 0xE000EDF0;
    const cmd = `mem 0x${address.toString(16)}, ${length.toString(16)}`;
    if (isDHCSR) return this.acquireLock(() => this.execRaw([cmd]));
    return this.withPreflight("readMemory", () => this.execRaw([cmd]));
  }
  async writeMemory(address: number, value: number): Promise<CommandResult> {
    if (this.useGdb()) {
      return this.runViaGdb(`set {unsigned int}0x${address.toString(16)} = 0x${value.toString(16)}`, 5000);
    }
    return this.withPreflight("writeMemory", () => this.execRaw([`w4 0x${address.toString(16)}, 0x${value.toString(16)}`]));
  }

  async readAllRegisters(): Promise<CommandResult> {
    if (this.useGdb()) return this.runViaGdb("info all-registers", 5000);
    return this.withPreflight("readAllRegisters", () => this.execRaw(["halt", "regs"]));
  }
  /**
   * Read one named register.
   *
   * The JLinkExe path deliberately does NOT use `rreg`. J-Link Commander
   * rejects both the ARM mnemonics and the architectural names it prints as
   * valid — `rreg PC` and `rreg R15` both answer "Illegal register name." and
   * dump a 100-entry list — so the tool returned an error page instead of a
   * value. `regs` prints the whole set reliably, so read the set and pick the
   * register out of it with the parser that already understands both the
   * J-Link and GDB formats.
   *
   * This also makes the tool answer the question that was asked: previously a
   * successful call returned the entire register dump.
   */
  async readRegister(name: string): Promise<CommandResult> {
    if (this.useGdb()) return this.runViaGdb(`info registers ${JLinkBackend.toGdbRegName(name)}`, 5000);

    const result = await this.withPreflight("readRegister", () => this.execRaw(["halt", "regs"]));
    if (!result.success) return result;

    const regs = this.parseRegisters(result.rawOutput);
    const wanted = JLinkBackend.toCanonicalRegName(name);
    const value = regs?.[wanted];
    if (value === undefined) {
      return {
        ...result,
        success: false,
        output: `Unknown register '${name}'. Available: ${regs ? Object.keys(regs).join(", ") : "(none parsed)"}`,
      };
    }
    return { ...result, output: `${wanted} = ${value}` };
  }

  /**
   * Normalize a register name to the spelling `parseRegisters` produces.
   * Accepts the ARM mnemonics, the Rn forms, and a `$` sigil.
   */
  private static toCanonicalRegName(name: string): string {
    const n = name.trim().replace(/^\$/, "").toUpperCase();
    const aliases: Record<string, string> = {
      R13: "SP", R14: "LR", R15: "PC",
      "SP(R13)": "SP", "R14(LR)": "LR", "R15(PC)": "PC",
    };
    return aliases[n] ?? n;
  }

  /**
   * Read memory over the GDB session and normalize the output to the
   * J-Link Commander format (`ADDR = XX XX ...  ASCII`) so downstream
   * consumers like `readFaultRegisters` / `parseMemoryDump` don't need to
   * care which channel served the read.
   */
  private async readMemoryViaGdb(address: number, length: number): Promise<CommandResult> {
    const raw = await this.gdbBridge!.command(`x/${length}bx 0x${address.toString(16)}`, 5000);
    const normalized = raw.output
      .split("\n")
      .map((line) => {
        const m = line.match(/^\s*0x([0-9a-fA-F]+)\s*(?:<[^>]*>)?\s*:\s*(.+)$/);
        if (!m) return line;
        const addr = m[1].toUpperCase().padStart(8, "0");
        const bytes = m[2]
          .trim()
          .split(/\s+/)
          .map((b) => b.replace(/^0x/, "").padStart(2, "0"));
        const ascii = bytes
          .map((h) => {
            const c = parseInt(h, 16);
            return c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : ".";
          })
          .join("");
        return `${addr} = ${bytes.join(" ")}  ${ascii}`;
      })
      .join("\n");
    return {
      success: raw.success,
      rawOutput: normalized,
      output: normalized,
      error: raw.error,
    };
  }

  async flash(filePath: string, baseAddress?: number): Promise<CommandResult> {
    const addr = baseAddress !== undefined ? ` 0x${baseAddress.toString(16)}` : "";
    return this.withPreflight("flash", () => this.execRaw(["r", "halt", `loadfile ${filePath}${addr}`, "r", "go"]));
  }
  async erase(): Promise<CommandResult> {
    return this.withPreflight("erase", () => this.execRaw(["erase"]));
  }

  /**
   * Breakpoints during a GDB session must go through GDB.
   *
   * The JLinkExe path is doubly wrong once a session is live. It evicts the
   * GDB server (one client per probe), and the breakpoint it sets dies with
   * the transient JLinkExe process anyway — so the caller loses their session
   * and does not even get a breakpoint for it. GDB's own breakpoints persist
   * for the life of the session and are what `resume`/`gdb_wait` will actually
   * stop on.
   */
  async setBreakpoint(address: number): Promise<CommandResult> {
    if (this.useGdb()) return this.runViaGdb(`break *0x${address.toString(16)}`, 5000);
    return this.withPreflight("setBreakpoint", () => this.execRaw([`SetBP 0x${address.toString(16)}`]));
  }
  async clearBreakpoints(): Promise<CommandResult> {
    // `delete` with no argument deletes every breakpoint and, unlike the
    // interactive form, does not prompt for confirmation in MI.
    if (this.useGdb()) return this.runViaGdb("delete breakpoints", 5000);
    return this.withPreflight("clearBreakpoints", () => this.execRaw(["ClrBP"]));
  }

  async executeRaw(commands: string[]): Promise<CommandResult> {
    return this.withPreflight("executeRaw", () => this.execRaw(commands));
  }

  // ── GDB Server ───────────────────────────────────────────────────

  async startGDBServer(): Promise<{ success: boolean; message: string }> {
    if (this.processManager.get(GDB_SERVER_PROCESS)) {
      return { success: true, message: "GDB Server is already running" };
    }

    const args = [
      "-device", this.config.device,
      "-if", this.config.interface,
      "-speed", String(this.config.speed),
      "-port", String(this.config.gdbPort),
      "-RTTTelnetPort", String(this.config.rttTelnetPort),
      "-SWOPort", String(this.config.swoTelnetPort),
      // Note: `-singlerun` is intentionally NOT set. That flag makes
      // JLinkGDBServer exit the moment the target is reset or the GDB
      // client disconnects, which caused control-plane desync — the
      // child GDB process would still think it was connected while the
      // remote socket was dead, producing "monitor command not supported"
      // and "program has no registers now" errors. We manage server
      // lifetime explicitly via `stopGDBServer()` / `dispose()`.
      "-vd", "-noir", "-LocalhostOnly", "1", "-NoGui", "1",
    ];
    if (this.config.serialNumber) args.push("-select", `USB=${this.config.serialNumber}`);

    // Retry a probe that is busy. The usual cause is the previous session's
    // server: killed a moment ago, but the USB device is not free the instant
    // the process is signalled. One suite tearing down and the next starting
    // 2.2 s later was enough to lose the probe for an entire suite.
    let lastDetail = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const managed = this.processManager.spawn(GDB_SERVER_PROCESS, this.gdbServerExe, args);
        managed.process.stdout?.on("data", (d: Buffer) => {
          for (const line of d.toString().split("\n").filter(Boolean)) {
            log(`[GDB Server] ${line}`);
            this.gdbOutputBuffer.push(line);
            if (this.gdbOutputBuffer.length > 1000) this.gdbOutputBuffer.shift();
          }
        });
        managed.process.stderr?.on("data", (d: Buffer) => {
          for (const line of d.toString().split("\n").filter(Boolean)) {
            logError(`[GDB Server] ${line}`);
            this.gdbOutputBuffer.push(`[ERR] ${line}`);
          }
        });

        // Spawning is not starting. The server takes a moment to claim the
        // probe, and if another process still holds it, it prints "Connecting
        // to J-Link failed" and exits ~200 ms later. Returning success on the
        // spawn alone reported a running server that was already dead, and
        // the whole suite that followed ran with no GDB server and no RTT.
        const ready = await this.awaitGdbServerReady(managed);
        if (ready.ok) {
          this.setState(ProbeState.GDB_RUNNING);
          return { success: true, message: `GDB Server started on port ${this.config.gdbPort}, RTT telnet on port ${this.config.rttTelnetPort}` };
        }

        lastDetail = ready.detail;
        this.processManager.kill(GDB_SERVER_PROCESS);
        this.gdbOutputBuffer = [];
        if (attempt < 3) {
          log(`[J-Link] GDB Server did not come up (${ready.detail}); retrying (${attempt + 1}/3)`);
          await new Promise((r) => setTimeout(r, 1500));
        }
      } catch (err) {
        logError("Failed to start GDB Server", err);
        return { success: false, message: `Failed to start GDB Server: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    this.setState(ProbeState.PROBE_CONNECTED);
    return {
      success: false,
      message:
        `GDB Server failed to start after 3 attempts: ${lastDetail}. ` +
        `A J-Link serves one client at a time — check for another JLinkGDBServer or JLinkExe holding the probe.`,
    };
  }

  /**
   * Wait for the GDB server to claim the probe, or to fail trying.
   *
   * Readiness is the server's own "Waiting for GDB connection" banner. The
   * failure to watch for is the probe being held by someone else — most often
   * the previous session's server, which had been killed moments earlier but
   * had not yet released the USB device.
   */
  private awaitGdbServerReady(
    managed: { process: { once(e: string, cb: (...a: any[]) => void): void } },
    timeoutMs = 15000
  ): Promise<{ ok: boolean; detail: string }> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok: boolean, detail: string) => {
        if (done) return;
        done = true;
        clearInterval(poll);
        clearTimeout(timer);
        resolve({ ok, detail });
      };

      // The output already streams into gdbOutputBuffer, so watch that rather
      // than adding a second listener that could race with the first.
      const poll = setInterval(() => {
        const text = this.gdbOutputBuffer.join("\n");
        if (/waiting for gdb connection/i.test(text)) return finish(true, "ready");
        const failure = text.match(/(connecting to j-link failed[^\n]*|could not connect to j-link[^\n]*)/i);
        if (failure) return finish(false, failure[1].trim());
      }, 50);

      managed.process.once("exit", (code: number | null) => {
        const text = this.gdbOutputBuffer.join("\n");
        const reason = text.match(/(connecting to j-link failed[^\n]*)/i)?.[1];
        finish(false, reason
          ? `${reason.trim()} (exit code ${code}). Another process is probably holding the probe.`
          : `server exited with code ${code} before accepting connections`);
      });

      const timer = setTimeout(
        () => finish(false, `no readiness banner within ${timeoutMs} ms`),
        timeoutMs
      );
    });
  }

  stopGDBServer(): { success: boolean; message: string } {
    const killed = this.processManager.kill(GDB_SERVER_PROCESS);
    this.gdbOutputBuffer = [];
    this.rttConnected = false;
    if (killed) this.setState(ProbeState.PROBE_CONNECTED);
    return { success: true, message: killed ? "GDB Server stopped" : "GDB Server was not running" };
  }

  isGDBServerRunning(): boolean { return !!this.processManager.get(GDB_SERVER_PROCESS); }

  getGDBServerStatus(): GDBServerInfo {
    return { running: this.isGDBServerRunning(), gdbPort: this.config.gdbPort, rttTelnetPort: this.config.rttTelnetPort };
  }

  getGDBServerOutput(lines = 50): string[] { return this.gdbOutputBuffer.slice(-lines); }

  // ── Device configuration ─────────────────────────────────────────

  isDeviceConfigured(): boolean {
    return !!this.config.device && this.config.device !== "Unspecified";
  }

  getDeviceName(): string { return this.config.device; }

  setDevice(device: string): void {
    log(`[J-Link] Device set to: ${device}`);
    this.config.device = device;
  }

  async listDevices(): Promise<CommandResult> {
    // Run ShowEmuList without specifying a device to see connected probes
    const args = ["-NoGui", "1"];
    return new Promise<CommandResult>((resolve) => {
      const proc = spawn(this.jlinkExe, args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
      proc.stdin?.write("ShowEmuList\nexit\n");
      proc.stdin?.end();
      proc.on("error", (err) => {
        resolve({ success: false, rawOutput: stdout, output: stdout, error: `Failed to run JLinkExe: ${err.message}` });
      });
      proc.on("exit", (code) => {
        resolve({ success: code === 0, rawOutput: stdout, output: stripBoilerplate(stdout), error: stderr || undefined });
      });
      setTimeout(() => { proc.kill("SIGTERM"); resolve({ success: false, rawOutput: stdout, output: stdout, error: "Timed out" }); }, 10000);
    });
  }

  // ── RTT ──────────────────────────────────────────────────────────

  supportsRTT(): boolean { return true; }
  getRTTPort(): number { return this.config.rttTelnetPort; }

  /**
   * Re-point the probe at the RTT control block after a target reset.
   *
   * A reset does not stop the target logging, but it does stop J-Link
   * collecting. Measured on an nRF52840 across a reset, sampling the control
   * block from both sides:
   *
   *   WrOff (target writes): 582 -> 802
   *   RdOff (host reads):      0 ->   0
   *
   * The firmware was writing and 582 bytes sat unread in the buffer; the
   * probe had simply stopped draining it. Reconnecting the telnet client does
   * not help — that is downstream of the collector, not the collector itself.
   *
   * `SetRTTAddr` is the documented way back in: "In some cases J-Link cannot
   * locate the RTT buffer in known RAM. This command is used to set the exact
   * address manually." Issuing it restarts collection at that address.
   *
   *   https://kb.segger.com/J-Link_Command_Strings
   *
   * Requires knowing the address, which J-Link found for itself and does not
   * report back. Without one, say so rather than leaving a caller believing a
   * silent stream is a quiet target.
   */
  async restartRTT(): Promise<{ ok: boolean; detail: string }> {
    const addr = this.config.rttControlBlockAddress;
    if (addr === undefined) {
      return {
        ok: false,
        detail:
          "RTT collection stops at a target reset and cannot be restarted without the control " +
          "block address, which the probe finds by scanning RAM and does not report back. Set " +
          "JLINK_RTT_ADDR (or jlinkMcp.rtt.controlBlockAddress) to your firmware's _SEGGER_RTT " +
          "symbol to have this recovered automatically.",
      };
    }

    const cmd = `SetRTTAddr 0x${addr.toString(16)}`;
    const r = this.useGdb()
      ? await this.runViaGdb(`monitor exec ${cmd}`, 5000)
      : await this.acquireLock(() => this.execRaw([`exec ${cmd}`]));

    return r.success
      ? { ok: true, detail: `RTT collection restarted at 0x${addr.toString(16)}` }
      : { ok: false, detail: `could not restart RTT collection: ${r.error ?? "unknown error"}` };
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  dispose(): void {
    this.processManager.kill(GDB_SERVER_PROCESS);
    this.setState(ProbeState.DISCONNECTED);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
