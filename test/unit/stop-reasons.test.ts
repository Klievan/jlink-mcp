import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { GDBClient } from "../../src/gdb/gdb-client";

const format = (mi: string): string => (new GDBClient() as any).formatStopReason(mi);

/**
 * A watchpoint firing was being reported as a bare SIGTRAP — indistinguishable
 * from any other trap. Someone spent 25 minutes concluding watchpoints never
 * fire on this remote. They do; the evidence was being rendered away.
 *
 * Verified on an nRF54LM20B: `watch frame.frame_no` then `continue` stopped
 * the core, and the raw report was "Program received signal SIGTRAP,
 * Trace/breakpoint trap."
 */
describe("stop reasons", () => {
  test("names a watchpoint, its expression and the values", () => {
    const mi = '*stopped,reason="watchpoint-trigger",wpt={number="7",exp="frame.frame_no"},' +
      'value={old="41",new="42"},func="spectrogram_reset",file="src/spectrogram.c",line="32"';
    const out = format(mi);
    assert.match(out, /watchpoint #7/);
    assert.match(out, /frame\.frame_no/);
    assert.match(out, /41 -> 42/, "the values are the whole point of a watchpoint");
  });

  test("handles the read/access watchpoint spellings too", () => {
    const mi = '*stopped,reason="read-watchpoint-trigger",hw-rwpt={number="3",exp="sweep.ref_dbm[0]"},' +
      'value={value="-101"},func="rf_sweep_run"';
    assert.match(format(mi), /watchpoint #3 on sweep\.ref_dbm\[0\]/);
  });

  test("a watchpoint that also reports SIGTRAP still reads as a watchpoint", () => {
    // This is the case that was misleading: the remote labels it a signal.
    const mi = '*stopped,reason="signal-received",signal-name="SIGTRAP",' +
      'wpt={number="7",exp="frame.frame_no"},value={old="1",new="2"},func="spectrogram_reset"';
    const out = format(mi);
    assert.match(out, /watchpoint #7/);
    assert.ok(!/signal SIGTRAP/.test(out), "the signal is noise once the cause is known");
  });

  test("a genuine signal with no better explanation still says so", () => {
    const mi = '*stopped,reason="signal-received",signal-name="SIGSEGV",func="HardFault_Handler"';
    assert.match(format(mi), /signal SIGSEGV/);
  });

  test("a breakpoint hit is still a breakpoint hit", () => {
    const mi = '*stopped,reason="breakpoint-hit",bkptno="5",func="rf_sweep_run",file="a.c",line="26"';
    const out = format(mi);
    assert.match(out, /breakpoint #5/);
    assert.match(out, /rf_sweep_run/);
  });
});
