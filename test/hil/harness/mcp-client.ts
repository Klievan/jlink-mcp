import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { repoRoot } from "../../helpers";

/**
 * Drives the real product surface: spawns `out/mcp/standalone.js` and talks to
 * it over stdio with the MCP SDK client, exactly as Claude Desktop or VSCode
 * would. Nothing here imports from `src/` except to locate files — if a tool
 * is broken end to end, these tests see it, and if the wiring in
 * `standalone.js` regresses, they see that too.
 */

const ROOT = repoRoot(__dirname);

export const FIXTURE_HEX = path.join(ROOT, "test", "hil", "fixture", "fixture.hex");

/** Ground truth for the nRF52840-DK. Values the silicon guarantees. */
export const NRF52840 = {
  device: "NRF52840_XXAA",
  /** SCB CPUID — Cortex-M4F r0p1. Constant for the part. */
  CPUID_ADDR: 0xe000ed00,
  CPUID: 0x410fc241,
  /** Nordic FICR. Offsets confirmed on first capture rather than asserted blind. */
  FICR_BASE: 0x10000000,
  FICR_INFO_PART: 0x10000100,
  FICR_DEVICEID_0: 0x10000060,
  /** SCB fault registers: CFSR, HFSR, _, MMFAR, BFAR. */
  CFSR_ADDR: 0xe000ed28,
  DHCSR_ADDR: 0xe000edf0,
  RAM_BASE: 0x20000000,
  /** Scratch word for write/read round-trips — above the fixture's counter. */
  SCRATCH: 0x20001000,
  /** Reads here must fail cleanly rather than hang or wedge the session. */
  UNMAPPED: 0xf0000000,
} as const;

export interface HilClientOptions {
  /** Extra env for the server process (e.g. JLINK_MCP_GDB_ROUTING). */
  env?: Record<string, string>;
}

export class HilClient {
  private client!: Client;
  private transport!: StdioClientTransport;
  private stderrChunks: string[] = [];
  private label: string;

  /** @param label distinguishes this client's log from other suites' */
  constructor(label = "default") {
    this.label = label;
  }

  async start(opts: HilClientOptions = {}): Promise<void> {
    const serverPath = path.join(ROOT, "out", "mcp", "standalone.js");
    if (!fs.existsSync(serverPath)) {
      throw new Error(`server not built: ${serverPath} — run 'npm run compile' first`);
    }

    this.transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      env: {
        ...(process.env as Record<string, string>),
        JLINK_DEVICE: NRF52840.device,
        ...opts.env,
      },
      // Captured rather than inherited: the server logs every J-Link and GDB
      // invocation here, which is both the transcript source for golden
      // capture and the first place to look when a hardware test fails.
      stderr: "pipe",
    });

    this.transport.stderr?.on("data", (d: Buffer) => this.stderrChunks.push(d.toString()));

    this.client = new Client({ name: "hil-harness", version: "1.0.0" }, { capabilities: {} });
    await this.client.connect(this.transport);
  }

  /** Everything the server wrote to stderr so far. */
  get stderr(): string {
    return this.stderrChunks.join("");
  }

  async listTools(): Promise<string[]> {
    const { tools } = await this.client.listTools();
    return tools.map((t) => t.name);
  }

  /**
   * Call a tool and return its text content joined.
   *
   * Deliberately does not throw on `isError` — several suites assert that a
   * tool fails *gracefully* (unmapped memory, bogus device), and the useful
   * assertion is on the message, not on an exception. Use `expectOk` when a
   * call is required to succeed.
   */
  async call(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const res = await this.client.callTool({ name, arguments: args });
    const content = (res.content ?? []) as Array<{ type: string; text?: string }>;
    return content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
  }

  /** Call a tool, failing loudly if it reports an error. */
  async expectOk(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const res = await this.client.callTool({ name, arguments: args });
    const content = (res.content ?? []) as Array<{ type: string; text?: string }>;
    const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
    if (res.isError) throw new Error(`${name} failed: ${text}`);
    return text;
  }

  async stop(): Promise<void> {
    // Always dump the server log. It carries every J-Link and GDB invocation
    // the server made, and it is the difference between diagnosing a hardware
    // failure and guessing at it — three rounds of this suite were read from
    // tool output alone because this was captured but never written out.
    if (this.stderrChunks.length) record(`server-stderr-${this.label}.log`, this.stderr);
    try {
      await this.client?.close();
    } catch {
      /* server may already be gone */
    }
  }
}

// ── Recording ──────────────────────────────────────────────────────

const RECORD = process.env.HIL_RECORD === "1";
const CAPTURE_DIR = path.join(ROOT, "test", "golden", "captured");

/**
 * Write raw tool output to `test/golden/captured/` when HIL_RECORD=1.
 *
 * This is the point of the two-tier design: the hardware run produces the
 * transcripts the unit tier replays forever after. Captures land in a
 * subdirectory rather than overwriting `test/golden/` directly, so promoting
 * a capture to a fixture stays a deliberate reviewed step and a flaky run
 * can't silently rewrite the baseline.
 */
export function record(name: string, content: string): void {
  // Server logs are always written, recording mode or not — they are
  // diagnostics, not fixtures.
  if (!RECORD && !name.startsWith("server-stderr")) return;
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CAPTURE_DIR, name), content);
}

// ── Target recovery ────────────────────────────────────────────────

