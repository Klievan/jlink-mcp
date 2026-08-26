import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  HilClient, ON_HIL_RUNNER, record, RTT_FIXTURE_HEX, sym, word32, hex, reg,
} from "./harness/mcp-client";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const skip = !ON_HIL_RUNNER && "requires HIL=1";

/**
 * S6 — RTT, against firmware that actually talks.
 *
 * Everything here was previously untestable on hardware: the target was a
 * silent spin loop, so the eleven rtt_* and command-channel behaviours had
 * only synthetic fixtures behind them.
 */
describe("S6 — RTT logging and the down channel", { skip }, () => {
  const hil = new HilClient("s06-rtt");

  before(async () => {
    await hil.start();
    await hil.expectOk("flash", { filePath: RTT_FIXTURE_HEX });
    await hil.expectOk("gdb_server_start");
    await sleep(1500);
    // Get the target running BEFORE connecting RTT. The probe locates the RTT
    // control block by scanning RAM at connect time, and this firmware writes
    // it at boot — as SEGGER's own does, deliberately, so a half-booted target
    // is not mistaken for a ready one. Connect too early and the scan finds
    // nothing and is never retried: RTT stays silent forever with no error.
    await hil.expectOk("reset", { halt: false });
    await hil.expectOk("resume");
    await sleep(1000); // let rtt_init run
    await hil.expectOk("rtt_connect");
    await sleep(1500); // let the boot banner land
  });

  after(async () => {
    await hil.call("rtt_disconnect");
    await hil.call("gdb_server_stop");
    await hil.stop();
  });

  test("DIAGNOSTIC: what is the target actually doing", async () => {
    // Three rounds of hypothesising about RTT silence is two too many. This
    // records the whole picture in one place so the next run answers the
    // question instead of narrowing it: is the firmware executing, did it
    // build the RTT control block, and is the counter moving?
    //
    // Deliberately assertion-light — it fails only on the one thing that
    // makes every other test in this suite meaningless.
    const regs = await hil.expectOk("read_registers");
    const pc = reg(regs, "PC");
    const parts: string[] = [`PC=0x${pc?.toString(16)}`];

    for (const [name, sym_] of [["Reset_Handler", "Reset_Handler"], ["main", "main"],
                                ["Fault_Handler", "Fault_Handler"], ["_SEGGER_RTT", "_SEGGER_RTT"]] as const) {
      parts.push(`${name}=0x${sym(sym_).toString(16)}`);
    }

    // Is the SEGGER ID actually in RAM? If rtt_init ran, the first 16 bytes
    // of the control block spell "SEGGER RTT". If they are zero the firmware
    // never got there; if they are garbage it is not running our image.
    const cb = await hil.expectOk("read_memory", { address: hex(sym("_SEGGER_RTT")), length: 48 });
    record("hil-rtt-controlblock.txt", cb);
    parts.push(`control block:\n${cb}`);

    // Does the counter move across a genuine run window?
    await hil.expectOk("halt");
    const c1 = word32(await hil.expectOk("read_memory", { address: hex(sym("test_counter")), length: 4 }));
    const s1 = word32(await hil.expectOk("read_memory", { address: hex(sym("test_seq")), length: 4 }));
    await hil.expectOk("resume");
    await sleep(500);
    await hil.expectOk("halt");
    const c2 = word32(await hil.expectOk("read_memory", { address: hex(sym("test_counter")), length: 4 }));
    const s2 = word32(await hil.expectOk("read_memory", { address: hex(sym("test_seq")), length: 4 }));
    await hil.expectOk("resume");
    parts.push(`test_counter: ${c1} -> ${c2}`, `test_seq: ${s1} -> ${s2}`);

    const report = parts.join("\n");
    record("hil-rtt-diagnostic.txt", report);

    const ascii = (cb.match(/  ([ -~]+)\s*$/m) ?? [])[1] ?? "";
    assert.ok(/SEGGER/.test(cb) || /SEGGER/.test(ascii),
      `the RTT control block was never initialised — the firmware is not reaching rtt_init.\n${report}`);
  });

  test("the boot banner arrives", async () => {
    const out = await hil.expectOk("rtt_read", { count: 50 });
    record("hil-rtt-boot.txt", out);
    assert.match(out, /fixture ready/, `no boot output: ${JSON.stringify(out.slice(0, 200))}`);
  });

  test("lines parse into level and module", async () => {
    const out = await hil.expectOk("rtt_read", { count: 50 });
    // The Zephyr shape the parser expects: [ts] <level> module: message
    assert.match(out, /\[\d{2}:\d{2}:\d{2}\.\d{3},\d{3}\] <inf> hil_fixture:/);
    assert.match(out, /<dbg> sensor_drv:/);
  });

  test("search filters by level", async () => {
    const errs = await hil.expectOk("rtt_search", { level: "wrn" });
    record("hil-rtt-search-level.txt", errs);
    assert.match(errs, /out of range/);
    assert.ok(!/<inf>/.test(errs), "level filter leaked other levels");
  });

  test("search filters by module", async () => {
    const out = await hil.expectOk("rtt_search", { module: "sensor_drv" });
    assert.match(out, /sensor_drv/);
    assert.ok(!/hil_fixture/.test(out), "module filter leaked another module");
  });

  test("search filters by regex", async () => {
    const out = await hil.expectOk("rtt_search", { pattern: "seq=\\d+" });
    assert.match(out, /seq=\d+/);
  });

  test("the down channel round-trips", async () => {
    // Proves rtt_send reaches the target and its reply comes back up — the
    // one behaviour a one-way log stream cannot demonstrate.
    await hil.expectOk("rtt_clear");
    await hil.expectOk("rtt_send", { data: "echo:round-trip-ok\n" });
    await sleep(800);
    const out = await hil.expectOk("rtt_read", { count: 50 });
    record("hil-rtt-echo.txt", out);
    assert.match(out, /round-trip-ok/, `echo did not come back: ${JSON.stringify(out.slice(0, 200))}`);
  });

  test("rtt_clear empties the buffer", async () => {
    await hil.expectOk("rtt_clear");
    const out = await hil.expectOk("rtt_read", { count: 50 });
    assert.ok(out.trim().length === 0 || !/fixture ready/.test(out), "buffer not cleared");
  });

  test("a burst arrives without gaps in the sequence", async () => {
    // The fixture numbers every line. A gap means a drop, which is otherwise
    // indistinguishable from the target simply having been quiet.
    await hil.expectOk("rtt_clear");
    await hil.expectOk("rtt_send", { data: "burst\n" });
    await sleep(2000);
    const out = await hil.expectOk("rtt_read", { count: 200 });
    record("hil-rtt-burst.txt", out);

    const seqs = [...out.matchAll(/seq=(\d+)/g)].map((m) => Number(m[1]));
    assert.ok(seqs.length > 50, `expected a burst, got ${seqs.length} lines`);
    for (let i = 1; i < seqs.length; i++) {
      assert.equal(seqs[i], seqs[i - 1] + 1,
        `sequence gap: ${seqs[i - 1]} -> ${seqs[i]} (${seqs.length - i} lines in). RTT dropped data.`);
    }
  });

  test("the target keeps running while RTT is connected", async () => {
    // Sample either side of a run window. Memory cannot be read while a
    // synchronous remote is executing, so halting to read is not an
    // observation error — it is the only way to observe at all.
    await hil.expectOk("halt");
    const a = word32(await hil.expectOk("read_memory", { address: hex(sym("test_counter")), length: 4 }));
    await hil.expectOk("resume");
    await sleep(400);
    await hil.expectOk("halt");
    const b = word32(await hil.expectOk("read_memory", { address: hex(sym("test_counter")), length: 4 }));
    await hil.expectOk("resume");

    assert.notEqual(a, null, "could not read the counter");
    assert.notEqual(a, b, "counter frozen — RTT polling should not stall the target");
  });

  test("a reset does not kill the RTT stream", async () => {
    // The bug this suite walked into. The GDB server hosts the RTT telnet
    // port, but CPU-control routing keyed off whether a GDB *client* was
    // attached — so with a server up and no client, reset spawned a competing
    // JLinkExe, evicted the server, and took RTT down with it. Silent, and
    // reachable straight from start_debug_session.
    await hil.expectOk("rtt_clear");
    await hil.expectOk("reset", { halt: false });
    await hil.expectOk("resume");
    await sleep(1500);

    const out = await hil.expectOk("rtt_read", { count: 50 });
    record("hil-rtt-after-reset.txt", out);
    assert.match(out, /fixture ready/,
      `RTT produced nothing after a reset — the server was probably evicted: ${JSON.stringify(out.slice(0, 200))}`);

    // And the server should still be up to have served it.
    assert.match(await hil.expectOk("gdb_server_status"), /"running": true/);
  });

  test("disconnect and reconnect works", async () => {
    await hil.expectOk("rtt_disconnect");
    await hil.expectOk("rtt_connect");
    await hil.expectOk("rtt_send", { data: "echo:after-reconnect\n" });
    await sleep(800);
    assert.match(await hil.expectOk("rtt_read", { count: 50 }), /after-reconnect/);
  });
});
