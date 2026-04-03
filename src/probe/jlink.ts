import { spawn } from "child_process";
import { ProbeBackend, CommandResult, GDBServerInfo } from "./backend";
import { ProcessManager } from "../utils/process-manager";
import { log, logError } from "../utils/logger";
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

  /** Core execution: spawn JLinkExe with commands piped to stdin */
  private async exec(commands: string[]): Promise<CommandResult> {
    const args = [
      "-device", this.config.device,
      "-if", this.config.interface,
      "-speed", String(this.config.speed),
      "-autoconnect", "1",
      "-ExitOnError", "1",
      "-NoGui", "1",
    ];
    if (this.config.serialNumber) {
      args.push("-SelectEmuBySN", this.config.serialNumber);
    }

    log(`[J-Link] ${commands.join("; ")}`);

    return new Promise<CommandResult>((resolve) => {
      const proc = spawn(this.jlinkExe, args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "";

      proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

      proc.stdin?.write(commands.concat(["exit"]).join("\n") + "\n");
      proc.stdin?.end();

      proc.on("error", (err) => {
        logError("J-Link spawn error", err);
        resolve({ success: false, rawOutput: stdout, output: stdout, error: `Failed to spawn JLinkExe: ${err.message}` });
      });
      proc.on("exit", (code) => {
        if (code !== 0) logError(`J-Link exited with code ${code}`);
        resolve({ success: code === 0, rawOutput: stdout, output: stripBoilerplate(stdout), error: stderr || undefined });
      });

      setTimeout(() => {
        proc.kill("SIGTERM");
        resolve({ success: false, rawOutput: stdout, output: stripBoilerplate(stdout), error: "J-Link timed out after 30s" });
      }, 30000);
    });
  }

  // ── ProbeBackend implementation ──────────────────────────────────

  async getDeviceInfo(): Promise<CommandResult> { return this.exec(["halt", "regs"]); }
  async halt(): Promise<CommandResult> { return this.exec(["halt"]); }
  async resume(): Promise<CommandResult> { return this.exec(["go"]); }
  async reset(halt = false): Promise<CommandResult> { return this.exec(halt ? ["r", "halt"] : ["r", "go"]); }
  async step(): Promise<CommandResult> { return this.exec(["halt", "s"]); }

  async readMemory(address: number, length: number): Promise<CommandResult> {
    return this.exec([`mem 0x${address.toString(16)}, ${length}`]);
  }
  async writeMemory(address: number, value: number): Promise<CommandResult> {
    return this.exec([`w4 0x${address.toString(16)}, 0x${value.toString(16)}`]);
  }

  async readAllRegisters(): Promise<CommandResult> { return this.exec(["halt", "regs"]); }
  async readRegister(name: string): Promise<CommandResult> { return this.exec(["halt", `rreg ${name}`]); }

  async flash(filePath: string, baseAddress?: number): Promise<CommandResult> {
    const addr = baseAddress !== undefined ? ` 0x${baseAddress.toString(16)}` : "";
    return this.exec(["r", "halt", `loadfile ${filePath}${addr}`, "r", "go"]);
  }
  async erase(): Promise<CommandResult> { return this.exec(["erase"]); }

  async setBreakpoint(address: number): Promise<CommandResult> {
    return this.exec([`SetBP 0x${address.toString(16)}`]);
  }
  async clearBreakpoints(): Promise<CommandResult> { return this.exec(["ClrBP"]); }

  async executeRaw(commands: string[]): Promise<CommandResult> { return this.exec(commands); }

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
      "-vd", "-noir", "-LocalhostOnly", "1", "-singlerun", "-NoGui", "1",
    ];
    if (this.config.serialNumber) args.push("-select", `USB=${this.config.serialNumber}`);

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
      return { success: true, message: `GDB Server started on port ${this.config.gdbPort}, RTT telnet on port ${this.config.rttTelnetPort}` };
    } catch (err) {
      logError("Failed to start GDB Server", err);
      return { success: false, message: `Failed to start GDB Server: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  stopGDBServer(): { success: boolean; message: string } {
    const killed = this.processManager.kill(GDB_SERVER_PROCESS);
    this.gdbOutputBuffer = [];
    return { success: true, message: killed ? "GDB Server stopped" : "GDB Server was not running" };
  }

  isGDBServerRunning(): boolean { return !!this.processManager.get(GDB_SERVER_PROCESS); }

  getGDBServerStatus(): GDBServerInfo {
    return { running: this.isGDBServerRunning(), gdbPort: this.config.gdbPort, rttTelnetPort: this.config.rttTelnetPort };
  }

  getGDBServerOutput(lines = 50): string[] { return this.gdbOutputBuffer.slice(-lines); }

  // ── RTT ──────────────────────────────────────────────────────────

  supportsRTT(): boolean { return true; }
  getRTTPort(): number { return this.config.rttTelnetPort; }

  // ── Lifecycle ────────────────────────────────────────────────────

  dispose(): void {
    this.processManager.kill(GDB_SERVER_PROCESS);
  }
}
