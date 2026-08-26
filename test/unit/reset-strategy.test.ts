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

describe("backends that have no reset strategies", () => {
  // A caller who names a strategy has a reason. Resetting some other way and
  // reporting success is how you get a reset that "worked" and did something
  // else entirely.
  const cases: Array<[string, () => any]> = [
    ["openocd", () => new (require("../../src/probe/openocd").OpenOCDBackend)({}, new ProcessManager())],
    ["blackmagic", () => new (require("../../src/probe/blackmagic").BlackMagicBackend)({}, new ProcessManager())],
  ];

  for (const [name, make] of cases) {
    test(`${name} refuses an explicit strategy rather than substituting one`, async () => {
      const r = await make().reset(true, 2);
      assert.equal(r.success, false);
      assert.match(r.error ?? "", /strategy 2/);
    });
  }
});

describe("restarting RTT collection after a reset", () => {
  // Measured on an nRF52840 across a reset, sampling SEGGER's control block
  // from both ends: the target's write pointer moved 582 -> 802 while the
  // host's read pointer stayed at 0. The firmware was still logging; the
  // probe had stopped collecting. Every later read then says "No RTT output
  // yet", which is exactly what a quiet target says.
  function backend(addr?: number) {
    const b = new JLinkBackend(
      { device: "NRF52840_XXAA", ...(addr === undefined ? {} : { rttControlBlockAddress: addr }) } as any,
      new ProcessManager()
    );
    const scripts: string[][] = [];
    (b as any).execRaw = async (c: string[]) => { scripts.push(c); return { success: true, rawOutput: "", output: "" }; };
    return { b, scripts };
  }

  test("re-points the probe at the control block", async () => {
    const { b, scripts } = backend(0x20000000);
    const r = await b.restartRTT();
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(scripts[0], ["exec SetRTTAddr 0x20000000"]);
  });

  test("says why it cannot, rather than leaving a dead stream looking quiet", async () => {
    const { b, scripts } = backend();
    const r = await b.restartRTT();
    assert.equal(r.ok, false);
    assert.match(r.detail, /JLINK_RTT_ADDR/, "must say how to fix it");
    assert.equal(scripts.length, 0, "nothing to send without an address");
  });
});

describe("verification that cannot run", () => {
  // An unverifiable reset is not a failed one. Getting this backwards failed
  // a reset that had actually worked — the same lie this check exists to
  // catch, pointed the other way.
  test("skips the check while RTT is being collected", async () => {
    // J-Link collects RTT in stop mode by default: it halts the core, reads
    // the buffer, and starts it again. So the PC cannot be pinned to the
    // reset vector, however well the reset went.
    const b = new JLinkBackend({ device: "NRF52840_XXAA" }, new ProcessManager());
    // rttConnected only takes while the GDB server is up — RTT is served by it.
    (b as any).setState(require("../../src/probe/backend").ProbeState.GDB_RUNNING);
    b.rttConnected = true;
    assert.equal(b.rttConnected, true, "precondition");
    const reads: number[] = [];
    (b as any).execRaw = async () => ({ success: true, rawOutput: "", output: "" });
    (b as any).readMemory = async (a: number) => { reads.push(a); return { success: false, rawOutput: "", output: "" }; };

    assert.equal((await b.reset(true)).success, true);
    assert.deepEqual(reads, [], "should not even attempt the read");
  });
});

describe("RTT collection is separate from the telnet client", () => {
  // Connecting our client is not the same as the probe collecting. J-Link
  // scans for the control block once, at its own moment, and after a flash —
  // which resets the target — that scan can land before the firmware has
  // initialised the block. Nothing retries it. Measured after a flash: 490
  // bytes written by the firmware, none collected, every read reporting "No
  // RTT output yet" while the device was talking the whole time.
  test("restartRTT is a no-op that reports itself, not a throw, without an address", async () => {
    const b = new JLinkBackend({ device: "NRF52840_XXAA" }, new ProcessManager());
    const r = await b.restartRTT();
    assert.equal(r.ok, false);
    assert.ok(r.detail.length > 0, "must explain itself — this runs on the happy path");
  });
});
