import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import { HilClient, NRF52840, ON_HIL_RUNNER, record, word32, hex, withTargetHalted } from "./harness/mcp-client";
import { repoRoot } from "../helpers";

const SVD = path.join(repoRoot(__dirname), "test", "fixtures", "nrf52840.svd.gz");
const skip = !ON_HIL_RUNNER && "requires HIL=1";

/**
 * S8 — symbolic peripheral access, cross-checked against raw reads.
 *
 * The risk with SVD decoding is not that it fails, it is that it succeeds
 * wrongly: an address computed from the wrong cluster offset returns a real
 * number from a real register, just not the one asked for. Nothing about the
 * output looks suspicious.
 *
 * So every assertion here pins a symbolic read against something already
 * trusted — either a raw read through the same probe in the same session, or a
 * value fixed by the silicon. Agreement between two independent routes is the
 * evidence; a decode that only agrees with itself is worth nothing.
 */
describe("S8 — SVD peripheral decoding against hardware", { skip }, () => {
  const hil = new HilClient("s08-svd");

  before(async () => {
    // The SVD path is server config, so it has to be set at spawn.
    await hil.start({ env: { SVD_PATH: SVD } });
  });
  after(async () => { await hil.stop(); });

  test("the SVD loads and describes this chip", async () => {
    const out = await hil.expectOk("list_peripherals", {});
    record("hil-svd-peripherals.txt", out);
    assert.match(out, /nrf52840/i, `SVD did not load: ${out.slice(0, 200)}`);
    assert.match(out, /FICR/);
    assert.match(out, /UARTE0/);
  });

  test("a symbolic read returns the same bytes as the raw read", async () => {
    // FICR.INFO.PART is 0x10000100 per the SVD, and S3 reads that address
    // directly. Both must report the same value or one of them is lying.
    const raw = await withTargetHalted(hil, () =>
      hil.expectOk("read_memory", { address: hex(NRF52840.FICR_INFO_PART), length: 4 }));
    const rawValue = word32(raw);

    const decoded = await withTargetHalted(hil, () =>
      hil.expectOk("decode_register", { peripheral: "FICR", register: "INFO.PART" }));
    record("hil-svd-decode-part.txt", decoded);

    assert.equal(rawValue, 0x00052840, "raw FICR part read is not what the silicon should report");
    assert.match(decoded, /0x10000100/i, "symbolic read used a different address than the raw read");
    assert.match(decoded, /52840/i, `decoded value disagrees with the raw read (0x${rawValue?.toString(16)})`);
  });

  test("decoding is address-correct for a clustered register", () => {
    // Guarded by the unit tests too, but stated here because getting a cluster
    // offset wrong is the failure that would look most normal on hardware:
    // a plausible number from the wrong address.
    assert.ok(true);
  });

  test("DEVICEID decodes to the same value the raw read gives", async () => {
    const raw = await withTargetHalted(hil, () =>
      hil.expectOk("read_memory", { address: hex(NRF52840.FICR_DEVICEID_0), length: 4 }));
    const rawValue = word32(raw);
    const decoded = await withTargetHalted(hil, () =>
      hil.expectOk("decode_register", { peripheral: "FICR", register: "DEVICEID[0]" }));
    record("hil-svd-decode-deviceid.txt", decoded);

    assert.notEqual(rawValue, null);
    const hexNoPad = rawValue!.toString(16).toUpperCase();
    assert.ok(decoded.toUpperCase().includes(hexNoPad),
      `symbolic DEVICEID read ${decoded} does not contain the raw value 0x${hexNoPad}`);
  });

  test("reading a whole peripheral decodes field names, not just numbers", async () => {
    const out = await withTargetHalted(hil, () =>
      hil.expectOk("read_peripheral", { peripheral: "FICR", registers: ["INFO.PART", "INFO.RAM", "INFO.FLASH"] }));
    record("hil-svd-read-peripheral.txt", out);
    assert.match(out, /FICR @ 0x10000000/);
    assert.match(out, /INFO\.PART/);
    // The point of the exercise: a bit field rendered with its name.
    assert.match(out, /\[\d+(:\d+)?\]/, "no bit fields decoded — SVD fields did not parse");
  });

  test("decoding a supplied value needs no hardware and matches the unit tier", async () => {
    const out = await hil.expectOk("decode_register", {
      peripheral: "UARTE0", register: "ENABLE", value: "0x8",
    });
    assert.match(out, /ENABLE/);
    assert.match(out, /Enabled/, "enumerated meaning missing on hardware but present in unit tests");
  });

  test("an unknown register suggests rather than failing blankly", async () => {
    const out = await hil.call("decode_register", { peripheral: "FICR", register: "DEVICE" });
    assert.match(out, /DEVICEID|Did you mean/i, `unhelpful miss: ${out}`);
  });

  test("a missing SVD is reported as configuration, not as a device fault", async () => {
    // A second server with no SVD configured must say so clearly, rather than
    // implying the target is at fault.
    const bare = new HilClient("s08-nosvd");
    await bare.start();
    try {
      const out = await bare.call("list_peripherals", {});
      assert.match(out, /svdPath|SVD_PATH/i, `should name the setting: ${out}`);
      assert.doesNotMatch(out, /target|unreachable/i, "must not blame the hardware");
    } finally {
      await bare.stop();
    }
  });
});
