import { ChildProcess, spawn } from "child_process";
import { log, logError } from "../utils/logger";

export interface GDBResponse {
  success: boolean;
  output: string;
  /** If the target stopped, why (breakpoint, signal, exit, etc.) */
  stopReason?: string;
  error?: string;
}

/**
 * Persistent GDB client that connects to a running GDB server.
 * Maintains a long-lived arm-none-eabi-gdb process and sends commands
 * via stdin, reading responses from stdout.
 *
 * This bridges the gap between GDB's interactive model and MCP's
 * request/response model. Each command blocks until GDB produces
 * a complete response or times out.
 */
export class GDBClient {
  private proc: ChildProcess | null = null;
  private gdbPath: string;
  private connected = false;
  private outputBuffer = "";
  private pendingResolve: ((response: string) => void) | null = null;
  private stopEvent: string | null = null;
  private history: string[] = [];
  private maxHistory = 200;

  constructor(gdbPath: string = "arm-none-eabi-gdb") {
    this.gdbPath = gdbPath;
  }

  /**
   * Start GDB and connect to a remote target (GDB server).
   */
  async connect(host: string = "localhost", port: number = 2331, elfFile?: string): Promise<GDBResponse> {
    if (this.connected && this.proc) {
      return { success: true, output: "GDB already connected" };
    }

    const args = ["--interpreter=mi2", "--quiet", "--nx"];
    if (elfFile) args.push(elfFile);

    log(`[GDB] Starting: ${this.gdbPath} ${args.join(" ")}`);

    return new Promise((resolve) => {
      this.proc = spawn(this.gdbPath, args, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.outputBuffer = "";
      this.stopEvent = null;

      this.proc.stdout?.on("data", (data: Buffer) => {
        this.handleOutput(data.toString());
      });

      this.proc.stderr?.on("data", (data: Buffer) => {
        const text = data.toString();
        log(`[GDB stderr] ${text.trim()}`);
      });

      this.proc.on("error", (err) => {
        logError("GDB process error", err);
        this.connected = false;
        resolve({ success: false, output: "", error: `Failed to start GDB: ${err.message}. Is ${this.gdbPath} installed?` });
      });

      this.proc.on("exit", (code) => {
        log(`[GDB] Process exited with code ${code}`);
        this.connected = false;
        this.proc = null;
      });

      // Wait for GDB to be ready, then connect to remote target
      const waitForReady = () => {
        const checkInterval = setInterval(() => {
          if (this.outputBuffer.includes("(gdb)")) {
            clearInterval(checkInterval);
            this.outputBuffer = "";
            // Now send the connect command
            this.sendCommand(`target remote ${host}:${port}`, 15000).then((connectResult) => {
              if (connectResult.includes("Remote debugging") || connectResult.includes("connected") || connectResult.includes("stopped")) {
                this.connected = true;
                resolve({ success: true, output: `Connected to GDB server at ${host}:${port}\n${this.cleanMI(connectResult)}` });
              } else {
                resolve({ success: false, output: this.cleanMI(connectResult), error: "Failed to connect to GDB server" });
              }
            });
          }
        }, 100);

        // Timeout waiting for GDB startup
        setTimeout(() => {
          clearInterval(checkInterval);
          if (!this.connected) {
            resolve({ success: false, output: this.outputBuffer, error: `GDB did not start within timeout. Output: ${this.outputBuffer.slice(0, 200)}` });
          }
        }, 8000);
      };
      waitForReady();
    });
  }

  /**
   * Send a GDB command and wait for the response.
   *
   * For commands that cause the target to run (continue, step, next, until, finish),
   * this will wait up to `timeout` ms for the target to stop.
   * If the target doesn't stop in time, returns with a "target running" message.
   */
  async command(cmd: string, timeout: number = 15000): Promise<GDBResponse> {
    if (!this.proc || !this.connected) {
      return { success: false, output: "", error: "GDB not connected. Use gdb_connect first." };
    }

    // Detect if this is a "run" command that will make the target execute
    const isRunCommand = /^(continue|c|step|s|stepi|si|next|n|nexti|ni|finish|until|advance|run|r)\b/i.test(cmd.trim());

    this.stopEvent = null;
    const rawOutput = await this.sendCommand(cmd, isRunCommand ? timeout : 10000);
    const output = this.cleanMI(rawOutput);

    // For run commands, check if we got a stop event
    if (isRunCommand) {
      if (this.stopEvent) {
        return {
          success: true,
          output,
          stopReason: this.stopEvent,
        };
      }
      // Check if target is still running (we timed out waiting)
      if (rawOutput.includes("^running") && !rawOutput.includes("*stopped")) {
        return {
          success: true,
          output: `Target is running. Use gdb_wait to poll for stop events.\nLast output: ${output}`,
          stopReason: "running",
        };
      }
    }

    const success = !rawOutput.includes("^error");
    const errorMatch = rawOutput.match(/\^error,msg="([^"]*)"/);

    return {
      success,
      output,
      error: errorMatch ? errorMatch[1] : undefined,
      stopReason: this.stopEvent || undefined,
    };
  }

