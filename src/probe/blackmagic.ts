import { spawn } from "child_process";
import { ProbeBackend, CommandResult, GDBServerInfo } from "./backend";
import { ProcessManager } from "../utils/process-manager";
import { log, logError } from "../utils/logger";

export interface BlackMagicConfig {
  /** Path to GDB binary (arm-none-eabi-gdb) */
  gdbPath: string;
  /** Serial port for BMP (e.g., "/dev/ttyACM0", "/dev/cu.usbmodem*") */
  serialPort: string;
  /** Target index when scanning (default 1) */
  targetIndex: number;
  /** GDB port if using networked BMP */
  gdbPort: number;
}

/**
 * Black Magic Probe backend.
 * BMP is unique: it has a built-in GDB server on a serial port.
 * We interact with it by running arm-none-eabi-gdb with commands.
 * No separate GDB server process is needed.
 */
export class BlackMagicBackend extends ProbeBackend {
  readonly type = "blackmagic" as const;
  readonly displayName = "Black Magic Probe";

  private config: BlackMagicConfig;
  private processManager: ProcessManager;

  constructor(config: Partial<BlackMagicConfig>, processManager: ProcessManager) {
    super();
    this.processManager = processManager;
    this.config = {
      gdbPath: config.gdbPath || "arm-none-eabi-gdb",
      serialPort: config.serialPort || "/dev/ttyACM0",
      targetIndex: config.targetIndex || 1,
      gdbPort: config.gdbPort || 2331,
    };
  }

  /** Execute GDB commands against the Black Magic Probe */
  private async gdbExec(gdbCommands: string[]): Promise<CommandResult> {
    const fullCommands = [
      `target extended-remote ${this.config.serialPort}`,
      "monitor version",
      `monitor swdp_scan`,
      `attach ${this.config.targetIndex}`,
      ...gdbCommands,
      "detach",
      "quit",
    ];

    // Write commands to a temp batch
    const batchContent = fullCommands.join("\n");

    const args = [
      "--batch",
      "--nx",
      "-ex", `target extended-remote ${this.config.serialPort}`,
      "-ex", `monitor swdp_scan`,
      "-ex", `attach ${this.config.targetIndex}`,
    ];
    for (const cmd of gdbCommands) {
      args.push("-ex", cmd);
    }
    args.push("-ex", "detach", "-ex", "quit");

    log(`[BMP] ${gdbCommands.join("; ")}`);

    return new Promise<CommandResult>((resolve) => {
      const proc = spawn(this.config.gdbPath, args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "";

      proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
      proc.on("error", (err) => {
        resolve({ success: false, rawOutput: stdout, output: stdout, error: `Failed to spawn GDB: ${err.message}` });
      });
      proc.on("exit", (code) => {
        resolve({ success: code === 0, rawOutput: stdout, output: stdout, error: stderr || undefined });
      });

      setTimeout(() => { proc.kill("SIGTERM"); resolve({ success: false, rawOutput: stdout, output: stdout, error: "GDB timed out" }); }, 30000);
    });
  }

  // ── ProbeBackend implementation ──────────────────────────────────

  async getDeviceInfo(): Promise<CommandResult> {
    return this.gdbExec(["info target", "info registers"]);
  }

  async halt(): Promise<CommandResult> { return this.gdbExec(["monitor halt"]); }
  async resume(): Promise<CommandResult> { return this.gdbExec(["continue &"]); }
  async reset(halt = false): Promise<CommandResult> {
    return this.gdbExec([halt ? "monitor reset halt" : "monitor reset"]);
  }
  async step(): Promise<CommandResult> { return this.gdbExec(["stepi"]); }

  async readMemory(address: number, length: number): Promise<CommandResult> {
    const wordCount = Math.ceil(length / 4);
    return this.gdbExec([`x/${wordCount}xw 0x${address.toString(16)}`]);
  }
  async writeMemory(address: number, value: number): Promise<CommandResult> {
    return this.gdbExec([`set *(unsigned int *)0x${address.toString(16)} = 0x${value.toString(16)}`]);
  }

  async readAllRegisters(): Promise<CommandResult> { return this.gdbExec(["info registers"]); }
  async readRegister(name: string): Promise<CommandResult> { return this.gdbExec([`info register ${name}`]); }

  async flash(filePath: string, baseAddress?: number): Promise<CommandResult> {
    const loadCmd = baseAddress !== undefined
      ? `load ${filePath} 0x${baseAddress.toString(16)}`
      : `load ${filePath}`;
    return this.gdbExec([loadCmd, "compare-sections"]);
  }
  async erase(): Promise<CommandResult> { return this.gdbExec(["monitor erase_mass"]); }

  async setBreakpoint(address: number): Promise<CommandResult> {
    return this.gdbExec([`hbreak *0x${address.toString(16)}`]);
  }
  async clearBreakpoints(): Promise<CommandResult> { return this.gdbExec(["delete breakpoints"]); }

  async executeRaw(commands: string[]): Promise<CommandResult> { return this.gdbExec(commands); }

  // ── GDB Server (BMP has built-in GDB server on serial port) ──────

  async startGDBServer(): Promise<{ success: boolean; message: string }> {
    // BMP doesn't need a separate GDB server - it IS the GDB server
    return { success: true, message: `BMP GDB server is built-in at ${this.config.serialPort}` };
  }

  stopGDBServer(): { success: boolean; message: string } {
    return { success: true, message: "BMP GDB server is built-in (nothing to stop)" };
  }

  isGDBServerRunning(): boolean {
    // BMP is always "running" if the serial port exists
    return true;
  }

  getGDBServerStatus(): GDBServerInfo {
    return { running: true, gdbPort: 0, rttTelnetPort: -1 };
  }

  getGDBServerOutput(_lines = 50): string[] { return ["BMP uses built-in GDB server on serial port"]; }

  supportsRTT(): boolean { return false; }

  dispose(): void { /* nothing to clean up */ }
}
