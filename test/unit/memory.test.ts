import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseLittleEndian32, decodeFaultRegisters } from "../../src/probe/backend";
import { golden, StubBackend, FakeGdbBridge } from "../helpers";
import { JLinkBackend } from "../../src/probe/jlink";
import { ProcessManager } from "../../src/utils/process-manager";

const probe = new StubBackend();

describe("parseMemoryDump — J-Link format", () => {
  const dump = probe.parseMemoryDump(golden("jlink-mem-fault-regs.txt"));

  test("parses both dump lines and ignores the prompt", () => {
    assert.equal(dump.length, 2);
  });

  test("extracts addresses", () => {
    assert.equal(dump[0].address, "0xE000ED28");
    assert.equal(dump[1].address, "0xE000ED38");
  });

  test("splits hex from the ASCII column", () => {
    assert.equal(dump[0].hex, "00 82 00 00 00 00 00 40  01 00 00 00 00 00 00 00");
    assert.equal(dump[0].ascii, ".......@........");
  });

  test("handles a short final line", () => {
    assert.equal(dump[1].hex, "00 00 00 00");
  });

  test("yields exactly the bytes that were read", () => {
    const bytes = dump.map((d) => d.hex).join(" ").split(/\s+/).filter(Boolean);
    assert.equal(bytes.length, 20);
  });
});

describe("parseMemoryDump — the 8|8 byte grouping", () => {
  // J-Link separates the two 8-byte halves of a 16-byte line with a double
  // space, the same separator that precedes the ASCII column. Matching the
  // hex field as "anything up to two spaces" stops at the first one and
  // drops half the line. This literal is the example from parseMemoryDump's
  // own doc comment — the shipped regex failed on it, which starved
  // readFaultRegisters of its 16-byte minimum and made diagnose_crash report
  // "no faults detected" during a live crash.
  const line = "E000ED28 = 00 00 00 00 00 00 00 00  01 00 00 00 74 28 06 20  ............t(. ";
  const dump = probe.parseMemoryDump(line);

  test("keeps all sixteen bytes", () => {
    assert.equal(dump.length, 1);
    assert.equal(dump[0].hex.split(/\s+/).filter(Boolean).length, 16);
  });

  test("does not leak hex bytes into the ASCII column", () => {
    assert.equal(dump[0].ascii, "............t(.");
    assert.ok(!/[0-9A-F]{2} [0-9A-F]{2}/.test(dump[0].ascii), "hex leaked into ascii");
  });

  test("decodes to the right words", () => {
    const bytes = dump[0].hex.split(/\s+/).filter(Boolean);
    assert.equal(parseLittleEndian32(bytes, 8), 0x00000001);
    assert.equal(parseLittleEndian32(bytes, 12), 0x20062874);
  });

  test("handles a line with no ASCII column at all", () => {
    const d = probe.parseMemoryDump("20000000 = DE AD BE EF");
    assert.equal(d.length, 1);
    assert.equal(d[0].hex, "DE AD BE EF");
    assert.equal(d[0].ascii, "");
  });
});

describe("parseMemoryDump — GDB/OpenOCD format", () => {
  test("parses the `0xaddr: bytes` form", () => {
    const dump = probe.parseMemoryDump("0xe000ed28: 00 82 00 00 00 00 00 40");
    assert.equal(dump.length, 1);
    assert.equal(dump[0].address, "0xe000ed28");
    assert.equal(dump[0].hex, "00 82 00 00 00 00 00 40");
  });

  test("ignores lines that are not dumps", () => {
    assert.equal(probe.parseMemoryDump("Reading symbols from fixture.elf...").length, 0);
    assert.equal(probe.parseMemoryDump("").length, 0);
  });
});

describe("parseLittleEndian32", () => {
  test("assembles bytes little-endian", () => {
    assert.equal(parseLittleEndian32(["00", "82", "00", "00"], 0), 0x00008200);
    assert.equal(parseLittleEndian32(["EF", "BE", "AD", "DE"], 0), 0xdeadbeef);
  });

  test("honours the offset", () => {
    const bytes = ["00", "00", "00", "00", "00", "00", "00", "40"];
    assert.equal(parseLittleEndian32(bytes, 4), 0x40000000);
  });

  test("returns unsigned for values with the high bit set", () => {
    assert.equal(parseLittleEndian32(["00", "00", "00", "80"], 0), 0x80000000);
    assert.ok(parseLittleEndian32(["FF", "FF", "FF", "FF"], 0) > 0);
  });

  test("returns 0 rather than NaN when reading past the end", () => {
    assert.equal(parseLittleEndian32(["00", "01"], 0), 0);
    assert.equal(parseLittleEndian32([], 0), 0);
  });

  test("accepts 0x-prefixed bytes as GDB emits them", () => {
    assert.equal(parseLittleEndian32(["0x00", "0x82", "0x00", "0x00"], 0), 0x00008200);
  });
});

