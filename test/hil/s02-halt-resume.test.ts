import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { HilClient, ON_HIL_RUNNER, record, reg, word32, FIXTURE_HEX } from "./harness/mcp-client";
import { repoRoot } from "../helpers";
import * as path from "path";

const { FIXTURE } = require(path.join(repoRoot(__dirname), "test", "hil", "fixture", "build-fixture.js"));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("S2 — halt, inspect, resume", { skip: !ON_HIL_RUNNER && "requires HIL=1" }, () => {
  const hil = new HilClient();

  before(async () => {
    await hil.start();
    // Every assertion below is against the fixture image, so put it there
    // rather than inheriting whatever S1 left behind.
    await hil.expectOk("flash", { filePath: FIXTURE_HEX });
  });
  after(async () => { await hil.stop(); });

  test("reset(halt) lands exactly on the reset vector", async () => {
    // The strongest single assertion in the suite: PC and SP must equal the
    // two words the vector table holds, which we know from the generator.
    // It exercises reset, halt, register read and the compact formatter, and
    // every value is exact rather than a range.
    await hil.expectOk("reset", { halt: true });
    const regs = await hil.expectOk("read_registers");
    record("hil-registers-reset-halt.txt", regs);

    assert.match(regs, /Core:/, "compact register format missing — parser regression");
    assert.equal(reg(regs, "PC"), FIXTURE.RESET_HANDLER, "PC should be the reset handler");
    assert.equal(reg(regs, "SP"), FIXTURE.INITIAL_MSP, "SP should be the initial MSP");
    assert.equal(reg(regs, "MSP"), FIXTURE.INITIAL_MSP);
  });

  test("read_register agrees with read_registers, using documented names", async () => {
    await hil.expectOk("reset", { halt: true });
    const all = await hil.expectOk("read_registers");
    // 'PC' and 'SP' are the tool's own documented examples. Under GDB routing
    // these need translating to lowercase or GDB rejects them outright.
    for (const name of ["PC", "SP", "MSP"]) {
      const one = await hil.expectOk("read_register", { register: name });
      record(`hil-read-register-${name}.txt`, one);
      const expected = reg(all, name)!;
      assert.match(one, new RegExp(expected.toString(16), "i"),
        `read_register(${name}) = ${one} disagrees with read_registers (0x${expected.toString(16)})`);
    }
  });

  test("a halted core does not execute", async () => {
    // The fixture spins incrementing a RAM word. If the core is genuinely
    // halted the word cannot change; if "halt" only pretended, it will.
    await hil.expectOk("reset", { halt: false });
    await sleep(200);
    await hil.expectOk("halt");

    const first = word32(await hil.expectOk("read_memory", { address: FIXTURE.COUNTER_ADDR, length: 4 }));
    await sleep(300);
    const second = word32(await hil.expectOk("read_memory", { address: FIXTURE.COUNTER_ADDR, length: 4 }));

    assert.notEqual(first, null, "could not read the counter");
    assert.equal(second, first, "counter advanced while halted — the core did not stop");
  });

  test("a resumed core does execute", async () => {
    await hil.expectOk("resume");
    const first = word32(await hil.expectOk("read_memory", { address: FIXTURE.COUNTER_ADDR, length: 4 }));
    await sleep(300);
    const second = word32(await hil.expectOk("read_memory", { address: FIXTURE.COUNTER_ADDR, length: 4 }));

    assert.notEqual(second, first, "counter frozen after resume — the core did not restart");
  });

  test("halting a running core stops it inside the spin loop", async () => {
    await hil.expectOk("reset", { halt: false });
    await sleep(200);
    await hil.expectOk("halt");

    const regs = await hil.expectOk("read_registers");
    record("hil-registers-halted-in-loop.txt", regs);
    const pc = reg(regs, "PC");
    assert.ok(FIXTURE.SPIN_LOOP_PCS.includes(pc),
      `PC 0x${pc?.toString(16)} is outside the spin loop ${JSON.stringify(FIXTURE.SPIN_LOOP_PCS.map((n: number) => "0x" + n.toString(16)))}`);
  });

  test("step advances PC by one instruction", async () => {
    await hil.expectOk("reset", { halt: true });
    const before = reg(await hil.expectOk("read_registers"), "PC")!;
    await hil.expectOk("step");
    const after = reg(await hil.expectOk("read_registers"), "PC")!;

    // Every instruction in the fixture is 16-bit Thumb.
    assert.equal(after, before + 2, `step moved PC 0x${before.toString(16)} -> 0x${after.toString(16)}`);
  });

  test("stepping through the loop stays inside it", async () => {
    // From the reset handler, four steps run ldr/movs then enter the loop and
    // keep circling. PC must never leave the handler region.
    for (let i = 0; i < 6; i++) {
      await hil.expectOk("step");
      const pc = reg(await hil.expectOk("read_registers"), "PC")!;
      assert.ok(pc >= FIXTURE.RESET_HANDLER && pc <= FIXTURE.RESET_HANDLER + 0x10,
        `step ${i} left the handler: PC=0x${pc.toString(16)}`);
    }
  });

  test("snapshot includes every section it promises", async () => {
    await hil.expectOk("halt");
    const snap = await hil.expectOk("snapshot", { rttLines: 0 });
    record("hil-snapshot.txt", snap);

    // The failure mode this guards is silent section loss: when register
    // parsing breaks, snapshot still returns success but the Stack section
    // disappears because it is gated on regs["SP"].
    assert.match(snap, /## Registers/);
    assert.match(snap, /Core:.*PC=/s, "registers not in compact form");
    assert.match(snap, /## Fault Status/);
    assert.match(snap, /## Stack/, "stack section missing — register parsing likely regressed");
  });
});
