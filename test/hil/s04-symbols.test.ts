import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  HilClient, ON_HIL_RUNNER, record, RTT_FIXTURE_HEX, RTT_FIXTURE_ELF,
  sym, hex, withTargetHalted, word32,
} from "./harness/mcp-client";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const skip = !ON_HIL_RUNNER && "requires HIL=1";

/**
 * S4 — debug symbols.
 *
 * The `embedded-debugging` skill tells a model that loading the ELF is the
 * single biggest unlock available to it: that without symbols a backtrace is
 * bare addresses, and with them it names functions. That claim had never been
 * checked against hardware — it was read off a tool description. The skill
 * also promises that a symbols-only load does not touch flash, which is a
 * promise about the device, and therefore the device's to answer.
 *
 * The fixture ELF has been sitting exported and unused since the harness was
 * written; this is the suite it was built for.
 */
describe("S4 — debug symbols and backtraces", { skip }, () => {
  const hil = new HilClient("s04-symbols");

  before(async () => {
    await hil.start();
    await hil.expectOk("gdb_server_start");
    await sleep(1500);
    await hil.expectOk("flash", { filePath: RTT_FIXTURE_HEX });
    await hil.expectOk("reset", { halt: false });
    await hil.expectOk("resume");
    await sleep(800);
    await hil.expectOk("gdb_connect");
  });
  after(async () => { await hil.stop(); });

  test("without symbols a backtrace carries no function names", async () => {
    // The baseline the skill claims. Recorded rather than asserted narrowly:
    // exactly how GDB renders an unresolved frame is GDB's business, and
    // pinning its punctuation would make this a test of the formatter.
    const bt = await withTargetHalted(hil, () => hil.expectOk("gdb_backtrace"));
    record("hil-backtrace-no-symbols.txt", bt);

    assert.ok(bt.trim().length > 0, "should still produce a frame, just an anonymous one");
    assert.ok(!/\bmain\b/.test(bt),
      `a backtrace with no ELF loaded should not know the name "main":\n${bt}`);
  });

  test("loading the ELF names the frames", async () => {
    const load = await hil.expectOk("gdb_load", { elfFile: RTT_FIXTURE_ELF });
    record("hil-gdb-load-symbols.txt", load);

    const bt = await withTargetHalted(hil, () => hil.expectOk("gdb_backtrace"));
    record("hil-backtrace-with-symbols.txt", bt);

    // The fixture spends nearly all its time inside main's loop, so main is
    // the one name that must appear whatever the sampling moment.
    assert.match(bt, /\bmain\b/,
      `symbols were loaded but the backtrace still has no names:\n${bt}`);
  });

  test("a symbols-only load does not reprogram the target", async () => {
    // gdb_load defaults to flash:false, and the skill tells people to rely on
    // that. Whether it holds is a fact about the device.
    const before = await withTargetHalted(hil, () =>
      hil.expectOk("read_memory", { address: hex(0), length: 16 }));

    await hil.expectOk("gdb_load", { elfFile: RTT_FIXTURE_ELF });

    const after = await withTargetHalted(hil, () =>
      hil.expectOk("read_memory", { address: hex(0), length: 16 }));
    record("hil-symbols-only-no-flash.txt", `before:\n${before}\nafter:\n${after}`);

    for (const w of [0, 1, 2, 3]) {
      assert.equal(word32(after, w), word32(before, w),
        `word ${w} of the vector table changed across a symbols-only load`);
    }
  });

  test("an address resolves to a source location", async () => {
    // The other half of what symbols buy: turning a faulting PC into a line
    // of code, which is the move the crash workflow leans on.
    const out = await hil.expectOk("gdb_command", {
      command: `info line *0x${sym("main").toString(16)}`,
    });
    record("hil-info-line-main.txt", out);
    assert.match(out, /fixture\.c/,
      `expected the fixture's source file in the resolution:\n${out}`);
  });
});
