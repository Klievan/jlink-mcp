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
/*
 * Every test here is bounded. The bug this suite guards — commands clobbering
 * one another's pending slot — shows up as commands that never settle except
 * on their own timeouts, so an unbounded test would hang CI rather than fail
 * it. Verified by removing the queue: the suite stopped producing output
 * entirely instead of reporting a failure.
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

  test("a command returns its own output, not the startup banner", { timeout: 30_000 }, async () => {
    await startBare();
    const r = await client.command("print 1+1");
    assert.match(r.output, /\$\d+ = 2/, `got: ${JSON.stringify(r.output)}`);
  });

  test("consecutive commands do not drift out of step", { timeout: 30_000 }, async () => {
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

  test("no command returns empty output", { timeout: 30_000 }, async () => {
    await startBare();
    for (const cmd of ["show version", "print 7", "info breakpoints"]) {
      const r = await client.command(cmd);
      assert.ok(r.output.trim().length > 0, `${cmd} returned nothing`);
    }
  });

  test("errors are surfaced as errors, not as silence", { timeout: 30_000 }, async () => {
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

  test("commands are refused fast while the target runs, not left to hang", { timeout: 30_000 }, async () => {
    await startBare();
    // While the target executes, a synchronous remote leaves GDB inside its
    // resume loop, not reading stdin. Waiting on a command there buys nothing
    // but the full timeout — and a timeout returns empty output, which reads
    // like a healthy quiet target rather than "halt first". Observed on
    // hardware as every command after a `continue` sitting for exactly 10s.
    (client as any).targetRunning = true;
    const started = Date.now();
    const r = await client.command("print 1");
    const elapsed = Date.now() - started;
    (client as any).targetRunning = false;

    assert.equal(r.success, false);
    assert.match(r.error ?? "", /running/i);
    assert.match(r.error ?? "", /halt/i, "the error should say what to do about it");
    assert.ok(elapsed < 1000, `took ${elapsed}ms — should refuse immediately`);
  });

  test("interrupt on an already-stopped target is a no-op, not an error", { timeout: 30_000 }, async () => {
    await startBare();
    const r = await client.interrupt(1000);
    assert.equal(r.success, true);
    assert.match(r.output, /already stopped/i);
  });

  test("concurrent commands each receive their own reply", { timeout: 30_000 }, async () => {
    await startBare();
    // Fired without awaiting in between — the shape an MCP server produces
    // when two tool calls overlap. With a single pending slot and no queue,
    // the later command overwrites the earlier one's resolver and the earlier
    // one settles on timeout with whatever was in the buffer.
    const results = await Promise.all([
      client.command("print 4001"),
      client.command("print 4002"),
      client.command("print 4003"),
      client.command("print 4004"),
    ]);
    results.forEach((r, i) => {
      assert.match(r.output, new RegExp(`= ${4001 + i}\\b`),
        `concurrent reply ${i} was ${JSON.stringify(r.output)}`);
    });
  });

  test("a command issued right after another still matches its own reply", { timeout: 30_000 }, async () => {
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
