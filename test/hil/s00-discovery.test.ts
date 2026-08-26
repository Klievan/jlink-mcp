import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { HilClient, NRF52840, ON_HIL_RUNNER, record } from "./harness/mcp-client";

describe("S0 — discovery and configuration", { skip: !ON_HIL_RUNNER && "requires HIL=1" }, () => {
  const hil = new HilClient("s00-discovery");
  before(async () => { await hil.start(); });
  after(async () => { await hil.stop(); });

  test("the server advertises its full tool surface", async () => {
    const tools = await hil.listTools();
    // Spot-check the ones the debugging workflow depends on rather than
    // pinning an exact count, which would churn on every new tool.
    for (const t of ["list_devices", "set_device", "get_config", "device_info",
                     "halt", "resume", "reset", "step", "read_memory",
                     "write_memory", "read_registers", "read_register",
                     "flash", "erase", "snapshot", "diagnose_crash"]) {
      assert.ok(tools.includes(t), `missing tool: ${t}`);
    }
  });

  test("list_devices sees the probe", async () => {
    const out = await hil.expectOk("list_devices");
    record("hil-list-devices.txt", out);
    assert.match(out, /J-Link/i, "probe not enumerated — check USB passthrough");
  });

  test("get_config reflects the configured device", async () => {
    const out = await hil.expectOk("get_config");
    record("hil-get-config.txt", out);
    // get_config used to omit the target device entirely, which made
    // set_device unverifiable through the config surface and left an LLM
    // asking "what am I pointed at?" with no answer.
    assert.match(out, new RegExp(NRF52840.device, "i"), 'get_config does not report the configured device');
  });

  test("device_info returns something about the target", async () => {
    const out = await hil.expectOk("device_info");
    record("hil-device-info.txt", out);
    assert.ok(out.trim().length > 0, "device_info returned nothing");
  });

  test("set_device switches the target at runtime", async () => {
    await hil.expectOk("set_device", { device: "NRF52832_XXAA" });
    assert.match(await hil.expectOk("get_config"), /NRF52832/i);
    // Put it back — later suites in this process depend on it.
    await hil.expectOk("set_device", { device: NRF52840.device });
    assert.match(await hil.expectOk("get_config"), new RegExp(NRF52840.device, "i"));
  });

  test("an unknown device fails without hanging", async () => {
    await hil.expectOk("set_device", { device: "DEFINITELY_NOT_A_PART" });
    const started = Date.now();
    const out = await hil.call("halt");
    const elapsed = Date.now() - started;

    // The contract is a structured answer in bounded time. J-Link's own
    // timeout is 30s, so anything past that means we hung rather than failed.
    assert.ok(elapsed < 40_000, `took ${elapsed}ms — should fail fast`);
    assert.ok(out.trim().length > 0, "silent failure gives an LLM nothing to act on");
    record("hil-bad-device-halt.txt", out);

    await hil.expectOk("set_device", { device: NRF52840.device });
  });
});
