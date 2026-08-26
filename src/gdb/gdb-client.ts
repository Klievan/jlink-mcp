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
  /**
   * The command currently awaiting its MI result record.
   *
   * GDB/MI echoes the token you prefix a command with on that command's
   * result record (`11 info registers` -> `11^error,msg="..."`), which is the
   * only reliable way to tell one command's response from another's. Matching
   * on a bare `(gdb)` prompt or any `^done` does not work: GDB prints a prompt
   * during startup, before a single command has been sent, so the first
   * command resolves against that stale prompt with an empty buffer and every
   * subsequent reply is off by one.
   *
   * Observed on hardware as every GDB-routed tool returning empty output while
   * the server reported itself healthy.
   */
  private pending: {
    token: number;
    resolve: (response: string) => void;
    /** Run commands resolve on `*stopped`, not on `^running`. */
    waitForStop: boolean;
    sawResult: boolean;
  } | null = null;
  private tokenCounter = 0;
  /**
   * Serializes `command()` calls.
   *
   * There is one `pending` slot and one output buffer, so two commands in
   * flight at once clobber each other: the second overwrites the first's
   * resolver, and the first only ever settles on its own timeout, with
   * whatever happened to be in the buffer. MCP tool calls can genuinely
   * overlap — and the probe backend's own lock does not cover the GDB path,
   * which returns before `withPreflight` is ever reached.
   */
  private queue: Promise<unknown> = Promise.resolve();
  private stopEvent: string | null = null;
  private history: string[] = [];
  private maxHistory = 200;
  /** Saved connection params for auto-reconnect */
  private lastConnectParams: { host: string; port: number; elfFile?: string } | null = null;
  /** Minimum delay between commands to avoid overwhelming slow adapters */
  private lastCommandTime = 0;
  private commandThrottleMs = 50;

  constructor(gdbPath: string = "arm-none-eabi-gdb") {
    this.gdbPath = gdbPath;
  }

  /**
   * Patterns in GDB output that indicate the remote target has gone away
   * even though the child GDB process is still alive. When we see one of
   * these in a command response, we invalidate `connected` so the next
   * call takes the auto-reconnect path.
   *
   * Keep these narrow — a fuzzy match here causes false positives on
   * informational output and produces spurious reconnects.
   */
  private static readonly REMOTE_LOSS_PATTERNS: RegExp[] = [
    /Remote connection closed/i,
    /Remote (failure|communication) reply/i,
    /Remote communication error/i,
    /Remote replied unexpectedly/i,
    /monitor command not supported by this target/i,
    /program has no registers now/i,
    /No target selected/i,
    /Cannot execute this command (while|without) the (target|selected thread)/i,
  ];

  /**
   * Start GDB and connect to a remote target (GDB server).
   *
   * Fast-path: if the child GDB process is up and we haven't observed
   * remote-loss on a previous command, treat the session as live. We do
   * NOT actively ping — a probe here would compete with in-flight
   * asynchronous MI events (stop notifications, register updates) and
   * could time out on a perfectly healthy session, causing a needless
   * teardown. If the session is actually stale, the next real command's
   * response will match one of REMOTE_LOSS_PATTERNS and trigger the
   * auto-reconnect path in `command()`.
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
                this.lastConnectParams = { host, port, elfFile };
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
    // Queue rather than run concurrently. Settled either way so one failure
    // does not poison every later command.
    const run = this.queue.then(
      () => this.commandUnqueued(cmd, timeout),
      () => this.commandUnqueued(cmd, timeout)
    );
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async commandUnqueued(cmd: string, timeout: number): Promise<GDBResponse> {
    // Auto-reconnect if connection dropped
    if ((!this.proc || !this.connected) && this.lastConnectParams) {
      log("[GDB] Connection lost, attempting auto-reconnect...");
      const reconnect = await this.connect(
        this.lastConnectParams.host,
        this.lastConnectParams.port,
        this.lastConnectParams.elfFile
      );
      if (!reconnect.success) {
        return { success: false, output: "", error: `GDB disconnected and reconnect failed: ${reconnect.error}. Use gdb_connect to reconnect.` };
      }
      log("[GDB] Auto-reconnect succeeded");
    }

    if (!this.proc || !this.connected) {
      return { success: false, output: "", error: "GDB not connected. Use gdb_connect first." };
    }

    // Throttle rapid commands to avoid overwhelming slow adapters (e.g., ST-Link V2.1)
    const now = Date.now();
    const elapsed = now - this.lastCommandTime;
    if (elapsed < this.commandThrottleMs) {
      await new Promise((r) => setTimeout(r, this.commandThrottleMs - elapsed));
    }
    this.lastCommandTime = Date.now();

    // Detect if this is a "run" command that will make the target execute
    const isRunCommand = /^(continue|c|step|s|stepi|si|next|n|nexti|ni|finish|until|advance|run|r)\b/i.test(cmd.trim());

    // NOTE on `interrupt`: in mi2 without async-exec the CLI `interrupt`
    // and MI `-exec-interrupt` are both effectively no-ops (`-exec-interrupt`
    // requires async mode). Callers who need to stop a running target
    // through this MCP should use the `halt` tool or send
    // `monitor halt` — both go through the JLinkGDBServer monitor
    // command channel, which bypasses GDB's execution state machine.
    // Enabling `mi-async` at connect time to make interrupt work
    // natively is deferred to a follow-up (it interacts with the
    // response-detection state machine and needs care).
    this.stopEvent = null;
    const rawOutput = await this.sendCommand(cmd, isRunCommand ? timeout : 10000, isRunCommand);
    const output = this.cleanMI(rawOutput);

    // Watch for signals that the remote died mid-session. GDB itself is
    // still up (so `proc.on("exit")` didn't fire) but the socket to
    // JLinkGDBServer is gone. Flip `connected` so the next call takes
    // the auto-reconnect path instead of returning stale errors.
    if (GDBClient.REMOTE_LOSS_PATTERNS.some((p) => p.test(rawOutput))) {
      log(`[GDB] Remote loss detected in response to \`${cmd}\` — invalidating connection`);
      this.connected = false;
    }

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
    this.pending = null;
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

    const p = this.pending;
    if (!p) return;

    // Resolve only on THIS command's result record, identified by the token
    // we prefixed it with. Anything else in the buffer — startup banners,
    // stray prompts, async notifications — is not an answer to our question.
    if (!p.sawResult && new RegExp(`^${p.token}\\^(done|error|running|exit|connected)`, "m").test(this.outputBuffer)) {
      p.sawResult = true;
      const running = new RegExp(`^${p.token}\\^running`, "m").test(this.outputBuffer);
      // A run command's `^running` means "started", not "finished". Keep
      // waiting for the *stopped notification so callers of step/continue see
      // the target's actual resting state rather than racing it.
      if (!(p.waitForStop && running)) return this.settlePending();
    }

    if (p.sawResult && p.waitForStop && this.stopEvent) this.settlePending();
  }

  /** Hand the accumulated buffer to whoever is waiting and clear the slot. */
  private settlePending(): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    const response = this.outputBuffer;
    this.outputBuffer = "";
    p.resolve(response);
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

  private sendCommand(cmd: string, timeout: number, waitForStop = false): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin) {
        reject("GDB process not available");
        return;
      }

      const token = ++this.tokenCounter;
      this.outputBuffer = "";
      this.pending = { token, resolve, waitForStop, sawResult: false };

      // Record in history
      this.history.push(`> ${cmd}`);
      if (this.history.length > this.maxHistory) this.history.shift();

      log(`[GDB] > ${token} ${cmd}`);
      // MI accepts `<token> <cli command>` and echoes the token on the
      // matching result record. Verified against arm-none-eabi-gdb.
      this.proc.stdin.write(`${token} ${cmd}\n`);

      // Timeout
      setTimeout(() => {
        if (this.pending?.token === token) {
          this.pending = null;
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
