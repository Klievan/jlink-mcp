import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  HilClient, ON_HIL_RUNNER, record, RTT_FIXTURE_HEX, sym, word32, hex, reg, withTargetHalted,
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
    // Disarm before starting, not just on teardown. Debug comparators live on
    // the target and survive both reset and reflash, so this suite inherits
    // whatever earlier suites armed — and an address armed against the old
    // fixture traps in this one too, because comparators match addresses, not
    // images. S2b steps the old fixture's loop at 0x44, which is where this
    // firmware happens to put the hot path of rtt_puts.
    await hil.expectOk("clear_breakpoints");
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
    const parts: string[] = [];
    await withTargetHalted(hil, async () => {
      const regs = await hil.expectOk("read_registers");
      parts.push(`PC=0x${reg(regs, "PC")?.toString(16)}`);
    });

    for (const [name, sym_] of [["Reset_Handler", "Reset_Handler"], ["main", "main"],
                                ["Fault_Handler", "Fault_Handler"], ["_SEGGER_RTT", "_SEGGER_RTT"]] as const) {
      parts.push(`${name}=0x${sym(sym_).toString(16)}`);
    }

    // Is the SEGGER ID actually in RAM? If rtt_init ran, the first 16 bytes
    // of the control block spell "SEGGER RTT". If they are zero the firmware
    // never got there; if they are garbage it is not running our image.
    let cb = "";
    await withTargetHalted(hil, async () => {
      cb = await hil.expectOk("read_memory", { address: hex(sym("_SEGGER_RTT")), length: 48 });
      record("hil-rtt-controlblock.txt", cb);
      parts.push(`control block:\n${cb}`);

      // What debug hardware is armed? A comparator matching an address this
      // firmware executes produces a SIGTRAP that looks exactly like a hang.
      const fpb = await hil.expectOk("read_memory", { address: "0xe0002000", length: 48 });
      const dwt = await hil.expectOk("read_memory", { address: "0xe0001000", length: 96 });
      const demcr = await hil.expectOk("read_memory", { address: "0xe000edfc", length: 4 });
      record("hil-debug-hardware.txt", [`FPB (FP_CTRL, FP_REMAP, FP_COMP0..):\n${fpb}`,
                                        `DWT:\n${dwt}`, `DEMCR:\n${demcr}`].join("\n\n"));
      parts.push(`FP_CTRL+comparators:\n${fpb}`, `DEMCR:\n${demcr}`);

      // FP_COMP0..7 start at 0xE0002008, one word each; bit 0 is ENABLE.
      // An armed comparator produces a SIGTRAP that is indistinguishable
      // from a hang, so name it here rather than leaving the next reader to
      // decode the dump.
      const words = [...fpb.matchAll(/^0x[0-9A-Fa-f]+: ((?:[0-9A-Fa-f]{2} ?)+)/gm)]
        .flatMap((m) => m[1].trim().split(/\s+/));
      const armed: string[] = [];
      for (let i = 0; i < 8; i++) {
        const o = 8 + i * 4; // skip FP_CTRL and FP_REMAP
        if (o + 3 >= words.length) break;
        const v = (parseInt(words[o], 16) | (parseInt(words[o + 1], 16) << 8) |
                   (parseInt(words[o + 2], 16) << 16) | (parseInt(words[o + 3], 16) << 24)) >>> 0;
        if (v & 1) armed.push(`FP_COMP${i}=0x${v.toString(16)} (addr 0x${(v & 0x1ffffffc).toString(16)})`);
      }
      parts.push(armed.length ? `ARMED COMPARATORS: ${armed.join(", ")}` : "no comparators armed");
    });

    // Does the counter move across a genuine run window?
    const sample = () => withTargetHalted(hil, async () => ({
      counter: word32(await hil.expectOk("read_memory", { address: hex(sym("test_counter")), length: 4 })),
      seq: word32(await hil.expectOk("read_memory", { address: hex(sym("test_seq")), length: 4 })),
    }));
    const before = await sample();
    await sleep(500);
    const after = await sample();
    parts.push(`test_counter: ${before.counter} -> ${after.counter}`,
               `test_seq: ${before.seq} -> ${after.seq}`);

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
    const read = () => withTargetHalted(hil, () =>
      hil.expectOk("read_memory", { address: hex(sym("test_counter")), length: 4 }));
    const a = word32(await read());
    await sleep(400);
    const b = word32(await read());

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
    assert.ok(/seq=\d+/.test(out),
      `RTT produced nothing after a reset — the server was probably evicted: ${JSON.stringify(out.slice(0, 200))}`);

    // And the reset must actually have reset. Checked directly rather than
    // through the log: halt after a reset and the PC must be at the reset
    // handler. Watching the sequence counter conflates "did not reset" with
    // "reset but the stream we read predates it", which is what made the
    // previous version of this check ambiguous.
    await hil.expectOk("reset", { halt: true });
    const regs = await withTargetHalted(hil, () => hil.expectOk("read_registers"));
    record("hil-reset-halt-registers.txt", regs);

    // Cross-check through the other channel. `monitor reset` reports success
    // ("Resetting target", ^done) yet PC comes back mid-firmware, which has
    // two very different explanations: the core did not reset, or it did and
    // GDB handed us cached registers from before it. Reading the same thing
    // with GDB routing disabled distinguishes them — JLinkExe has no cache.
    const viaJLinkExe = await hil.call("probe_command", { commands: ["halt", "regs"] });
    record("hil-reset-halt-via-jlinkexe.txt", viaJLinkExe);
    const rawPc = viaJLinkExe.match(/\bPC = ([0-9A-Fa-f]{8})/)?.[1];

    const pc = reg(regs, "PC");
    assert.ok(pc !== null && pc >= sym("Reset_Handler") && pc <= sym("Reset_Handler") + 0x20,
      `after reset(halt) PC is 0x${pc?.toString(16)}, not the reset handler at ` +
      `0x${sym("Reset_Handler").toString(16)}. JLinkExe reports PC=0x${rawPc ?? "?"} for the same ` +
      `moment — if that IS the reset handler, the core reset fine and GDB served a stale ` +
      `register cache; if it agrees, the reset genuinely did not take.`);
    await hil.expectOk("resume");

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
