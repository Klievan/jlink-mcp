import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { stripBoilerplate } from "../../src/probe/jlink";
import { golden } from "../helpers";

/**
 * `output` is the field tools quote when they show what a probe returned. On
 * Windows the prompt has no trailing newline, so the data line arrives glued
 * ("J-Link>58020400 = ...") — classifying that prefix as whole-line
 * boilerplate dropped the reading itself. And the banner a V9.x J-Link prints
 * ("Connecting to J-Link ...O.K." without "via USB", AP-scan progress, cache
 * lines, OnDisconnectTarget) matched none of the older patterns and leaked
 * into user-visible failure text.
 */
describe("stripBoilerplate — the Windows transcript", () => {
  const raw = golden("jlink-mem-windows.txt");
  const out = stripBoilerplate(raw);

  test("keeps the dump line the prompt was glued to", () => {
    assert.match(out, /58020400 = BF EA AA A9/, "the reading must survive");
  });

  test("does not leave the prompt behind", () => {
    assert.ok(!out.includes("J-Link>"), "prompt text must not survive");
  });

  test("drops the V9.x banner that used to leak", () => {
    for (const lore of [
      "SEGGER J-Link Commander", "DLL version", "Connecting to J-Link",
      "Firmware: J-Link", "VTref=", 'Device "STM32H723ZG" selected',
      "SWD selected", "DAP initialized", "AP map", "Cortex-M7 identified",
      "I-Cache", "D-Cache", "OnDisconnectTarget",
    ]) {
      assert.ok(!out.toLowerCase().includes(lore.toLowerCase()), `leaked: ${lore}`);
    }
    assert.equal(out.split("\n").length, 1, "only the data line should remain");
  });

  test("leaves an ordinary J-Link output line alone", () => {
    const lf = "10000000 = 00 01 02 03\nE000ED28 = 00 82 00 00";
    assert.equal(stripBoilerplate(lf), lf);
  });
});
