import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { GDBClient } from "../../src/gdb/gdb-client";

function gdbAvailable(): boolean {
  try {
    execFileSync("arm-none-eabi-gdb", ["--version"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const skip = !gdbAvailable() && "arm-none-eabi-gdb not installed";

/**
 * Drives a real GDB with no target attached.
 *
 * No hardware needed — every assertion here is about the client's response
 * synchronisation, which is exactly what broke: matching completion on a bare
 * `(gdb)` prompt resolved the first command against the startup banner and
 * left every later reply off by one. On the DK that showed up as every
 * GDB-routed tool returning empty output while the server reported itself
 * healthy, which is indistinguishable from a working-but-quiet target.
 *
 * A mock cannot catch this. The bug lives in the timing and interleaving of
 * real MI output, so the test uses real MI output.
 */
describe("GDB/MI response synchronisation", { skip }, () => {
  const client = new GDBClient();
  after(() => client.disconnect());

  /** Start GDB without connecting to any remote. */
  async function startBare(): Promise<void> {
    if ((client as any).proc) {
      // Re-arm the connection flag between tests. Some of the commands below
      // legitimately trip the remote-loss detector — "The program has no
      // registers now" is one of its patterns, and in a target-less GDB that
      // is the honest answer to `info registers`. The detector is doing its
      // job; this fake session just has no reconnect path to take.
      (client as any).connected = true;
      return;
    }
    const proc = require("child_process").spawn(
      "arm-none-eabi-gdb", ["--interpreter=mi2", "--quiet", "--nx"],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    (client as any).proc = proc;
    (client as any).connected = true;
    proc.stdout.on("data", (d: Buffer) => (client as any).handleOutput(d.toString()));
    // Let the startup banner and its prompt land first — that prompt is what
    // used to satisfy the completion check before any command was sent.
    await new Promise((r) => setTimeout(r, 1200));
  }

  test("a command returns its own output, not the startup banner", async () => {
    await startBare();
    const r = await client.command("print 1+1");
    assert.match(r.output, /\$\d+ = 2/, `got: ${JSON.stringify(r.output)}`);
  });

  test("consecutive commands do not drift out of step", async () => {
    await startBare();
    // The off-by-one signature: each reply is the previous command's. Running
    // several with distinct answers catches a drift of any size.
    const a = await client.command("print 111");
    const b = await client.command("print 222");
    const c = await client.command("print 333");
    assert.match(a.output, /111/, `first reply: ${JSON.stringify(a.output)}`);
    assert.match(b.output, /222/, `second reply: ${JSON.stringify(b.output)}`);
    assert.match(c.output, /333/, `third reply: ${JSON.stringify(c.output)}`);
  });

  test("no command returns empty output", async () => {
    await startBare();
    for (const cmd of ["show version", "print 7", "info breakpoints"]) {
      const r = await client.command(cmd);
      assert.ok(r.output.trim().length > 0, `${cmd} returned nothing`);
    }
  });

  test("errors are surfaced as errors, not as silence", async () => {
    await startBare();
    // No target attached, so this must fail — and must say so. Returning an
    // empty success is the failure mode that made the hardware run look fine.
    const r = await client.command("info registers");
    assert.ok(r.output.trim().length > 0, "error response was empty");
    assert.match(r.output, /no registers|No registers|error/i);

    // And the response is recognised as remote-loss, so the next call would
    // take the reconnect path rather than returning stale nonsense.
    assert.equal(client.isConnected(), false,
      "'no registers now' should invalidate the session");
  });

  test("a command issued right after another still matches its own reply", async () => {
    await startBare();
    // Back-to-back with no gap is where a prompt-based matcher drifts.
    const results = await Promise.resolve().then(async () => {
      const out: string[] = [];
      for (let i = 0; i < 5; i++) out.push((await client.command(`print ${i * 1000}`)).output);
      return out;
    });
    results.forEach((out, i) => {
      assert.match(out, new RegExp(`= ${i * 1000}\\b`), `reply ${i}: ${JSON.stringify(out)}`);
    });
  });
});
