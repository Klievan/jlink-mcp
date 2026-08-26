import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { HilClient, NRF52840, ON_HIL_RUNNER, record, word32, hex, FIXTURE_HEX } from "./harness/mcp-client";

describe("S3 — memory and peripherals", { skip: !ON_HIL_RUNNER && "requires HIL=1" }, () => {
  const hil = new HilClient("s03-memory");

  before(async () => {
    await hil.start();
    await hil.expectOk("flash", { filePath: FIXTURE_HEX });
    await hil.expectOk("reset", { halt: true });
  });
  after(async () => { await hil.stop(); });

  test("SCB CPUID identifies a Cortex-M4", async () => {
    // Fixed by the silicon: no firmware, no configuration, no ambiguity.
    // If this word is wrong, memory reads are broken at a level where no
    // other assertion in the suite means anything.
    const out = await hil.expectOk("read_memory", { address: hex(NRF52840.CPUID_ADDR), length: 4 });
    record("hil-read-cpuid.txt", out);
    assert.equal(word32(out), NRF52840.CPUID,
      `CPUID mismatch — expected 0x${NRF52840.CPUID.toString(16)}`);
  });

  test("FICR reports the part number", async () => {
    const out = await hil.expectOk("read_memory", { address: hex(NRF52840.FICR_INFO_PART), length: 4 });
    record("hil-read-ficr-part.txt", out);
    const part = word32(out);
    // Nordic encodes the part as BCD-ish hex: nRF52840 -> 0x00052840.
    assert.equal(part, 0x00052840, `FICR INFO.PART = 0x${part?.toString(16)}`);
  });

  test("FICR DEVICEID is stable across reads and across a reset", async () => {
    const first = await hil.expectOk("read_memory", { address: hex(NRF52840.FICR_DEVICEID_0), length: 8 });
    record("hil-read-deviceid.txt", first);
    const second = await hil.expectOk("read_memory", { address: hex(NRF52840.FICR_DEVICEID_0), length: 8 });
    assert.equal(word32(second, 0), word32(first, 0), "DEVICEID changed between reads");
    assert.equal(word32(second, 1), word32(first, 1));

    await hil.expectOk("reset", { halt: true });
    const third = await hil.expectOk("read_memory", { address: hex(NRF52840.FICR_DEVICEID_0), length: 8 });
    assert.equal(word32(third, 0), word32(first, 0), "DEVICEID changed across reset");
  });

  test("write_memory round-trips little-endian", async () => {
    await hil.expectOk("halt");
    await hil.expectOk("write_memory", { address: hex(NRF52840.SCRATCH), value: hex(0xdeadbeef) });
    const out = await hil.expectOk("read_memory", { address: hex(NRF52840.SCRATCH), length: 4 });
    record("hil-write-read-roundtrip.txt", out);

    assert.equal(word32(out), 0xdeadbeef);
    // Byte order is asserted explicitly: a big-endian assembly would still
    // produce a self-consistent word32() and pass the check above.
    assert.match(out, /EF\s+BE\s+AD\s+DE/i, "bytes should be stored little-endian");
  });

  test("distinct values land at distinct addresses", async () => {
    await hil.expectOk("write_memory", { address: hex(NRF52840.SCRATCH), value: hex(0x11111111) });
    await hil.expectOk("write_memory", { address: hex(NRF52840.SCRATCH + 4), value: hex(0x22222222) });
    const out = await hil.expectOk("read_memory", { address: hex(NRF52840.SCRATCH), length: 8 });
    assert.equal(word32(out, 0), 0x11111111);
    assert.equal(word32(out, 1), 0x22222222);
  });

  test("a multi-line dump yields exactly the bytes requested", async () => {
    // 20 bytes spans three dump lines with a short final one — the shape that
    // starved readFaultRegisters when the dump parser was dropping half of
    // each line at J-Link's mid-line byte-group separator.
    const out = await hil.expectOk("read_memory", { address: hex(0), length: 20 });
    record("hil-read-20-bytes.txt", out);
    const bytes = out.split("\n")
      .map((l) => l.match(/[:=]\s*((?:[0-9A-Fa-f]{2}[ ]+)*[0-9A-Fa-f]{2})/)?.[1])
      .filter(Boolean).join(" ").split(/\s+/).filter(Boolean);
    // J-Link dumps whole 16-byte lines, so a 20-byte request comes back as
    // 32. What must hold is that we get at least what we asked for and no
    // more than one line of overshoot — the failure this guards is the length
    // being misparsed as hex, which turned 20 into 32 and 256 into 598.
    assert.ok(bytes.length >= 20 && bytes.length <= 32,
      `asked for 20 bytes, dump carried ${bytes.length}`);
  });

  test("a large read stays consistent", async () => {
    const out = await hil.expectOk("read_memory", { address: hex(0), length: 256 });
    record("hil-read-256-bytes.txt", out);
    const bytes = out.split("\n")
      .map((l) => l.match(/[:=]\s*((?:[0-9A-Fa-f]{2}[ ]+)*[0-9A-Fa-f]{2})/)?.[1])
      .filter(Boolean).join(" ").split(/\s+/).filter(Boolean);
    assert.ok(bytes.length >= 256 && bytes.length < 256 + 16,
      `asked for 256 bytes, dump carried ${bytes.length} — a hex/decimal radix slip gives 598`);
    // The first word is still the MSP regardless of how the dump was chunked.
    assert.equal(word32(out, 0), 0x20010000);
  });

  test("DHCSR is readable — the preflight path works", async () => {
    const out = await hil.expectOk("read_memory", { address: hex(NRF52840.DHCSR_ADDR), length: 4 });
    record("hil-read-dhcsr.txt", out);
    assert.notEqual(word32(out), null);
  });

  test("an unmapped address fails without wedging the session", async () => {
    const out = await hil.call("read_memory", { address: hex(NRF52840.UNMAPPED), length: 4 });
    record("hil-read-unmapped.txt", out);

    // The contract is that whatever happens, the next read still works.
    const after = await hil.expectOk("read_memory", { address: hex(NRF52840.CPUID_ADDR), length: 4 });
    assert.equal(word32(after), NRF52840.CPUID, "session did not survive a bad read");
  });

  test("diagnose_crash reports fault registers on a clean target", async () => {
    await hil.expectOk("reset", { halt: true });
    const out = await hil.expectOk("diagnose_crash");
    record("hil-diagnose-crash-clean.txt", out);

    // Freshly reset with no fault taken, so this should read as clean — but
    // it must actually *say* so, having read CFSR/HFSR. All-zero because the
    // dump parser dropped the bytes looks identical to genuinely no faults,
    // which is precisely the bug that shipped, so assert the registers were
    // reported rather than trusting the verdict.
    assert.match(out, /### Fault Registers/);
    assert.match(out, /CFSR=0x[0-9a-f]{8}/i);
    assert.match(out, /HFSR=0x[0-9a-f]{8}/i);
  });
});
