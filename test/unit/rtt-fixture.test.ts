import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { repoRoot } from "../helpers";

const DIR = path.join(repoRoot(__dirname), "test", "hil", "fixture");
const HEX = fs.readFileSync(path.join(DIR, "rtt-fixture.hex"), "utf8");
const SYMS: Record<string, string> = JSON.parse(fs.readFileSync(path.join(DIR, "symbols.json"), "utf8"));

/** Parse Intel HEX into a flat address->byte map. */
function loadHex(text: string): Map<number, number> {
  const mem = new Map<number, number>();
  let base = 0;
  for (const line of text.trim().split("\n")) {
    const b = line.slice(1).match(/../g)!.map((x) => parseInt(x, 16));
    const [count, hi, lo, type] = b;
    if (type === 0x04) base = ((b[4] << 8) | b[5]) << 16;
    else if (type === 0x00) {
      const addr = base + (hi << 8) + lo;
      for (let i = 0; i < count; i++) mem.set(addr + i, b[4 + i]);
    }
  }
  return mem;
}
const MEM = loadHex(HEX);
const word = (a: number) =>
  ((MEM.get(a)! | (MEM.get(a + 1)! << 8) | (MEM.get(a + 2)! << 16) | (MEM.get(a + 3)! << 24)) >>> 0);

/**
 * The RTT fixture is compiled, not hand-assembled, so these tests check the
 * things a compiler will not: that the image is laid out the way the hardware
 * requires, and that the symbols the HIL suite asserts against still exist at
 * the addresses it was told.
 */
describe("RTT fixture image", () => {
  test("initial MSP points at the top of RAM", () => {
    const msp = word(0x00);
    assert.equal(msp, 0x20040000, "nRF52840 RAM ends at 0x20040000");
    assert.equal(msp % 8, 0, "AAPCS requires 8-byte stack alignment");
  });

  test("reset vector matches Reset_Handler with the Thumb bit", () => {
    const vec = word(0x04);
    assert.equal(vec, parseInt(SYMS.Reset_Handler, 16) | 1);
    assert.equal(vec & 1, 1, "clearing the Thumb bit faults immediately on Cortex-M");
  });

  test("every fault vector reaches the trap", () => {
    // NMI, HardFault, MemManage, BusFault, UsageFault. An unpopulated vector
    // would run off into blank flash, which looks like a hang rather than a
    // fault and tells the suite nothing.
    const trap = parseInt(SYMS.Fault_Handler, 16) | 1;
    for (const off of [0x08, 0x0c, 0x10, 0x14, 0x18]) {
      assert.equal(word(off), trap, `vector at 0x${off.toString(16)} is not trapped`);
    }
  });

  test("exports every symbol the HIL suite reads", () => {
    for (const name of ["test_counter", "test_seq", "test_marker", "test_depth",
                        "test_marker_fn", "lvl1", "lvl2", "lvl3", "_SEGGER_RTT",
                        "Reset_Handler", "Fault_Handler", "main"]) {
      assert.ok(SYMS[name], `missing symbol: ${name}`);
      assert.match(SYMS[name], /^0x[0-9a-f]{8}$/, `${name} has a malformed address`);
    }
  });

  test("code is in flash and state is in RAM", () => {
    for (const fn of ["Reset_Handler", "Fault_Handler", "test_marker_fn", "lvl1", "lvl2", "lvl3", "main"]) {
      assert.ok(parseInt(SYMS[fn], 16) < 0x00100000, `${fn} is not in flash`);
    }
    for (const v of ["test_counter", "test_seq", "test_marker", "test_depth", "_SEGGER_RTT"]) {
      const a = parseInt(SYMS[v], 16);
      assert.ok(a >= 0x20000000 && a < 0x20040000, `${v} is not in RAM`);
    }
  });

  test("the nested call chain is three distinct functions", () => {
    // If the compiler inlined these the backtrace test has nothing to see.
    const addrs = ["lvl1", "lvl2", "lvl3"].map((n) => parseInt(SYMS[n], 16));
    assert.equal(new Set(addrs).size, 3, "lvl1/lvl2/lvl3 collapsed — noinline was dropped");
  });

  test("nothing is loaded into RAM", () => {
    // The linker asserts .data is empty; this asserts the *image* agrees, so a
    // future change that reintroduces .data fails here rather than producing a
    // target whose globals are silently uninitialised.
    for (const addr of MEM.keys()) {
      assert.ok(addr < 0x00100000, `hex writes 0x${addr.toString(16)}, outside flash`);
    }
  });

  test("the image is small enough to reason about", () => {
    // Not a performance limit — a size guard. This fixture exists to be
    // predictable, and a few KB is the point at which that stops being true.
    assert.ok(MEM.size < 8192, `image grew to ${MEM.size} bytes`);
  });
});
