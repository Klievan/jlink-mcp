import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { JLinkBackend } from "../../src/probe/jlink";
import { ProcessManager } from "../../src/utils/process-manager";

/**
 * Reset is J-Link's job; verifying it happened is ours.
 *
 * SEGGER's reset-strategy reference is explicit that the default Cortex-M
 * strategy already halts at the vector by setting DEMCR.VC_CORERESET, so
 * these tests pin that we let J-Link do it — an earlier version of this code
 * wrote DEMCR by hand, which duplicated J-Link's work and opted out of the
 * per-device sequences it picks.
 *
 * https://kb.segger.com/J-Link_Reset_Strategies
 */

/** A tiny fake target: a memory map plus a PC. */
function fake(opts: { vtor?: number; vector?: number; pc?: number; readable?: boolean } = {}) {
  const { vtor = 0, vector = 0x501, pc = 0x500, readable = true } = opts;
  const backend = new JLinkBackend({ device: "NRF52840_XXAA" }, new ProcessManager());
  const scripts: string[][] = [];
  const b = backend as any;

  b.execRaw = async (c: string[]) => { scripts.push(c); return { success: true, rawOutput: "", output: "" }; };
  b.readMemory = async (address: number) => {
    if (!readable) return { success: false, rawOutput: "", output: "" };
    const word = address === 0xe000ed08 ? vtor : address === (vtor & 0xffffff80) + 4 ? vector : 0;
    const le = [0, 8, 16, 24].map((s) => ((word >>> s) & 0xff).toString(16).padStart(2, "0").toUpperCase());
    const addr = address.toString(16).toUpperCase().padStart(8, "0");
    return { success: true, rawOutput: `${addr} = ${le.join(" ")}  ....`, output: "" };
  };
  b.readRegister = async () => ({ success: true, rawOutput: "", output: `PC = 0x${pc.toString(16)}` });

  return { backend, scripts };
}

describe("reset strategy", () => {
  test("lets J-Link pick the strategy by default", async () => {
    const { backend, scripts } = fake();
    await backend.reset(true);
    assert.deepEqual(scripts[0], ["r"], "no RSetType, and no hand-written DEMCR writes");
  });

  test("does not chase `r` with a halt", async () => {
    // `r` halts on its own. A late halt cannot help: if the reset worked it
    // is a no-op, and if it did not, it parks the PC wherever startup reached
    // and makes a broken reset look like a working one.
    const { backend, scripts } = fake();
    await backend.reset(true);
    assert.ok(!scripts[0].includes("halt"));
  });

  test("selects an explicit reset type when asked", async () => {
    const { backend, scripts } = fake();
    await backend.reset(true, 2);
    assert.deepEqual(scripts[0], ["RSetType 2", "r"], "type must be set before the reset");
  });

  test("reset(run) resets then goes", async () => {
    const { backend, scripts } = fake();
    await backend.reset(false);
    assert.deepEqual(scripts[0], ["r", "go"]);
  });
});

describe("verifying the reset actually took", () => {
  test("accepts a core stopped at the reset vector", async () => {
    const { backend } = fake({ vector: 0x501, pc: 0x500 });
    assert.equal((await backend.reset(true)).success, true);
  });

  test("allows stopping a few instructions in", async () => {
    const { backend } = fake({ vector: 0x501, pc: 0x50c });
    assert.equal((await backend.reset(true)).success, true);
  });

  test("fails a reset that reported success while the core ran on", async () => {
    // The real one: PC 0x326, inside main at 0x2a4, after reset(halt)
    // claimed success. The probe was owned by another process, so the reset
    // was accepted and discarded.
    const { backend } = fake({ vector: 0x501, pc: 0x326 });
    const r = await backend.reset(true);
    assert.equal(r.success, false);
    assert.match(r.error ?? "", /0x326/);
    assert.match(r.suggestedAction ?? "", /another process owns the probe/i);
  });

  test("follows VTOR rather than assuming the table is at zero", async () => {
    // A relocated vector table is normal after a bootloader hands over.
    const { backend } = fake({ vtor: 0x27000, vector: 0x27501, pc: 0x27500 });
    assert.equal((await backend.reset(true)).success, true);
  });

  test("leaves the result alone when it cannot verify", async () => {
    // An unverifiable reset is not a failed one. Inventing a failure here
    // would be the same lie, pointed the other way.
    const { backend } = fake({ readable: false });
    assert.equal((await backend.reset(true)).success, true);
  });

  test("ignores a blank vector table", async () => {
    const { backend } = fake({ vector: 0xffffffff, pc: 0x326 });
    assert.equal((await backend.reset(true)).success, true, "erased flash proves nothing about the reset");
  });
});
