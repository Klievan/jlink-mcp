import { spawn } from "child_process";
import * as net from "net";
import { ProbeBackend, CommandResult, GDBServerInfo } from "./backend";
import { ProcessManager } from "../utils/process-manager";
import { log, logError } from "../utils/logger";

export interface OpenOCDConfig {
  /** Path to openocd binary */
  binaryPath: string;
  /** OpenOCD interface config (e.g., "interface/stlink.cfg", "interface/cmsis-dap.cfg") */
  interfaceConfig: string;
  /** OpenOCD target config (e.g., "target/stm32f4x.cfg", "target/nrf52.cfg") */
  targetConfig: string;
  /** Extra OpenOCD config files */
  extraConfigs: string[];
  /** GDB port */
  gdbPort: number;
  /** Telnet port (for OpenOCD commands) */
  telnetPort: number;
  /** TCL port */
  tclPort: number;
}

const OPENOCD_PROCESS = "openocd-server";

/**
 * OpenOCD backend. Supports ST-Link, CMSIS-DAP, FTDI, and many other adapters.
 * Uses OpenOCD's telnet interface for commands when the server is running,
 * or spawns one-shot openocd processes for individual commands.
 */
export class OpenOCDBackend extends ProbeBackend {
  readonly type = "openocd" as const;
  readonly displayName = "OpenOCD";

  private config: OpenOCDConfig;
  private processManager: ProcessManager;
  private gdbOutputBuffer: string[] = [];

  constructor(config: Partial<OpenOCDConfig>, processManager: ProcessManager) {
    super();
    this.processManager = processManager;
    this.config = {
      binaryPath: config.binaryPath || "openocd",
      interfaceConfig: config.interfaceConfig || "interface/stlink.cfg",
      targetConfig: config.targetConfig || "target/stm32f4x.cfg",
      extraConfigs: config.extraConfigs || [],
      gdbPort: config.gdbPort || 3333,
      telnetPort: config.telnetPort || 4444,
      tclPort: config.tclPort || 6666,
    };
  }