describe("decodeFaultRegisters", () => {
  test("reports no faults when CFSR and HFSR are clear", () => {
    assert.match(decodeFaultRegisters(0, 0, 0, 0), /No faults detected/);
  });

  test("decodes a precise bus fault with a valid BFAR", () => {
    const decoded = decodeFaultRegisters(0x00008200, 0x40000000, 0, 0);
    assert.match(decoded, /BusFault/);
    assert.match(decoded, /PRECISERR/);
    assert.match(decoded, /BFARVALID/);
  });

  test("separates the CFSR sub-registers", () => {
    // CFSR = UFSR<<16 | BFSR<<8 | MMFSR. A usage fault must not be reported
    // as a memmanage fault and vice versa.
    const usage = decodeFaultRegisters(0x01000000, 0, 0, 0);
    assert.match(usage, /UsageFault|UFSR/);
    assert.doesNotMatch(usage, /MemManage Fault \(MMFSR\)/);

    const mem = decodeFaultRegisters(0x00000001, 0, 0, 0);
    assert.match(mem, /MemManage/);
  });
});

describe("readFaultRegisters — end to end from a memory transcript", () => {
  test("decodes the J-Link dump into CFSR/HFSR/MMFAR/BFAR", async () => {
    const backend = new StubBackend();
    const raw = golden("jlink-mem-fault-regs.txt");
    backend.memoryResponses = [{ success: true, rawOutput: raw, output: raw }];

    const { raw: values, decoded } = await backend.readFaultRegisters();
    assert.equal(values.cfsr, 0x00008200);
    assert.equal(values.hfsr, 0x40000000);
    assert.equal(values.bfar, 0x00000000);
    assert.match(decoded, /PRECISERR/);
  });
});

describe("readMemory via the GDB bridge", () => {
  const bridge = new FakeGdbBridge({
    "x/": [
      "0xe000ed28:\t0x00\t0x82\t0x00\t0x00\t0x00\t0x00\t0x00\t0x40",
      "0xe000ed30:\t0x01\t0x00\t0x00\t0x00\t0x00\t0x00\t0x00\t0x00",
      "0xe000ed38:\t0x00\t0x00\t0x00\t0x00",
    ].join("\n"),
  });
  const backend = new JLinkBackend({ device: "NRF52840_XXAA" }, new ProcessManager());
  backend.setGdbBridge(bridge);

  test("issues a byte-wise examine of the right length", async () => {
    await backend.readMemory(0xe000ed28, 20);
    assert.equal(bridge.sent[0], "x/20bx 0xe000ed28");
  });

  test("normalizes GDB output so the shared dump parser accepts it", async () => {
    const r = await backend.readMemory(0xe000ed28, 20);
    const dump = backend.parseMemoryDump(r.rawOutput);
    assert.equal(dump.length, 3);
    assert.equal(dump[0].address, "0xE000ED28");
  });

  test("produces the same fault values as the J-Link channel", async () => {
    // The whole point of normalizing: readFaultRegisters must not care which
    // channel served the read.
    const r = await backend.readMemory(0xe000ed28, 20);
    const bytes = backend.parseMemoryDump(r.rawOutput)
      .map((d) => d.hex).join(" ").split(/\s+/).filter(Boolean);
    assert.equal(bytes.length, 20);
    assert.equal(parseLittleEndian32(bytes, 0), 0x00008200);
    assert.equal(parseLittleEndian32(bytes, 4), 0x40000000);
  });

  test("renders printable bytes in the ASCII column", async () => {
    const b2 = new FakeGdbBridge({ "x/": "0x20000000:\t0x41\t0x42\t0x00\t0x7f" });
    const backend2 = new JLinkBackend({ device: "NRF52840_XXAA" }, new ProcessManager());
    backend2.setGdbBridge(b2);
    const r = await backend2.readMemory(0x20000000, 4);
    // 0x41 0x42 print; 0x00 and 0x7f are non-printable and become dots.
    assert.match(r.rawOutput, /AB\.\./);
  });
});