  /**
   * Wait for the target to stop (after a continue/step that timed out).
   * Call this to poll after gdb_command returned "target running".
   */
  async wait(timeout: number = 30000): Promise<GDBResponse> {
    if (!this.proc || !this.connected) {
      return { success: false, output: "", error: "GDB not connected" };
    }

    // Check if we already have a pending stop
    if (this.stopEvent) {
      const reason = this.stopEvent;
      this.stopEvent = null;
      return { success: true, output: `Target stopped: ${reason}`, stopReason: reason };
    }

    // Wait for a stop event
    return new Promise((resolve) => {
      const startTime = Date.now();
      const check = () => {
        if (this.stopEvent) {
          const reason = this.stopEvent;
          this.stopEvent = null;
          resolve({ success: true, output: `Target stopped: ${reason}`, stopReason: reason });
          return;
        }
        if (Date.now() - startTime > timeout) {
          resolve({ success: true, output: "Target still running (timeout)", stopReason: "running" });
          return;
        }
        setTimeout(check, 100);
      };
      check();
    });
  }

  /** Load an ELF file for symbol-aware debugging */
  async loadSymbols(elfPath: string): Promise<GDBResponse> {
    return this.command(`file ${elfPath}`);
  }

  /** Get a backtrace */
  async backtrace(full: boolean = false): Promise<GDBResponse> {
    return this.command(full ? "bt full" : "bt");
  }

  /** List threads (useful for RTOS debugging) */
  async listThreads(): Promise<GDBResponse> {
    return this.command("info threads");
  }

  /** Read a C variable by name (requires debug symbols) */
  async readVariable(name: string): Promise<GDBResponse> {
    return this.command(`print ${name}`);
  }

  /** Get recent command history */
  getHistory(count: number = 20): string[] {
    return this.history.slice(-count);
  }

  /** Check if connected */
  isConnected(): boolean {
    return this.connected && !!this.proc;
  }

  /** Disconnect and kill GDB process */
  disconnect(): void {
    if (this.proc) {
      try {
        this.proc.stdin?.write("quit\n");
      } catch { /* ignore */ }
      setTimeout(() => {
        try { this.proc?.kill("SIGTERM"); } catch { /* ignore */ }
      }, 1000);
      this.proc = null;
    }
    this.connected = false;
    this.outputBuffer = "";
    this.pendingResolve = null;
    this.stopEvent = null;
  }

  // ── Internal ─────────────────────────────────────────────────────

  private handleOutput(text: string): void {
    this.outputBuffer += text;

    // Detect stop events from GDB/MI async notifications
    // *stopped,reason="breakpoint-hit",bkptno="1",...
    // *stopped,reason="end-stepping-range",...
    // *stopped,reason="signal-received",signal-name="SIGTRAP",...
    const stopMatch = text.match(/\*stopped,reason="([^"]*)"/);
    if (stopMatch) {
      this.stopEvent = this.formatStopReason(text);
      log(`[GDB] Stop event: ${this.stopEvent}`);
    }

