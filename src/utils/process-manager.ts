import { ChildProcess, spawn, SpawnOptions } from "child_process";
import { log, logError } from "./logger";
import { EventEmitter } from "events";

export interface ManagedProcess {
  process: ChildProcess;
  name: string;
  kill(): void;
}

/**
 * Manages spawned child processes with lifecycle tracking.
 */
export class ProcessManager extends EventEmitter {
  private processes = new Map<string, ManagedProcess>();

  spawn(
    name: string,
    command: string,
    args: string[],
    options?: SpawnOptions
  ): ManagedProcess {
    // Kill existing process with same name
    this.kill(name);

    log(`Spawning process "${name}": ${command} ${args.join(" ")}`);

    const proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...options,
    });

    const managed: ManagedProcess = {
      process: proc,
      name,
      kill: () => this.kill(name),
    };

    proc.on("error", (err) => {
      logError(`Process "${name}" error`, err);
      this.processes.delete(name);
      this.emit("processExit", name, null, err);
    });

    proc.on("exit", (code, signal) => {
      log(`Process "${name}" exited (code=${code}, signal=${signal})`);
      this.processes.delete(name);
      this.emit("processExit", name, code, signal);
    });

    this.processes.set(name, managed);
    return managed;
  }

  kill(name: string): boolean {
    const existing = this.processes.get(name);
    if (existing) {
      log(`Killing process "${name}" (pid=${existing.process.pid})`);
      existing.process.kill("SIGTERM");
      // Force kill after 3 seconds
      setTimeout(() => {
        try {
          existing.process.kill("SIGKILL");
        } catch {
          // already dead
        }
      }, 3000);
      this.processes.delete(name);
      return true;
    }
    return false;
  }

  get(name: string): ManagedProcess | undefined {
    return this.processes.get(name);
  }

  killAll(): void {
    for (const [name] of this.processes) {
      this.kill(name);
    }
  }

  listRunning(): string[] {
    return Array.from(this.processes.keys());
  }
}
