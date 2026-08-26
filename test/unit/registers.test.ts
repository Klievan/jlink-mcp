import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { golden, StubBackend } from "../helpers";
import { GDBClient } from "../../src/gdb/gdb-client";

const probe = new StubBackend();

/**
 * Both transcripts are real captures from an nRF52840-DK running the HIL
 * fixture: a spin loop incrementing a RAM word, halted mid-loop.
 *
 * They were taken at different moments, so R1 (the counter) and XPSR (whose
 * flags the counter's arithmetic sets) legitimately differ between them.
 * Everything the fixture does not touch — PC, SP, MSP, PSP, R0 — must agree.
 */
const JLINK = golden("jlink-halt-regs.txt");

/**
 * GDB's raw MI, passed through the real cleanMI.
 *
 * This is the pipeline production runs: GDBClient.command cleans the MI and
 * hands the result to parseRegisters. Piping the captured MI through the real
 * cleaner here, rather than committing a pre-cleaned snapshot, means the two
 * halves cannot drift apart without a test noticing.
 */
const GDB = (new GDBClient() as any).cleanMI(golden("gdb-info-all-registers-raw.txt"));

describe("parseRegisters — J-Link Commander format", () => {
  const regs = probe.parseRegisters(JLINK);

  test("parses a full session transcript including the connect banner", () => {
    assert.ok(regs, "should not return null for real J-Link output");
  });

  test("extracts core registers", () => {
    assert.equal(regs!["PC"], "0x00000044", "PC should be inside the fixture's spin loop");
    assert.equal(regs!["R0"], "0x20000000", "R0 holds the counter address");
  });

  test("normalizes SP(R13) to SP", () => {
    assert.equal(regs!["SP"], "0x20010000");
  });

  test("extracts stack pointers", () => {
    assert.equal(regs!["MSP"], "0x20010000", "the fixture's initial MSP");
    assert.equal(regs!["PSP"], "0x00000000");
  });

  test("zero-pads short values to 8 digits", () => {
    // J-Link prints IPSR as 3 digits; diagnose_crash compares against
    // "0x00000000", so a short value would read as a spurious exception.
    assert.equal(regs!["IPSR"], "0x00000000");
  });

  test("extracts the decoded APSR flags", () => {
    assert.equal(regs!["APSR"], "Nzcvq");
  });

  test("does not invent registers from banner text", () => {
    // The real banner carries "CPUID register: 0x410FC241" and a DPIDR line.
    assert.equal(regs!["CPUID"], undefined);
    assert.equal(regs!["DPIDR"], undefined);
  });
});

describe("parseRegisters — GDB column format", () => {
  const regs = probe.parseRegisters(GDB);

  test("parses `info all-registers` output", () => {
    // Regression: this returned null, silently dropping the CPU State and
    // Exception Stack Frame sections from diagnose_crash and the stack dump
    // from snapshot, all while reporting success.
    assert.ok(regs, "should not return null for GDB output");
  });

  test("uppercases GDB's lowercase register names", () => {
    assert.equal(regs!["PC"], "0x00000044");
    assert.equal(regs!["SP"], "0x20010000");
    assert.equal(regs!["R0"], "0x20000000");
  });

  test("zero-pads GDB's unpadded values", () => {
    // GDB prints `psp  0x0` and `pc  0x44`; the "is it zero" checks compare
    // against "0x00000000" and would otherwise treat PSP=0 as a real pointer.
    assert.equal(regs!["PSP"], "0x00000000");
    assert.equal(regs!["XPSR"], "0x01000000", "GDB prints 0x1000000, unpadded");
  });

  test("takes the value column, not the symbolic third column", () => {
    // `pc  0x44  0x44` — the third column must not leak into the value, and
    // where symbols are loaded it carries `<function+offset>` too.
    assert.equal(regs!["PC"], "0x00000044");
    assert.ok(!/[<>]/.test(JSON.stringify(regs)), "symbolic text leaked into a value");
  });

  test("uses GDB's own IPSR, which Cortex-M targets do report", () => {
    // Corrects an earlier assumption: `info all-registers` on this target
    // lists ipsr/epsr/apsr separately alongside the combined xpsr, so the
    // XPSR-derived fallback never fires here. 0 = thread mode, matching what
    // J-Link reports as "IPSR = 000 (NoException)".
    assert.equal(regs!["IPSR"], "0x00000000");
  });

  test("still derives IPSR from XPSR when the target omits it", () => {
    // The fallback matters for targets whose register set has no ipsr entry.
    // XPSR 0x61000003 -> exception number 3, a HardFault.
    const derived = probe.parseRegisters("xpsr           0x61000003          1627389955");
    assert.equal(derived!["IPSR"], "0x003");
  });

  test("negative decimal columns do not corrupt the value", () => {
    // `lr  0xffffffff  -1` — the decimal column is signed.
    assert.equal(regs!["LR"], "0xFFFFFFFF");
  });
});

describe("parseRegisters — cross-format equivalence", () => {
  // The property that regressed when CPU control was routed through GDB: the
  // same device state must produce the same answer regardless of which
  // channel read it. Only registers the fixture does not modify are compared
  // — R1 is its counter and XPSR carries flags from incrementing it, so both
  // legitimately differ between two captures taken moments apart.
  const viaJLink = probe.parseRegisters(JLINK)!;
  const viaGdb = probe.parseRegisters(GDB)!;

  for (const reg of ["PC", "SP", "MSP", "PSP", "R0", "R2", "R3"]) {
    test(`${reg} agrees across channels`, () => {
      assert.equal(viaGdb[reg], viaJLink[reg], `${reg} differs between J-Link and GDB parses`);
    });
  }

  test("both produce a usable compact summary", () => {
    for (const [label, regs] of [["J-Link", viaJLink], ["GDB", viaGdb]] as const) {
      const compact = probe.formatRegistersCompact(regs);
      assert.match(compact, /Core:/, `${label} compact output missing Core section`);
      assert.match(compact, /PC=0x00000044/, `${label} compact output missing PC`);
      assert.match(compact, /Stack:.*MSP=0x20010000/, `${label} compact output missing MSP`);
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
