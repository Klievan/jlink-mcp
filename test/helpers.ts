import * as fs from "fs";
import * as path from "path";
import { ProbeBackend, ProbeType, CommandResult, GDBServerInfo, GdbBridge } from "../src/probe/backend";

/**
 * Tests run from `out-test/test/`, but the golden transcripts live in the
 * source tree and are deliberately not copied into the build output — they
 * are inputs, not artifacts, and a copy step is one more place for them to
 * drift. Walk up to the package root instead so this resolves the same way
 * whether the caller is compiled or not.
 */
export function repoRoot(start: string = __dirname): string {
  let dir = start;
  while (!fs.existsSync(path.join(dir, "package.json"))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`could not locate package.json above ${start}`);
    dir = parent;
  }
  return dir;
}

const GOLDEN_DIR = path.join(repoRoot(__dirname), "test", "golden");

/** Read a golden transcript verbatim. Never trim — whitespace is under test. */
export function golden(name: string): string {
  return fs.readFileSync(path.join(GOLDEN_DIR, name), "utf8");
}

/**
 * Records every command sent, and replies from a scripted table.
 *
 * Keys are matched as a prefix of the command, longest key first, so
 * `"info registers"` and `"info all-registers"` can coexist. An unmatched
 * command yields an empty successful response rather than throwing — tests
 * that care assert on `sent`.
 */
export class FakeGdbBridge implements GdbBridge {
  readonly sent: string[] = [];
  /** Records out-of-band interrupts separately from stdin commands. */
  interruptCount = 0;
  /** When false, interrupt() reports failure so halt() takes its fallback. */
  interruptSucceeds = true;
  private connected: boolean;
  private replies: Record<string, string>;

  constructor(replies: Record<string, string> = {}, connected = true) {
    this.replies = replies;
    this.connected = connected;
  }

  async interrupt(): Promise<{ success: boolean; output: string; error?: string }> {
    this.interruptCount++;
    return this.interruptSucceeds
      ? { success: true, output: "Target stopped: interrupted" }
      : { success: false, output: "", error: "did not stop" };
  }

  setConnected(v: boolean): void { this.connected = v; }
  isConnected(): boolean { return this.connected; }

  async command(cmd: string): Promise<{ success: boolean; output: string; error?: string }> {
    this.sent.push(cmd);
    const key = Object.keys(this.replies)
      .filter((k) => cmd.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    return { success: true, output: key ? this.replies[key] : "" };
  }
}

/**
 * A ProbeBackend with every abstract member stubbed out, so the shared
 * parsing utilities on the base class can be tested without dragging in a
 * concrete backend (and its process spawning).
 */
export class StubBackend extends ProbeBackend {
  readonly type: ProbeType = "jlink";
  readonly displayName = "Stub Probe";

  /** Queue of results `readMemory` will return, in order. */
  memoryResponses: CommandResult[] = [];

  private ok(output = ""): CommandResult {
    return { success: true, rawOutput: output, output };
  }

  async getDeviceInfo(): Promise<CommandResult> { return this.ok(); }
  async halt(): Promise<CommandResult> { return this.ok(); }
  async resume(): Promise<CommandResult> { return this.ok(); }
  async reset(): Promise<CommandResult> { return this.ok(); }
  async step(): Promise<CommandResult> { return this.ok(); }
  async readMemory(_address: number, _length: number): Promise<CommandResult> {
    return this.memoryResponses.shift() ?? this.ok();
  }
  // Declared with its real parameters so subclasses can override it. The
  // no-arg form typechecked as a stub but made any override incompatible.
  async writeMemory(_address: number, _value: number): Promise<CommandResult> { return this.ok(); }
  async readAllRegisters(): Promise<CommandResult> { return this.ok(); }
  async readRegister(): Promise<CommandResult> { return this.ok(); }
  async flash(): Promise<CommandResult> { return this.ok(); }
  async erase(): Promise<CommandResult> { return this.ok(); }
  async setBreakpoint(): Promise<CommandResult> { return this.ok(); }
  async clearBreakpoints(): Promise<CommandResult> { return this.ok(); }
  async startGDBServer(): Promise<{ success: boolean; message: string }> {
    return { success: true, message: "" };
  }
  stopGDBServer(): { success: boolean; message: string } { return { success: true, message: "" }; }
  isGDBServerRunning(): boolean { return false; }
  getGDBServerStatus(): GDBServerInfo { return { running: false, gdbPort: 2331, rttTelnetPort: 19021 }; }
  getGDBServerOutput(): string[] { return []; }
  async executeRaw(): Promise<CommandResult> { return this.ok(); }
  isDeviceConfigured(): boolean { return true; }
  getDeviceName(): string { return "NRF52840_XXAA"; }
  setDevice(): void { /* no-op */ }
  async listDevices(): Promise<CommandResult> { return this.ok(); }
  dispose(): void { /* no-op */ }
}
