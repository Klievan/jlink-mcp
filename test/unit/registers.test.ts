import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { golden, StubBackend } from "../helpers";

const probe = new StubBackend();

describe("parseRegisters — J-Link Commander format", () => {
  const regs = probe.parseRegisters(golden("jlink-halt-regs.txt"));

  test("parses a full session transcript including the connect banner", () => {
    assert.ok(regs, "should not return null for real J-Link output");
  });

  test("extracts core registers", () => {
    assert.equal(regs!["PC"], "0x000004B2");
    assert.equal(regs!["R0"], "0x20000B10");
    assert.equal(regs!["R3"], "0x20002C48");
  });

  test("normalizes SP(R13) to SP", () => {
    assert.equal(regs!["SP"], "0x20002C40");
  });

  test("extracts stack pointers", () => {
    assert.equal(regs!["MSP"], "0x20002C40");
    assert.equal(regs!["PSP"], "0x00000000");
  });

  test("zero-pads short values to 8 digits", () => {
    // J-Link prints IPSR as 3 digits; diagnose_crash compares against
    // "0x00000000", so a short value would read as a spurious exception.
    assert.equal(regs!["IPSR"], "0x00000000");
  });

  test("extracts the decoded APSR flags", () => {
    assert.equal(regs!["APSR"], "nZCvq");
  });

  test("does not invent registers from banner text", () => {
    // The banner contains "CPUID register: 0x410FC241" and "DPIDR: 0x2BA01477".
    assert.equal(regs!["CPUID"], undefined);
    assert.equal(regs!["DPIDR"], undefined);
  });
});

describe("parseRegisters — GDB column format", () => {
  const regs = probe.parseRegisters(golden("gdb-info-all-registers.txt"));

  test("parses `info all-registers` output", () => {
    // Regression: this returned null, silently dropping the CPU State and
    // Exception Stack Frame sections from diagnose_crash and the stack dump
    // from snapshot, all while reporting success.
    assert.ok(regs, "should not return null for GDB output");
  });

  test("uppercases GDB's lowercase register names", () => {
    assert.equal(regs!["PC"], "0x000004B2");
    assert.equal(regs!["SP"], "0x20002C40");
    assert.equal(regs!["R0"], "0x20000B10");
    assert.equal(regs!["XPSR"], "0x61000003");
  });

  test("zero-pads GDB's unpadded values", () => {
    // GDB prints `psp  0x0`; the "is it zero" checks compare against
    // "0x00000000" and would otherwise treat PSP=0 as a valid stack pointer.
    assert.equal(regs!["PSP"], "0x00000000");
    assert.equal(regs!["PRIMASK"], "0x00000000");
  });

  test("takes the value column, not the symbolic third column", () => {
    // `pc  0x4b2  0x4b2 <fault_handler+6>` — the trailing symbol must not
    // leak into the parsed value.
    assert.equal(regs!["PC"], "0x000004B2");
    assert.ok(!JSON.stringify(regs).includes("fault_handler"));
  });

  test("derives IPSR from XPSR since GDB does not report it", () => {
    // XPSR 0x61000003 → exception number 3 (HardFault).
    assert.equal(regs!["IPSR"], "0x003");
  });

  test("FPSCR lands in the FP bucket for the compact formatter", () => {
    assert.equal(regs!["FPSCR"], "0x00000000");
  });
});

describe("parseRegisters — cross-format equivalence", () => {
  // Both transcripts describe the same halted machine. This is the property
  // that regressed when CPU control was routed through GDB: the same device
  // state must produce the same answer regardless of which channel read it.
  const viaJLink = probe.parseRegisters(golden("jlink-halt-regs.txt"))!;
  const viaGdb = probe.parseRegisters(golden("gdb-info-all-registers.txt"))!;

  for (const reg of ["PC", "SP", "MSP", "PSP", "R0", "R1", "R2", "R3", "R7", "R9"]) {
    test(`${reg} agrees across channels`, () => {
      assert.equal(viaGdb[reg], viaJLink[reg], `${reg} differs between J-Link and GDB parses`);
    });
  }

  test("both produce a usable compact summary", () => {
    for (const [label, regs] of [["J-Link", viaJLink], ["GDB", viaGdb]] as const) {
      const compact = probe.formatRegistersCompact(regs);
      assert.match(compact, /Core:/, `${label} compact output missing Core section`);
      assert.match(compact, /PC=0x000004B2/, `${label} compact output missing PC`);
      assert.match(compact, /Stack:.*MSP=0x20002C40/, `${label} compact output missing MSP`);
    }
  });
});

describe("parseRegisters — rejects non-register input", () => {
  test("returns null for empty input", () => {
    assert.equal(probe.parseRegisters(""), null);
  });

  test("returns null for whitespace", () => {
    assert.equal(probe.parseRegisters("\n\n   \n"), null);
  });

  test("returns null for a GDB error response", () => {
    assert.equal(probe.parseRegisters('Error: Invalid register `PC\''), null);
  });

  test("returns null for prose", () => {
    assert.equal(probe.parseRegisters("Target unreachable. Check SWD wiring."), null);
  });
});
