#!/usr/bin/env node
/**
 * Builds the HIL fixture image for the nRF52840-DK.
 *
 * Hand-assembled Thumb-2, deliberately: the whole point is a target whose
 * every byte is known at test-authoring time, and pulling in Zephyr or an ARM
 * toolchain to emit forty bytes would make CI slower, more fragile, and no
 * more deterministic. The generated .hex is committed next to this script and
 * a unit test regenerates it and compares, so the two can never drift.
 *
 * What the image provides:
 *
 *  - A valid vector table, so the core actually runs. (The DK's flash was
 *    mass-erased when APPROTECT was cleared; a blank chip has reset vector
 *    0xFFFFFFFF and locks up, which makes every "is it running?" assertion
 *    meaningless.)
 *  - A spin loop incrementing a RAM word, so "halted" vs "running" is
 *    observable with two plain memory reads and no DWT/TRCENA setup.
 *  - A known constant block mixing printable ASCII, a byte ramp, and high
 *    bytes, so memory-dump parsing and its ASCII column are exercised.
 *
 * Layout (flash @ 0x00000000):
 *   0x0000  vector table (16 entries)
 *   0x0040  reset handler + spin loop
 *   0x0060  fault trap (`b .`)
 *   0x0100  constant block, 32 bytes
 */

const RESET_HANDLER = 0x0040;
const SPIN_LOOP = 0x0044; // the `adds` — PC lands here or the two after it
const FAULT_TRAP = 0x0060;
const CONST_BLOCK = 0x0100;
const COUNTER_ADDR = 0x20000000; // RAM word the spin loop increments
const INITIAL_MSP = 0x20010000; // 64 KiB into the DK's 256 KiB RAM

const MAGIC = "JLINKMCP-HIL-V1\0";

function build() {
  const rom = Buffer.alloc(0x120, 0xff);

  // ── Vector table ────────────────────────────────────────────────
  rom.writeUInt32LE(INITIAL_MSP, 0x00);
  rom.writeUInt32LE(RESET_HANDLER | 1, 0x04); // thumb bit
  // Every fault and IRQ vector parks at the trap. Reserved slots stay 0.
  const reserved = new Set([0x1c, 0x20, 0x24, 0x28, 0x34]);
  for (let off = 0x08; off < 0x40; off += 4) {
    rom.writeUInt32LE(reserved.has(off) ? 0 : FAULT_TRAP | 1, off);
  }

  // ── Reset handler ───────────────────────────────────────────────
  //   0x40  ldr  r0, [pc, #8]   -> literal at 0x4C
  //   0x42  movs r1, #0
  //   0x44  adds r1, #1         <- spin loop starts here
  //   0x46  str  r1, [r0]
  //   0x48  b    0x44
  //   0x4A  nop                 (align the literal pool)
  //   0x4C  .word 0x20000000
  //
  // LDR literal's PC base is (insn + 4) & ~3 = 0x44, so 0x4C is +8 → imm8 = 2.
  // The branch's PC base is 0x4C; 0x44 - 0x4C = -8 → imm11 = -4 = 0x7FC.
  const code = [0x4802, 0x2100, 0x3101, 0x6001, 0xe7fc, 0xbf00];
  code.forEach((halfword, i) => rom.writeUInt16LE(halfword, RESET_HANDLER + i * 2));
  rom.writeUInt32LE(COUNTER_ADDR, 0x004c);

  // ── Fault trap: b . ─────────────────────────────────────────────
  rom.writeUInt16LE(0xe7fe, FAULT_TRAP);

  // ── Constant block ──────────────────────────────────────────────
  rom.write(MAGIC, CONST_BLOCK, "ascii");
  for (let i = 0; i < 8; i++) rom[CONST_BLOCK + 0x10 + i] = i; // 00..07
  for (let i = 0; i < 8; i++) rom[CONST_BLOCK + 0x18 + i] = 0xf8 + i; // F8..FF

  return rom;
}

/** Emit Intel HEX. Everything lives below 64 KiB, so no extended-address records. */
function toIntelHex(buf, bytesPerRecord = 16) {
  const lines = [];
  for (let addr = 0; addr < buf.length; addr += bytesPerRecord) {
    const chunk = buf.subarray(addr, Math.min(addr + bytesPerRecord, buf.length));
    const bytes = [chunk.length, (addr >> 8) & 0xff, addr & 0xff, 0x00, ...chunk];
    const sum = bytes.reduce((a, b) => (a + b) & 0xff, 0);
    bytes.push((0x100 - sum) & 0xff);
    lines.push(":" + bytes.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(""));
  }
  lines.push(":00000001FF");
  return lines.join("\n") + "\n";
}

const FIXTURE = {
  RESET_HANDLER,
  SPIN_LOOP,
  FAULT_TRAP,
  CONST_BLOCK,
  COUNTER_ADDR,
  INITIAL_MSP,
  MAGIC,
  /** PC can be at any instruction of the three-instruction loop body. */
  SPIN_LOOP_PCS: [0x0044, 0x0046, 0x0048],
};

module.exports = { build, toIntelHex, FIXTURE };

if (require.main === module) {
  const fs = require("fs");
  const path = require("path");
  const out = path.join(__dirname, "fixture.hex");
  fs.writeFileSync(out, toIntelHex(build()));
  console.log(`wrote ${out}`);
}
