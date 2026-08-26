import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { JLinkBackend } from "../../src/probe/jlink";
import { ProcessManager } from "../../src/utils/process-manager";

/**
 * `r` then `halt` does not stop a Cortex-M at its reset vector: the core runs
 * the moment reset releases, so by the time the halt lands it has executed an
 * arbitrary amount of startup. Measured on an nRF52840 — reset(halt) left PC
 * mid-firmware, with JLinkExe and GDB agreeing on the address, which ruled out
 * a stale register cache and left only "the core really is running".
 *
 * DEMCR.VC_CORERESET is how you stop it before it starts.
 */
describe("reset(halt) on the JLinkExe path", () => {
  function capture() {
    const backend = new JLinkBackend({ device: "NRF52840_XXAA" }, new ProcessManager());
    const scripts: string[][] = [];
    (backend as any).execRaw = async (c: string[]) => {
      scripts.push(c);
      return { success: true, rawOutput: "", output: "" };
    };
    return { scripts, backend };
  }

  test("arms vector catch before resetting", async () => {
    const { scripts, backend } = capture();
    await backend.reset(true);
    const s = scripts[0];
    const arm = s.findIndex((c) => /w4 0xE000EDFC, 0x01000001/i.test(c));
    const reset = s.indexOf("r");
    assert.ok(arm >= 0, `vector catch never armed: ${JSON.stringify(s)}`);
    assert.ok(arm < reset, "arming after the reset is useless — the core has already started");
  });

  test("clears it afterwards", async () => {
    // An armed debug trap left behind re-triggers for whoever runs next. That
    // has already broken this rig once, when a stale comparator HardFaulted a
    // completely different firmware that reused the address.
    const { scripts, backend } = capture();
    await backend.reset(true);
    const s = scripts[0];
    const clear = s.findIndex((c) => /w4 0xE000EDFC, 0x01000000/i.test(c));
    assert.ok(clear > s.indexOf("r"), "catch must be cleared after the reset");
  });

  test("preserves TRCENA", async () => {
    // Bit 24 is J-Link's; clearing it disables the trace block that DWT and
    // the ITM sit behind.
    const { scripts, backend } = capture();
    await backend.reset(true);
    for (const c of scripts[0].filter((x) => /E000EDFC/i.test(x))) {
      assert.match(c, /0x0100000[01]/, `DEMCR write drops TRCENA: ${c}`);
    }
  });

  test("reset(run) does not touch DEMCR", async () => {
    // Nothing to catch when the caller wants the target running.
    const { scripts, backend } = capture();
    await backend.reset(false);
    assert.deepEqual(scripts[0], ["r", "go"]);
  });
});