    // If someone is waiting for a response, check if we have a prompt
    if (this.pendingResolve && this.isResponseComplete()) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      const response = this.outputBuffer;
      this.outputBuffer = "";
      resolve(response);
    }
  }

  private isResponseComplete(): boolean {
    // GDB/MI: response is complete when we see (gdb) prompt
    // or a result record (^done, ^error, ^running, ^exit)
    return this.outputBuffer.includes("(gdb)") ||
           /\^(done|error|running|exit)/.test(this.outputBuffer);
  }

  private formatStopReason(miOutput: string): string {
    const reason = miOutput.match(/reason="([^"]*)"/)?.[1] || "unknown";
    const parts: string[] = [reason];

    // Extract useful fields
    const func = miOutput.match(/func="([^"]*)"/)?.[1];
    const file = miOutput.match(/file="([^"]*)"/)?.[1];
    const line = miOutput.match(/line="([^"]*)"/)?.[1];
    const addr = miOutput.match(/addr="([^"]*)"/)?.[1];
    const bkptno = miOutput.match(/bkptno="([^"]*)"/)?.[1];
    const signalName = miOutput.match(/signal-name="([^"]*)"/)?.[1];

    if (bkptno) parts.push(`breakpoint #${bkptno}`);
    if (signalName) parts.push(`signal ${signalName}`);
    if (func) parts.push(`at ${func}()`);
    if (file && line) parts.push(`${file}:${line}`);
    else if (addr) parts.push(`at ${addr}`);

    return parts.join(" ");
  }

  private sendCommand(cmd: string, timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin) {
        reject("GDB process not available");
        return;
      }

      this.outputBuffer = "";
      this.pendingResolve = resolve;

      // Record in history
      this.history.push(`> ${cmd}`);
      if (this.history.length > this.maxHistory) this.history.shift();

      log(`[GDB] > ${cmd}`);
      this.proc.stdin.write(cmd + "\n");

      // Timeout
      setTimeout(() => {
        if (this.pendingResolve === resolve) {
          this.pendingResolve = null;
          const partial = this.outputBuffer;
          this.outputBuffer = "";
          // Record partial output in history
          if (partial.trim()) {
            this.history.push(this.cleanMI(partial));
          }
          resolve(partial); // Return what we have, don't reject
        }
      }, timeout);
    });
  }

  private waitForPrompt(timeout: number): Promise<string> {
    return this.sendCommand("", timeout);
  }

  /** Clean GDB/MI output into human-readable text */
  private cleanMI(raw: string): string {
    const lines: string[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === "(gdb)") continue;

      // Strip MI prefix markers
      // ~"text\n" → text  (console output)
      const consoleMatch = trimmed.match(/^~"(.*)"$/);
      if (consoleMatch) {
        lines.push(consoleMatch[1].replace(/\\n$/, "").replace(/\\t/g, "\t").replace(/\\"/g, '"'));
        continue;
      }

      // &"text\n" → skip (log/debug output)
      if (trimmed.startsWith('&"')) continue;

      // ^done → skip
      if (trimmed.startsWith("^done") && trimmed.length < 10) continue;
      // ^running → note it
      if (trimmed === "^running") { lines.push("(target running)"); continue; }

      // ^error,msg="..." → extract error
      const errorMatch = trimmed.match(/\^error,msg="(.*)"/);
      if (errorMatch) { lines.push(`Error: ${errorMatch[1].replace(/\\"/g, '"')}`); continue; }

      // *stopped,reason="..." → format nicely
      if (trimmed.startsWith("*stopped")) {
        lines.push(`Stopped: ${this.formatStopReason(trimmed)}`);
        continue;
      }

      // =thread-group-* → skip
      if (trimmed.startsWith("=")) continue;

      // ^done,value="..." → extract value
      const valueMatch = trimmed.match(/\^done,value="(.*)"/);
      if (valueMatch) { lines.push(valueMatch[1].replace(/\\"/g, '"').replace(/\\n/g, "\n")); continue; }

      // Anything else — pass through
      if (!trimmed.startsWith("^done")) {
        lines.push(trimmed);
      }
    }

    const result = lines.join("\n").trim();
    // Record in history
    if (result) {
      this.history.push(result);
      if (this.history.length > this.maxHistory) this.history.shift();
    }
    return result;
  }
}
