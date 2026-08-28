import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { JLinkBackend } from "../../src/probe/jlink";
import { repoRoot } from "../helpers";

/**
 * `set_device` takes an exact string, and until now the only guidance was two
 * examples in a tool description — so a caller working on any other chip was
 * guessing part numbers, and a wrong guess fails in a way that looks like
 * broken hardware rather than a typo.
 *
 * J-Link knows the answer. `ExpDevList` dumps the DLL's internal list: 9818
 * devices across 75 manufacturers on V7.80c, and it writes the file even with
 * no probe attached — measured, with the connect failing and the export
 * succeeding anyway.
 *
 * The lines below are copied verbatim from that dump.
 */
const SAMPLE = fs.readFileSync(
  path.join(repoRoot(__dirname), "test", "fixtures", "jlink-devlist-sample.txt"), "utf8");

describe("J-Link device list parsing", () => {
  const parsed = JLinkBackend.parseDeviceList(SAMPLE);
  const byName = (n: string) => parsed.find((d) => d.name === n)!;

  test("skips the header rather than parsing it as a device", () => {
    assert.ok(!parsed.some((d) => d.name === "Device"), "the header row is not a part");
    assert.equal(parsed.length, 4);
  });

  test("reads the single-area form", () => {
    const d = byName("STM32F407IE");
    assert.equal(d.manufacturer, "ST");
    assert.equal(d.core, "Cortex-M4");
    assert.equal(d.flashSize, 0x80000);
    assert.equal(d.ramSize, 0x20000);
  });

  test("sums flash across the nested multi-area form", () => {
    // Nordic nests an extra brace level and lists two flash regions — code
    // flash plus UICR. Matching the punctuation would have missed this; taking
    // the numbers in order and treating the last pair as RAM does not.
    const d = byName("nRF52840_xxAA");
    assert.equal(d.flashSize, 0x100000 + 0x1000);
    assert.equal(d.ramSize, 0x40000, "RAM is the final pair, whatever precedes it");
    assert.equal(d.core, "Cortex-M4");
  });

  test("keeps variants that differ only in flash distinguishable", () => {
    // The whole point for a caller reading a part number off a board: an
    // STM32F407IE and an IG differ by nothing else.
    assert.notEqual(byName("STM32F407IE").flashSize, byName("STM32F407IG").flashSize);
  });

  test("handles a core name that is not Cortex-M4", () => {
    assert.equal(byName("nRF5340_xxAA_APP").core, "Cortex-M33");
  });

  test("ignores blank and malformed lines instead of throwing", () => {
    const out = JLinkBackend.parseDeviceList('\n\ngarbage\n"A", "B"\n' + SAMPLE);
    assert.equal(out.length, 4);
  });
});

describe("line endings", () => {
  // J-Link writes CRLF on every platform, including macOS and Linux. In
  // JavaScript `.` does not match \r — it is a line terminator — so `(.*)$`
  // failed on every line and the parse returned nothing.
  //
  // Silently, which is the dangerous part: an empty device list is
  // indistinguishable from a J-Link that has no list, so the tool would have
  // reported "could not read the device list" on a file it had read perfectly.
  const LINE = '"ST", "STM32F407IE", "Cortex-M4", {0x08000000, 0x00080000}, {0x20000000, 0x00020000}';

  test("parses CRLF, which is what J-Link actually writes", () => {
    const out = JLinkBackend.parseDeviceList(`header\r\n${LINE}\r\n`);
    assert.equal(out.length, 1, "CRLF input must not parse to nothing");
    assert.equal(out[0].name, "STM32F407IE");
  });

  test("parses LF too", () => {
    assert.equal(JLinkBackend.parseDeviceList(`header\n${LINE}\n`).length, 1);
  });

  test("a trailing carriage return does not leak into the last field", () => {
    const d = JLinkBackend.parseDeviceList(`${LINE}\r\n`)[0];
    assert.equal(d.ramSize, 0x20000, "the final field must parse despite the \\r");
  });
});
