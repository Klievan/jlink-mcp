import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { HilClient, NRF52840, ON_HIL_RUNNER, record, word32, FIXTURE_HEX } from "./harness/mcp-client";
import { repoRoot } from "../helpers";
import * as path from "path";

const { FIXTURE } = require(path.join(repoRoot(__dirname), "test", "hil", "fixture", "build-fixture.js"));

describe("S1 — erase, flash, verify", { skip: !ON_HIL_RUNNER && "requires HIL=1" }, () => {
  const hil = new HilClient();
  before(async () => { await hil.start(); });
  after(async () => { await hil.stop(); });

  test("erase leaves flash blank", async () => {
    await hil.expectOk("erase");
    const out = await hil.expectOk("read_memory", { address: 0, length: 16 });
    record("hil-read-erased-flash.txt", out);
    assert.equal(word32(out, 0), 0xffffffff, "erased flash should read back all ones");
  });

  test("flash writes the fixture image", async () => {
    const out = await hil.expectOk("flash", { filePath: FIXTURE_HEX });
    record("hil-flash.txt", out);
  });

  test("the vector table reads back exactly what we flashed", async () => {
    // Ground truth straight out of the generator — no interpretation.
    const out = await hil.expectOk("read_memory", { address: 0, length: 16 });
    record("hil-read-vector-table.txt", out);
    assert.equal(word32(out, 0), FIXTURE.INITIAL_MSP, "initial MSP");
    assert.equal(word32(out, 1), FIXTURE.RESET_HANDLER | 1, "reset vector (Thumb bit set)");
    assert.equal(word32(out, 2), FIXTURE.FAULT_TRAP | 1, "NMI vector");
    assert.equal(word32(out, 3), FIXTURE.FAULT_TRAP | 1, "HardFault vector");
  });

  test("the constant block reads back byte for byte", async () => {
    const out = await hil.expectOk("read_memory", { address: FIXTURE.CONST_BLOCK, length: 32 });
    record("hil-read-const-block.txt", out);

    // Printable ASCII, then a 00..07 ramp, then an F8..FF run — chosen so the
    // dump's ASCII column carries both printable and non-printable bytes.
    assert.equal(word32(out, 0), 0x4e494c4a, "'JLIN' little-endian");
    assert.equal(word32(out, 4), 0x03020100, "ramp 00 01 02 03");
    assert.equal(word32(out, 7), 0xfffefdfc, "high run FC FD FE FF");
  });

  test("the spin loop instructions survived the round trip", async () => {
    const out = await hil.expectOk("read_memory", { address: FIXTURE.SPIN_LOOP, length: 8 });
    record("hil-read-spin-loop.txt", out);
    // adds r1,#1 / str r1,[r0]  then  b .-8 / nop
    assert.equal(word32(out, 0), 0x60013101);
    assert.equal(word32(out, 1), 0xbf00e7fc);
  });

  test("flashing a nonexistent file fails cleanly", async () => {
    const out = await hil.call("flash", { filePath: "/nonexistent/nope.hex" });
    assert.ok(out.trim().length > 0, "should explain the failure");
    // And the session must survive it.
    assert.equal(word32(await hil.expectOk("read_memory", { address: 0, length: 4 }), 0),
      FIXTURE.INITIAL_MSP, "a failed flash must not wedge the probe");
  });
});
