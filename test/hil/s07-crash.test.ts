import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  HilClient, ON_HIL_RUNNER, record, RTT_FIXTURE_HEX, sym, reg, hex, withTargetHalted,
} from "./harness/mcp-client";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const skip = !ON_HIL_RUNNER && "requires HIL=1";

/**
 * S7 — crash diagnosis against faults injected on demand.
 *
 * diagnose_crash is the headline tool of this server, and until now it had
 * only ever been run against a healthy target — where "no faults detected" is
 * the right answer and therefore proves nothing. It shipped for months
 * reporting exactly that during real crashes, because the dump parser was
 * dropping half of every line.
 *
 * Deliberately conservative on *which* fault each trigger produces. Whether a
 * write to flash raises a precise BusFault or is silently absorbed is a
 * property of the nRF52840's bus fabric, not something to assert from
 * reasoning — that habit has cost this project several rounds. So these tests
 * assert the parts that must hold for any fault, record the specifics, and
 * leave pinning exact CFSR bits until a run has shown what they are.
 */
describe("S7 — crash injection and diagnosis", { skip }, () => {
  const hil = new HilClient("s07-crash");

  async function bootFixture() {
    await hil.expectOk("flash", { filePath: RTT_FIXTURE_HEX });
    await hil.expectOk("reset", { halt: false });
    // The GDB server holds the core halted from its attach; reset alone does
    // not necessarily leave it running.
    await hil.expectOk("resume");
    await sleep(800);
  }

  before(async () => {
    await hil.start();
    await hil.expectOk("gdb_server_start");
    await sleep(1500);
    await hil.expectOk("rtt_connect");
    await bootFixture();
  });

  after(async () => {
    await hil.call("rtt_disconnect");
    await hil.call("gdb_server_stop");
    await hil.stop();
  });

  test("a healthy target reports no faults, having actually read them", async () => {
    const out = await hil.expectOk("diagnose_crash");
    record("hil-diagnose-healthy.txt", out);
    // "No faults detected" is only meaningful if the registers were read. An
    // all-zero decode from a broken dump parser looks identical.
    assert.match(out, /CFSR=0x[0-9a-f]{8}/i);
    assert.match(out, /HFSR=0x[0-9a-f]{8}/i);
    assert.match(out, /DFSR=0x[0-9a-f]{8}/i);
  });

  for (const trigger of ["crash:nullderef", "crash:unaligned", "crash:undefined", "crash:badaddr"]) {
    test(`${trigger} produces a diagnosable fault`, async () => {
      await bootFixture();
      await hil.expectOk("rtt_send", { data: `${trigger}\n` });
      await sleep(1000);

      const out = await hil.expectOk("diagnose_crash");
      record(`hil-diagnose-${trigger.replace(":", "-")}.txt`, out);

      const regs = await hil.expectOk("read_registers");
      const pc = reg(regs, "PC");
      const trap = sym("Fault_Handler");

      // What must hold for any injected fault, whatever its flavour: the CPU
      // is in the trap, an exception is active, and the tool says something
      // specific rather than "no faults detected".
      assert.ok(pc !== null && pc >= trap && pc <= trap + 4,
        `PC 0x${pc?.toString(16)} is not the fault trap at 0x${trap.toString(16)} — did the trigger fire?`);
      assert.match(out, /CPU is in exception handler/i);
      assert.ok(!/No faults detected/i.test(out),
        `diagnose_crash reported a clean target while parked in the fault handler:\n${out}`);
    });
  }

  test("the exception stack frame names the faulting instruction", async () => {
    await bootFixture();
    await hil.expectOk("rtt_send", { data: "crash:badaddr\n" });
    await sleep(1000);

    const out = await hil.expectOk("diagnose_crash");
    record("hil-diagnose-frame.txt", out);
    assert.match(out, /### Exception Stack Frame/);
    // The stacked PC is what turns "it crashed" into "it crashed here".
    const m = out.match(/Faulting instruction at PC=0x([0-9A-Fa-f]+)/);
    assert.ok(m, `no stacked PC in the diagnosis:\n${out}`);
    const faultPc = parseInt(m![1], 16);
    assert.ok(faultPc > 0 && faultPc < 0x00100000,
      `stacked PC 0x${faultPc.toString(16)} is not a flash address`);
  });

  test("snapshot after a crash carries every section", async () => {
    const snap = await hil.expectOk("snapshot", { rttLines: 20 });
    record("hil-snapshot-crashed.txt", snap);
    assert.match(snap, /## Registers/);
    assert.match(snap, /Core:.*PC=/s);
    assert.match(snap, /## Fault Status/);
    assert.match(snap, /## Stack/, "stack section missing — register parsing regressed");
    // The RTT section should carry the fixture's own account of what it did.
    assert.match(snap, /## RTT Output/);
  });

  test("the injected fault is announced over RTT before it happens", async () => {
    // Cross-checks two independent channels: the log says a fault was
    // injected, the fault registers say one was taken. Either alone could be
    // a fixture bug rather than a real crash.
    const out = await hil.expectOk("rtt_search", { pattern: "injected fault" });
    record("hil-rtt-injected-fault.txt", out);
    assert.match(out, /injected fault/);
  });

  test("the target recovers for the next test", async () => {
    await bootFixture();
    const regs = await withTargetHalted(hil, () => hil.expectOk("read_registers"));
    const pc = reg(regs, "PC")!;
    assert.ok(pc < sym("Fault_Handler") || pc > sym("Fault_Handler") + 4,
      "still parked in the fault trap after a reflash and reset");
  });
});
