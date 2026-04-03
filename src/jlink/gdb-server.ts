import { ProcessManager, ManagedProcess } from "../utils/process-manager";
import { getConfig, getJLinkGDBServerPath } from "../utils/config";
import { log, logError } from "../utils/logger";

const GDB_SERVER_PROCESS_NAME = "jlink-gdb-server";

/**
 * Manages the JLinkGDBServer lifecycle.
 * When running, RTT is accessible via telnet on the configured RTT port.
 */
export class GDBServerManager {
  private processManager: ProcessManager;
  private outputBuffer: string[] = [];
  private maxOutputLines = 1000;

  constructor(processManager: ProcessManager) {
    this.processManager = processManager;
  }

  /** Start JLinkGDBServer */
  start(): { success: boolean; message: string } {
    const existing = this.processManager.get(GDB_SERVER_PROCESS_NAME);
    if (existing) {
      return { success: true, message: "GDB Server is already running" };
    }

    const config = getConfig();
    const gdbServerPath = getJLinkGDBServerPath(config.jlink);

    const args = [
      "-device", config.jlink.device,
      "-if", config.jlink.interface,
      "-speed", String(config.jlink.speed),
      "-port", String(config.jlink.gdbPort),
      "-RTTTelnetPort", String(config.jlink.rttTelnetPort),
      "-SWOPort", String(config.jlink.swoTelnetPort),
      "-vd",
      "-noir",
      "-LocalhostOnly", "1",
      "-singlerun",
    ];

    if (config.jlink.serialNumber) {
      args.push("-select", `USB=${config.jlink.serialNumber}`);
    }

    try {
      const managed = this.processManager.spawn(
        GDB_SERVER_PROCESS_NAME,
        gdbServerPath,
        args
      );

      managed.process.stdout?.on("data", (data: Buffer) => {
        const lines = data.toString().split("\n").filter(Boolean);
        for (const line of lines) {
          log(`[GDB Server] ${line}`);
          this.outputBuffer.push(line);
          if (this.outputBuffer.length > this.maxOutputLines) {
            this.outputBuffer.shift();
          }
        }
      });

      managed.process.stderr?.on("data", (data: Buffer) => {
        const lines = data.toString().split("\n").filter(Boolean);
        for (const line of lines) {
          logError(`[GDB Server] ${line}`);
          this.outputBuffer.push(`[ERR] ${line}`);
        }
      });

      return {
        success: true,
        message: `GDB Server started on port ${config.jlink.gdbPort}, RTT telnet on port ${config.jlink.rttTelnetPort}`,
      };
    } catch (err) {
      logError("Failed to start GDB Server", err);
      return {
        success: false,
        message: `Failed to start GDB Server: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /** Stop the GDB Server */
  stop(): { success: boolean; message: string } {
    const killed = this.processManager.kill(GDB_SERVER_PROCESS_NAME);
    this.outputBuffer = [];
    return {
      success: true,
      message: killed ? "GDB Server stopped" : "GDB Server was not running",
    };
  }

  /** Check if running */
  isRunning(): boolean {
    return !!this.processManager.get(GDB_SERVER_PROCESS_NAME);
  }

  /** Get recent output */
  getRecentOutput(lines: number = 50): string[] {
    return this.outputBuffer.slice(-lines);
  }

  /** Get status info */
  getStatus(): {
    running: boolean;
    gdbPort: number;
    rttTelnetPort: number;
    swoTelnetPort: number;
  } {
    const config = getConfig();
    return {
      running: this.isRunning(),
      gdbPort: config.jlink.gdbPort,
      rttTelnetPort: config.jlink.rttTelnetPort,
      swoTelnetPort: config.jlink.swoTelnetPort,
    };
  }
}