  /** Send a command via OpenOCD's telnet interface (when server is running) */
  private async telnetCommand(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let response = "";

      socket.connect(this.config.telnetPort, "127.0.0.1", () => {
        // Wait for prompt then send command
        setTimeout(() => {
          socket.write(command + "\n");
          setTimeout(() => {
            socket.write("exit\n");
          }, 500);
        }, 200);
      });

      socket.on("data", (data) => { response += data.toString(); });
      socket.on("close", () => { resolve(response); });
      socket.on("error", (err) => { reject(err); });

      setTimeout(() => { socket.destroy(); resolve(response); }, 5000);
    });
  }

  /** Execute OpenOCD commands. If server is running, uses telnet. Otherwise spawns a one-shot process. */
  private async exec(ocdCommands: string[]): Promise<CommandResult> {
    if (this.isGDBServerRunning()) {
      // Use telnet interface
      try {
        const results: string[] = [];
        for (const cmd of ocdCommands) {
          const resp = await this.telnetCommand(cmd);
          results.push(resp);
        }
        const output = results.join("\n");
        return { success: true, rawOutput: output, output };
      } catch (err) {
        return { success: false, rawOutput: "", output: "", error: `Telnet error: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    // One-shot: spawn openocd with -c commands
    const args = this.buildConfigArgs();
    for (const cmd of ocdCommands) {
      args.push("-c", cmd);
    }
    args.push("-c", "shutdown");

    log(`[OpenOCD] ${ocdCommands.join("; ")}`);

    return new Promise<CommandResult>((resolve) => {
      const proc = spawn(this.config.binaryPath, args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "";

      proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
      proc.on("error", (err) => {
        resolve({ success: false, rawOutput: stdout, output: stdout, error: `Failed to spawn openocd: ${err.message}` });
      });
      proc.on("exit", (code) => {
        // OpenOCD outputs to stderr by default
        const combined = stdout + stderr;
        resolve({ success: code === 0, rawOutput: combined, output: combined, error: code !== 0 ? stderr : undefined });
      });

      setTimeout(() => { proc.kill("SIGTERM"); resolve({ success: false, rawOutput: stdout, output: stdout, error: "OpenOCD timed out" }); }, 30000);
    });
  }

  private buildConfigArgs(): string[] {
    const args: string[] = [];
    args.push("-f", this.config.interfaceConfig);
    args.push("-f", this.config.targetConfig);
    for (const cfg of this.config.extraConfigs) {
      args.push("-f", cfg);
    }
    return args;
  }

  // ── ProbeBackend implementation ──────────────────────────────────

  async getDeviceInfo(): Promise<CommandResult> {
    return this.exec(["init", "targets", "halt", "reg"]);
  }

  async halt(): Promise<CommandResult> { return this.exec(["halt"]); }
  async resume(): Promise<CommandResult> { return this.exec(["resume"]); }
  async reset(halt = false): Promise<CommandResult> {
    return this.exec([halt ? "reset halt" : "reset run"]);
  }
  async step(): Promise<CommandResult> { return this.exec(["step"]); }

  async readMemory(address: number, length: number): Promise<CommandResult> {
    // OpenOCD: mdw (32-bit words) or mdb (bytes)
    const wordCount = Math.ceil(length / 4);
    return this.exec([`mdw 0x${address.toString(16)} ${wordCount}`]);
  }
  async writeMemory(address: number, value: number): Promise<CommandResult> {
    return this.exec([`mww 0x${address.toString(16)} 0x${value.toString(16)}`]);
  }

  async readAllRegisters(): Promise<CommandResult> { return this.exec(["halt", "reg"]); }
  async readRegister(name: string): Promise<CommandResult> { return this.exec(["halt", `reg ${name}`]); }

  async flash(filePath: string, baseAddress?: number): Promise<CommandResult> {
    const addr = baseAddress !== undefined ? `0x${baseAddress.toString(16)}` : "";
    const writeCmd = addr
      ? `flash write_image erase ${filePath} ${addr}`
      : `program ${filePath} verify reset`;
    return this.exec(["init", "halt", writeCmd]);
  }
  async erase(): Promise<CommandResult> {
    return this.exec(["init", "halt", "flash erase_sector 0 0 last"]);
  }

  async setBreakpoint(address: number): Promise<CommandResult> {
    return this.exec([`bp 0x${address.toString(16)} 2 hw`]);
  }
  async clearBreakpoints(): Promise<CommandResult> { return this.exec(["rbp all"]); }

  async executeRaw(commands: string[]): Promise<CommandResult> { return this.exec(commands); }

  // ── GDB Server ───────────────────────────────────────────────────

  async startGDBServer(): Promise<{ success: boolean; message: string }> {
    if (this.processManager.get(OPENOCD_PROCESS)) {
      return { success: true, message: "OpenOCD is already running" };
    }

    const args = this.buildConfigArgs();
    args.push("-c", `gdb_port ${this.config.gdbPort}`);
    args.push("-c", `telnet_port ${this.config.telnetPort}`);
    args.push("-c", `tcl_port ${this.config.tclPort}`);

    try {
      const managed = this.processManager.spawn(OPENOCD_PROCESS, this.config.binaryPath, args);
      managed.process.stdout?.on("data", (d: Buffer) => {
        for (const line of d.toString().split("\n").filter(Boolean)) {
          log(`[OpenOCD] ${line}`);
          this.gdbOutputBuffer.push(line);
          if (this.gdbOutputBuffer.length > 1000) this.gdbOutputBuffer.shift();
        }
      });
      managed.process.stderr?.on("data", (d: Buffer) => {
        for (const line of d.toString().split("\n").filter(Boolean)) {
          log(`[OpenOCD] ${line}`); // OpenOCD uses stderr for normal output
          this.gdbOutputBuffer.push(line);
          if (this.gdbOutputBuffer.length > 1000) this.gdbOutputBuffer.shift();
        }
      });
      return { success: true, message: `OpenOCD started: GDB on port ${this.config.gdbPort}, telnet on port ${this.config.telnetPort}` };
    } catch (err) {
      return { success: false, message: `Failed to start OpenOCD: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  stopGDBServer(): { success: boolean; message: string } {
    const killed = this.processManager.kill(OPENOCD_PROCESS);
    this.gdbOutputBuffer = [];
    return { success: true, message: killed ? "OpenOCD stopped" : "OpenOCD was not running" };
  }

  isGDBServerRunning(): boolean { return !!this.processManager.get(OPENOCD_PROCESS); }

  getGDBServerStatus(): GDBServerInfo {
    return { running: this.isGDBServerRunning(), gdbPort: this.config.gdbPort, rttTelnetPort: -1 };
  }

  getGDBServerOutput(lines = 50): string[] { return this.gdbOutputBuffer.slice(-lines); }

  supportsRTT(): boolean { return false; }

  isDeviceConfigured(): boolean {
    return !!this.config.targetConfig && this.config.targetConfig !== "";
  }
  getDeviceName(): string { return this.config.targetConfig; }
  setDevice(device: string): void { this.config.targetConfig = device; }
  async listDevices(): Promise<CommandResult> {
    return this.exec(["init", "targets"]);
  }

  dispose(): void { this.processManager.kill(OPENOCD_PROCESS); }
}
