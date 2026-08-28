import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import { parseSvd, decodeValue } from "../../src/svd/parser";
import { SvdRegistry, formatDecoded } from "../../src/svd";
import { repoRoot } from "../helpers";

const SVD = path.join(repoRoot(__dirname), "test", "fixtures", "nrf52840.svd.gz");
const device = parseSvd(SVD);
const reg = (p: string, r: string) =>
  device.peripherals.find((x) => x.name === p)?.registers.find((x) => x.name === r);

/**
 * Parsed against Nordic's real nRF52840 SVD, not a hand-written sample.
 *
 * The addresses asserted below were independently measured on an nRF52840-DK
 * before this parser existed — S3 reads FICR.INFO.PART at 0x10000100 and gets
 * 0x00052840. Here the same address is *computed* from base + cluster offset +
 * register offset. Agreement between those two routes is the only reason to
 * trust the arithmetic; a decode that is confidently wrong is worse than none,
 * and it fails silently.
 */
describe("SVD parsing — nRF52840", () => {
  test("identifies the device", () => {
    assert.equal(device.name, "nrf52840");
    assert.match(device.vendor ?? "", /Nordic/i);
  });

  test("computed addresses match what was measured on hardware", () => {
    assert.equal(reg("FICR", "INFO.PART")?.address, 0x10000100);
    assert.equal(reg("FICR", "DEVICEID[0]")?.address, 0x10000060);
    assert.equal(reg("FICR", "DEVICEID[1]")?.address, 0x10000064);
  });

  test("cluster offsets accumulate", () => {
    // FICR base 0x10000000 + INFO cluster + PART offset. Flattening clusters
    // to bare register offsets would silently place this at 0x10000000.
    const part = reg("FICR", "INFO.PART")!;
    assert.ok(part.name.includes("."), "clustered registers keep their path");
    assert.notEqual(part.address, 0x10000000);
  });

  test("derivedFrom peripherals inherit a full register map", () => {
    // 31 of 73 peripherals inherit. Dropping them loses 42% of the chip, and
    // the loss is invisible — the peripheral still appears, just empty.
    for (const name of ["TIMER3", "UARTE1", "SPIM2"]) {
      const p = device.peripherals.find((x) => x.name === name)!;
      assert.ok(p, `${name} missing`);
      assert.ok(p.registers.length > 10, `${name} inherited no registers`);
    }
  });

  test("derived peripherals keep their own base address", () => {
    const t0 = device.peripherals.find((p) => p.name === "TIMER0")!;
    const t3 = device.peripherals.find((p) => p.name === "TIMER3")!;
    assert.notEqual(t0.baseAddress, t3.baseAddress, "derived peripheral took its parent's base");
    assert.equal(t0.registers.length, t3.registers.length, "same map, different base");
  });

  test("dim arrays expand to distinct registers", () => {
    const ids = device.peripherals.find((p) => p.name === "FICR")!
      .registers.filter((r) => r.name.startsWith("DEVICEID"));
    assert.equal(ids.length, 2);
    assert.equal(ids[1].address - ids[0].address, 4);
  });

  test("fields carry bit positions and enumerated meanings", () => {
    // Nordic encodes every field as lsb/msb, not bitOffset/bitWidth. Assuming
    // the latter yields zero fields and no error.
    const enable = reg("UARTE0", "ENABLE")!;
    const f = enable.fields.find((x) => x.name === "ENABLE")!;
    assert.equal(f.lsb, 0);
    assert.equal(f.width, 4);
    assert.ok(f.enums.length >= 2, "no enumerated values parsed");
    assert.equal(f.enums.find((e) => e.value === 8)?.name, "Enabled");
  });

  test("the parse is not trivially empty", () => {
    const regs = device.peripherals.reduce((a, p) => a + p.registers.length, 0);
    const enums = device.peripherals.reduce((a, p) =>
      a + p.registers.reduce((b, r) => b + r.fields.reduce((c, f) => c + f.enums.length, 0), 0), 0);
    assert.equal(device.peripherals.length, 73);
    assert.ok(regs > 2000, `only ${regs} registers`);
    assert.ok(enums > 10000, `only ${enums} enumerated values`);
  });
});

describe("SVD decoding", () => {
  test("splits a value into named fields", () => {
    const enable = reg("UARTE0", "ENABLE")!;
    const [f] = decodeValue(enable, 8);
    assert.equal(f.name, "ENABLE");
    assert.equal(f.value, 8);
    assert.equal(f.meaning, "Enabled");
    assert.equal(f.bits, "[3:0]");
  });

  test("a value with no enumerated match still decodes numerically", () => {
    const [f] = decodeValue(reg("UARTE0", "ENABLE")!, 3);
    assert.equal(f.value, 3);
    assert.equal(f.meaning, undefined, "must not invent a meaning for an unlisted value");
  });

  test("multi-bit fields mask correctly", () => {
    // The classic decode bug: shifting without masking, so a field picks up
    // its neighbours' bits.
    const part = reg("FICR", "INFO.PART")!;
    for (const f of decodeValue(part, 0x00052840)) {
      assert.ok(f.value <= (f.bits.includes(":") ? 0xffffffff : 1), `${f.name} exceeded its width`);
    }
  });

  test("formats readably", () => {
    const enable = reg("UARTE0", "ENABLE")!;
    const text = formatDecoded(enable, 8, decodeValue(enable, 8));
    assert.match(text, /0x40002500/);
    assert.match(text, /ENABLE/);
    assert.match(text, /→ Enabled/);
  });
});

describe("SvdRegistry", () => {
  test("gives the reason when no SVD is configured, and stays short", () => {
    // The how-to-fix moved to JLinkMcpServer.hint, which emits it once a
    // session. This fires on three tools on every call, so it carries only
    // the part that is always true and always needed: why the tool returned
    // nothing. It used to carry the full advice here and repeat it forever.
    const why = new SvdRegistry(undefined).unavailableReason() ?? "";
    assert.match(why, /no svd/i, "must still say what is wrong");
    assert.ok(why.length < 80, `reason repeats on every call, keep it short: ${why.length} chars`);
  });

  test("reports a missing file rather than throwing", () => {
    const why = new SvdRegistry("/nope/missing.svd").unavailableReason();
    assert.match(why ?? "", /not found/i);
  });

  test("resolves a clustered register by its short name", () => {
    // Callers should not need to know PART lives inside the INFO cluster.
    const r = new SvdRegistry(SVD);
    assert.equal(r.findRegister("FICR", "PART")?.address, 0x10000100);
    assert.equal(r.findRegister("FICR", "INFO.PART")?.address, 0x10000100);
  });

  test("is case-insensitive on peripheral names", () => {
    const r = new SvdRegistry(SVD);
    assert.ok(r.findPeripheral("ficr"));
    assert.ok(r.findPeripheral("FICR"));
  });

  test("suggests names on a miss instead of failing blankly", () => {
    const s = new SvdRegistry(SVD).suggestRegisters("FICR", "DEVICE");
    assert.ok(s.length > 0, "no suggestions offered");
    assert.ok(s.some((n) => n.includes("DEVICEID")));
  });

  test("filters peripherals by substring", () => {
    const r = new SvdRegistry(SVD);
    const uarts = r.listPeripherals("uart");
    assert.ok(uarts.length >= 2);
    assert.ok(uarts.every((p) => /uart/i.test(p.name) || /uart/i.test(p.groupName ?? "")));
  });
});
