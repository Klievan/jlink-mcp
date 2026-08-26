import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { HilClient, ON_HIL_RUNNER, record, reg, word32, hex, FIXTURE_HEX, ensureFixtureRunning } from "./harness/mcp-client";
import { repoRoot } from "../helpers";
import * as path from "path";

const { FIXTURE } = require(path.join(repoRoot(__dirname), "test", "hil", "fixture", "build-fixture.js"));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const skip = !ON_HIL_RUNNER && "requires HIL=1";

/**
 * S2a — the JLinkExe path, where CPU state does NOT survive between calls.
 *
 * Each tool call on this path spawns a fresh JLinkExe, runs its script and
 * exits; the core resumes when that process detaches. So "halt, then read the
 * registers" is two independent attach/detach cycles with free-running
 * execution in between, and the halt does not carry.
 *
 * Observed on hardware: reset(halt) then read_registers reports PC inside the
 * spin loop rather than at the reset vector, and CycleCnt advances by millions
 * of cycles between consecutive reads. Stepping appears to do nothing because
 * the core ran away and was re-halted somewhere else.
 *
 * These tests pin that behaviour rather than wish it away. It is the reason
 * CPU control routes through a GDB session when one is up (S2b) — the only
 * configuration where the halt/inspect/step contract actually holds.
 */