/**
 * Ask the runner's recovery script to put the probe back in a known state.
 *
 * Invoked without sudo on purpose. The runner's passwordless grant is scoped
 * to /usr/local/bin/hil-power-cycle, which hil-recover calls itself when it
 * needs to cut power; running hil-recover under sudo just hits a password
 * prompt. Gated on the script existing so this still runs on a dev box.
 */
export function hilRecover(args: string[] = []): string {
  const script = "/usr/local/bin/hil-recover";
  if (!fs.existsSync(script)) return "hil-recover not present (not on the HIL runner)";
  try {
    return execFileSync(script, args, { encoding: "utf8", timeout: 120_000 });
  } catch (e: any) {
    return `hil-recover failed: ${e.stdout || ""}${e.stderr || ""}${e.message}`;
  }
}

/**
 * Put the target back to running the fixture, power-cycling if it will not.
 *
 * Suites that need a live target call this instead of assuming the previous
 * suite left one. A HardFault parked in the fixture's trap survives a plain
 * reset — round 6 lost both halt/resume suites to a single faulted target,
 * which told us nothing about the GDB path that the run was meant to
 * exercise.
 *
 * The point is not to hide a fault: the suite that owns the assertion still
 * reports it, with diagnostics. This only stops one suite's target state from
 * deciding another suite's result.
 *
 * Returns a description of what it took, so the caller can surface whether
 * recovery was needed.
 */
export async function ensureFixtureRunning(
  hil: HilClient,
  fixtureHex: string,
  resetHandler: number,
): Promise<string> {
  const attempt = async (): Promise<number | null> => {
    await hil.call("flash", { filePath: fixtureHex });
    await hil.call("reset", { halt: true });
    const regs = await hil.call("read_registers");
    return reg(regs, "PC");
  };

  const pc = await attempt();
  if (pc !== null && pc >= resetHandler && pc <= resetHandler + 0x10) return "target already healthy";

  // Cut power directly rather than asking hil-recover to escalate. The
  // runner grants passwordless sudo to hil-power-cycle specifically, and
  // hil-recover checks for root instead of using that grant — it reports
  // "cannot power-cycle (no root and no passwordless sudo)" and carries on,
  // so the escalation never actually happens from inside a test.
  //
  // A power cycle is the only thing that clears armed debug state: the debug
  // block survives the reset a probe issues, which is how a stale breakpoint
  // keeps re-triggering across resets.
  const recovery = [hilPowerCycle(), hilRecover([])].join(" | ");
  const pc2 = await attempt();
  if (pc2 !== null && pc2 >= resetHandler && pc2 <= resetHandler + 0x10) {
    return `recovered by power cycle (PC was 0x${pc?.toString(16)})`;
  }
  return `RECOVERY FAILED: PC 0x${pc?.toString(16)} then 0x${pc2?.toString(16)}. ${recovery}`;
}

/**
 * Cut power to the target's hub port.
 *
 * Invoked as `sudo -n /usr/local/bin/hil-power-cycle` — the exact binary the
 * runner grants, which hardcodes its hub and port so CI cannot cut power to
 * anything else on the bus.
 */
export function hilPowerCycle(): string {
  const script = "/usr/local/bin/hil-power-cycle";
  if (!fs.existsSync(script)) return "hil-power-cycle not present (not on the HIL runner)";
  try {
    execFileSync("sudo", ["-n", script], { encoding: "utf8", timeout: 60_000 });
    return "power cycled";
  } catch (e: any) {
    return `power cycle failed: ${e.stdout || ""}${e.stderr || ""}${e.message}`;
  }
}

/** True when running against real hardware. Suites skip themselves otherwise. */
export const ON_HIL_RUNNER = process.env.HIL === "1";

// ── Parsing helpers ────────────────────────────────────────────────

/**
 * Format an address or value the way the MCP tools want it.
 *
 * read_memory / write_memory / flash take their addresses as *hex strings*,
 * not numbers — `z.string()` in the schema, parsed with parseInt(x, 16) in the
 * handler. Passing a number gets a -32602 validation error from the SDK before
 * the tool ever runs.
 */
export function hex(n: number): string {
  return "0x" + n.toString(16);
}

/**
 * Pull a named register out of the `read_registers` compact format
 * ("Core: PC=0x000004B2 SP=0x20002C40 ...").
 */
export function reg(text: string, name: string): number | null {
  const m = text.match(new RegExp(`\\b${name}=0x([0-9A-Fa-f]+)`));
  return m ? parseInt(m[1], 16) : null;
}

/**
 * Assemble a little-endian 32-bit word from a `read_memory` hex dump.
 * Accepts both the J-Link (`ADDR = XX XX`) and GDB (`0xaddr: XX XX`) shapes,
 * since which one served the read depends on whether a GDB session is up.
 */
export function word32(dumpText: string, index = 0): number | null {
  const bytes: string[] = [];
  for (const line of dumpText.split("\n")) {
    const m = line.match(/^\s*(?:0x)?[0-9A-Fa-f]{1,8}\s*[:=]\s*((?:[0-9A-Fa-f]{2}[ ]+)*[0-9A-Fa-f]{2})/);
    if (m) bytes.push(...m[1].trim().split(/\s+/));
  }
  const o = index * 4;
  if (bytes.length < o + 4) return null;
  return (
    (parseInt(bytes[o], 16) |
      (parseInt(bytes[o + 1], 16) << 8) |
      (parseInt(bytes[o + 2], 16) << 16) |
      (parseInt(bytes[o + 3], 16) << 24)) >>> 0
  );
}
