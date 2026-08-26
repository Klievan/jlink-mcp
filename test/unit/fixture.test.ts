import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { repoRoot } from "../helpers";

// The generator is plain CommonJS JS — it is also run directly, by CI and by
// hand — so tsc never copies it into the build output. Resolve it from the
// source tree and require it, rather than importing types that do not exist.
const FIXTURE_DIR = path.join(repoRoot(__dirname), "test", "hil", "fixture");
const { build, toIntelHex, FIXTURE } = require(path.join(FIXTURE_DIR, "build-fixture.js"));

const HEX_PATH = path.join(FIXTURE_DIR, "fixture.hex");

describe("HIL fixture image", () => {
  const rom: Buffer = build();

  test("committed fixture.hex matches what the generator produces", () => {
    // A hand-assembled image is opaque on inspection, so the generator is the
    // source of truth and this test is what stops the two drifting apart.
    // If this fails: re-run `node test/hil/fixture/build-fixture.js`.
    const onDisk = fs.readFileSync(HEX_PATH, "utf8");
    assert.equal(toIntelHex(rom), onDisk, "fixture.hex is stale — regenerate it");
  });

  test("vector table has a valid stack pointer in RAM", () => {
    const msp = rom.readUInt32LE(0x00);
    assert.equal(msp, FIXTURE.INITIAL_MSP);
    // nRF52840 RAM is 256 KiB at 0x20000000.
    assert.ok(msp > 0x20000000 && msp <= 0x20040000, "MSP must point into RAM");
    assert.equal(msp % 8, 0, "AAPCS requires 8-byte stack alignment");
  });

  test("reset vector points at the handler with the Thumb bit set", () => {
    const vec = rom.readUInt32LE(0x04);
    assert.equal(vec & ~1, FIXTURE.RESET_HANDLER);
    assert.equal(vec & 1, 1, "clearing the Thumb bit faults immediately on Cortex-M");
  });

  test("every fault vector is populated and Thumb-tagged", () => {
    // Reserved slots are zero by spec; the rest must trap rather than run off
    // into erased flash, or a stray exception looks like a hung target.
    for (const off of [0x08, 0x0c, 0x10, 0x14, 0x18, 0x2c, 0x30, 0x38, 0x3c]) {
      const vec = rom.readUInt32LE(off);
      assert.equal(vec, FIXTURE.FAULT_TRAP | 1, `vector at 0x${off.toString(16)} is not trapped`);
    }
  });

  test("spin loop increments a RAM word", () => {
    // adds r1,#1 / str r1,[r0] / b .-8 — verified against arm-none-eabi-objdump.
    assert.equal(rom.readUInt16LE(0x44), 0x3101, "adds r1, #1");
    assert.equal(rom.readUInt16LE(0x46), 0x6001, "str r1, [r0]");
    assert.equal(rom.readUInt16LE(0x48), 0xe7fc, "b .-8");
    assert.equal(rom.readUInt32LE(0x4c), FIXTURE.COUNTER_ADDR);
  });

  test("the branch actually targets the loop head", () => {
    // T2 encoding: 11100 imm11, PC base = insn + 4, offset = imm11 * 2.
    const insn = rom.readUInt16LE(0x48);
    const imm11 = insn & 0x7ff;
    const offset = (imm11 << 21) >> 21; // sign-extend 11 bits
    assert.equal(0x48 + 4 + offset * 2, FIXTURE.SPIN_LOOP);
  });

  test("LDR literal resolves to the pool entry", () => {
    // T1 encoding: 01001 Rt imm8, PC base = (insn + 4) & ~3, offset = imm8 * 4.
    const insn = rom.readUInt16LE(0x40);
    assert.equal(insn >> 11, 0b01001, "not an LDR literal");
    const imm8 = insn & 0xff;
    assert.equal(((0x40 + 4) & ~3) + imm8 * 4, 0x4c);
  });

  test("fault trap is a self-branch", () => {
    assert.equal(rom.readUInt16LE(FIXTURE.FAULT_TRAP), 0xe7fe, "b .");
  });

  test("constant block mixes printable, ramp and high bytes", () => {
    const block = rom.subarray(FIXTURE.CONST_BLOCK, FIXTURE.CONST_BLOCK + 32);
    assert.equal(block.subarray(0, 16).toString("ascii"), FIXTURE.MAGIC);
    // A ramp and a high run, so the dump parser's ASCII column sees both
    // printable and non-printable bytes on the same line.
    assert.deepEqual([...block.subarray(16, 24)], [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual([...block.subarray(24, 32)], [0xf8, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe, 0xff]);
  });

  test("PCs the loop can halt at are all inside the loop body", () => {
    for (const pc of FIXTURE.SPIN_LOOP_PCS) {
      assert.ok(pc >= 0x44 && pc <= 0x48, `0x${pc.toString(16)} outside loop`);
      assert.equal(pc % 2, 0, "Thumb PCs are halfword aligned");
    }
  });
});

describe("Intel HEX encoding", () => {
  test("records carry a valid checksum", () => {
    for (const line of fs.readFileSync(HEX_PATH, "utf8").trim().split("\n")) {
      assert.match(line, /^:[0-9A-F]+$/, `malformed record: ${line}`);
      const bytes = line.slice(1).match(/../g)!.map((b) => parseInt(b, 16));
      const sum = bytes.reduce((a, b) => (a + b) & 0xff, 0);
      assert.equal(sum, 0, `bad checksum: ${line}`);
    }
  });

  test("terminates with an EOF record", () => {
    const lines = fs.readFileSync(HEX_PATH, "utf8").trim().split("\n");
    assert.equal(lines[lines.length - 1], ":00000001FF");
  });

  test("declared record lengths match their payloads", () => {
    for (const line of fs.readFileSync(HEX_PATH, "utf8").trim().split("\n")) {
      const bytes = line.slice(1).match(/../g)!.map((b) => parseInt(b, 16));
      // count, addr_hi, addr_lo, type, ...data, checksum
      assert.equal(bytes.length, bytes[0] + 5, `length mismatch: ${line}`);
    }
  });
});