describe("S2a — JLinkExe path: state does not persist between calls", { skip }, () => {
  const hil = new HilClient("s02a-jlinkexe");
  before(async () => {
    await hil.start();
    await hil.expectOk("flash", { filePath: FIXTURE_HEX });
  });
  after(async () => { await hil.stop(); });

  test("the target runs the fixture at all", async () => {
    // Weakest useful assertion, and the one that must hold: the core is
    // executing our image, so PC sits in the reset handler region.
    await hil.expectOk("reset", { halt: false });
    await sleep(200);
    const regs = await hil.expectOk("read_registers");
    record("hil-registers-freerun.txt", regs);

    const pc = reg(regs, "PC")!;
    if (pc >= FIXTURE.RESET_HANDLER && pc <= FIXTURE.RESET_HANDLER + 0x10) return;

    // Landed somewhere else. If it is the fixture's fault trap, the target
    // took an exception on its way through the reset handler — say which one
    // and where, instead of just reporting an unexpected PC. This has been
    // seen intermittently with an identical image, so the run that reproduces
    // it needs to carry the evidence with it.
    const detail: string[] = [`PC 0x${pc.toString(16)}`];
    if (pc >= FIXTURE.FAULT_TRAP && pc <= FIXTURE.FAULT_TRAP + 2) {
      detail.push("(the fixture's fault trap — the target took an exception)");
      const diag = await hil.call("diagnose_crash");
      record("hil-unexpected-fault-diagnose.txt", diag);
      record("hil-unexpected-fault-registers.txt", regs);

      // The stacked exception frame's PC names the faulting instruction.
      const sp = reg(regs, "SP");
      if (sp) {
        const frame = await hil.call("read_memory", { address: hex(sp), length: 32 });
        record("hil-unexpected-fault-frame.txt", frame);
        detail.push(`stacked frame at 0x${sp.toString(16)}:\n${frame}`);
      }
      detail.push(diag);
    }
    assert.fail(`target is not running the fixture. ${detail.join("\n")}`);
  });

  test("SP is exactly the vector table's initial MSP", async () => {
    // The fixture never touches SP, so unlike PC this stays exact even with
    // the core free-running between calls.
    const regs = await hil.expectOk("read_registers");
    assert.match(regs, /Core:/, "compact register format missing — parser regression");
    assert.equal(reg(regs, "SP"), FIXTURE.INITIAL_MSP);
    assert.equal(reg(regs, "MSP"), FIXTURE.INITIAL_MSP);
  });

  test("KNOWN LIMITATION: the core keeps running between two calls", async () => {
    // The fixture's spin loop increments R1 forever. Halt, read it, read it
    // again: on a session that held the halt these would match. Here they do
    // not, because the core resumed the moment the first JLinkExe detached.
    //
    // If this ever fails, the JLinkExe path started holding the target halted
    // across calls — a real improvement. Invert it and delete this note.
    await hil.expectOk("halt");
    const first = reg(await hil.expectOk("read_registers"), "R1")!;
    await sleep(250);
    const second = reg(await hil.expectOk("read_registers"), "R1")!;

    assert.notEqual(second, first,
      "R1 held steady — the JLinkExe path may now persist halt state across calls");
  });

  test("snapshot still assembles every section it promises", async () => {
    // Independent of the persistence problem: snapshot halts and reads within
    // one call chain, so its output is internally coherent. The failure this
    // guards is silent section loss when register parsing regresses — the
    // Stack section is gated on regs["SP"] and simply vanishes.
    const snap = await hil.expectOk("snapshot", { rttLines: 0 });
    record("hil-snapshot.txt", snap);
    assert.match(snap, /## Registers/);
    assert.match(snap, /Core:.*PC=/s, "registers not in compact form");
    assert.match(snap, /## Fault Status/);
    assert.match(snap, /## Stack/, "stack section missing — register parsing likely regressed");
    // The stack dump must carry whole lines. J-Link groups 16-byte lines as
    // 8|8, which is what the dump parser used to split on by mistake, losing
    // half of every line.
    const stackLine = snap.split("\n").find((l) => /^0x[0-9a-f]+: /.test(l))!;
    const bytes = stackLine.split(/[: ]+/).filter((t) => /^[0-9a-f]{2}$/i.test(t));
    assert.equal(bytes.length, 16, `stack dump line carried ${bytes.length} bytes, expected 16`);
  });

  test("read_register returns the register, not an error page", async () => {
    // Hardware caught this passing for the wrong reason: `halt` prints the
    // full register set before `rreg` runs, so a loose "does the value appear
    // anywhere" check matched the halt dump even while rreg itself failed with
    // "Illegal register name." Assert on the failure text directly.
    for (const name of ["PC", "SP", "R0", "MSP"]) {
      const out = await hil.expectOk("read_register", { register: name });
      record(`hil-read-register-${name}.txt`, out);
      assert.ok(!/Illegal register name/i.test(out),
        `read_register(${name}) was rejected by J-Link — name mapping missing`);
    }
  });
});

/**
 * S2b — under a live GDB session, where the halt/inspect/step contract holds.
 *
 * With JLinkGDBServer up and a GDB client attached, the session persists
 * across MCP calls and CPU control routes through it instead of spawning a
 * competing JLinkExe. This is the configuration the debugging workflow
 * actually runs in, and the only one where these assertions mean anything.
 */
describe("S2b — GDB session: halt, inspect, step are coherent", { skip }, () => {
  const hil = new HilClient("s02b-gdb");

  before(async () => {
    await hil.start();
    // Do not inherit S2a's target state. If the fixture faulted there, a
    // plain reset leaves the core parked in the trap and this whole suite
    // fails for a reason that has nothing to do with GDB.
    const recovery = await ensureFixtureRunning(hil, FIXTURE_HEX, FIXTURE.RESET_HANDLER);
    record("hil-s02b-target-recovery.txt", recovery);
    if (recovery.startsWith("RECOVERY FAILED")) {
      throw new Error(`cannot start the GDB suite: ${recovery}`);
    }
    await hil.expectOk("gdb_server_start");
    await sleep(1500);
    await hil.expectOk("gdb_connect");
  });

  after(async () => {
    await hil.call("gdb_disconnect");
    await hil.call("gdb_server_stop");
    await hil.stop();
  });

  test("the GDB server reports itself running", async () => {
    const status = await hil.expectOk("gdb_server_status");
    record("hil-gdb-server-status.txt", status);
    assert.match(status, /running|true|2331/i);
  });

  test("a halted core stays halted across separate tool calls", async () => {
    // The assertion S2a cannot make. Same two reads, same fixture, but the
    // session holds — so the counter must not move.
    await hil.expectOk("halt");
    const first = word32(await hil.expectOk("read_memory", { address: hex(FIXTURE.COUNTER_ADDR), length: 4 }));
    await sleep(300);
    const second = word32(await hil.expectOk("read_memory", { address: hex(FIXTURE.COUNTER_ADDR), length: 4 }));

    assert.notEqual(first, null, "could not read the counter");
    assert.equal(second, first, "counter advanced while halted — the halt did not hold");
  });

  test("a resumed core executes again", async () => {
    // Sample either side of the run window, not during it. The J-Link GDB
    // Server is a synchronous remote: while the target executes, GDB is in
    // its resume loop and memory cannot be read at all. Reading mid-run is
    // not a slow path, it is an impossible one — the client refuses it
    // outright, and an earlier version of this test asked for exactly that
    // and read the refusal as "the core never restarted".
    await hil.expectOk("halt");
    const before = word32(await hil.expectOk("read_memory", { address: hex(FIXTURE.COUNTER_ADDR), length: 4 }));

    await hil.expectOk("resume");
    await sleep(300);
    await hil.expectOk("halt");

    const after = word32(await hil.expectOk("read_memory", { address: hex(FIXTURE.COUNTER_ADDR), length: 4 }));
    assert.notEqual(before, null, "could not read the counter before resuming");
    assert.notEqual(after, before, "counter unchanged across the run window — the core did not restart");
  });

  test("reading memory while the target runs is refused, not left to hang", async () => {
    // The corollary, asserted directly: the caller gets an actionable answer
    // rather than an empty response after a timeout. Empty output is
    // indistinguishable from a healthy quiet target, which is what made this
    // class of failure hard to diagnose in the first place.
    await hil.expectOk("resume");
    const started = Date.now();
    const out = await hil.call("read_memory", { address: hex(FIXTURE.COUNTER_ADDR), length: 4 });
    const elapsed = Date.now() - started;
    record("hil-read-while-running.txt", out);

    assert.ok(elapsed < 5000, `took ${elapsed}ms — should refuse promptly, not time out`);
    // The tool must pass through the reason the layer below gave, not
    // replace it with a generic string. "Could not read memory" is a dead
    // end; "Target is running... Use halt" tells the caller what to do.
    assert.match(out, /running|halt/i, `unhelpful response while running: ${JSON.stringify(out)}`);

    await hil.expectOk("halt");
  });

  test("halting a running core stops it inside the spin loop", async () => {
    await hil.expectOk("halt");
    const regs = await hil.expectOk("read_registers");
    record("hil-registers-halted-in-loop.txt", regs);
    const pc = reg(regs, "PC")!;
    assert.ok(FIXTURE.SPIN_LOOP_PCS.includes(pc),
      `PC 0x${pc.toString(16)} outside the spin loop`);
  });

  test("step advances PC by exactly one instruction", async () => {
    await hil.expectOk("halt");
    const before = reg(await hil.expectOk("read_registers"), "PC")!;
    await hil.expectOk("step");
    const after = reg(await hil.expectOk("read_registers"), "PC")!;

    // Loop body 0x44 -> 0x46 -> 0x48 -> branch back to 0x44. Every
    // instruction is 16-bit Thumb.
    const expected = before === 0x48 ? FIXTURE.SPIN_LOOP : before + 2;
    assert.equal(after, expected,
      `step moved PC 0x${before.toString(16)} -> 0x${after.toString(16)}`);
  });

  test("registers read through GDB parse into the compact format", async () => {
    // The regression from the routing work: GDB emits whitespace columns with
    // lowercase names, which the register parser could not read at all, so
    // read_registers silently degraded to raw text.
    const regs = await hil.expectOk("read_registers");
    record("hil-registers-via-gdb.txt", regs);
    assert.match(regs, /Core:/, "GDB register output did not parse into compact form");
    assert.match(regs, /PC=0x[0-9A-F]{8}/);
    assert.equal(reg(regs, "SP"), FIXTURE.INITIAL_MSP);
  });

  test("the GDB session survives a full inspect sequence", async () => {
    // The bug the routing work exists to prevent: a CPU-control tool spawning
    // JLinkExe alongside the GDB server evicts the server's session, leaving
    // the client attached to a dead socket. Run the whole sequence, then prove
    // the session still answers.
    await hil.expectOk("halt");
    await hil.expectOk("read_registers");
    await hil.expectOk("read_memory", { address: hex(FIXTURE.CONST_BLOCK), length: 16 });
    await hil.expectOk("snapshot", { rttLines: 0 });

    const out = await hil.expectOk("gdb_command", { command: "info registers pc" });
    record("hil-gdb-after-inspect.txt", out);
    assert.ok(!/not supported by this target|Remote connection closed|no registers/i.test(out),
      `GDB session died during the inspect sequence: ${out}`);
  });
});
