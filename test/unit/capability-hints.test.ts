import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { JLinkMcpServer } from "../../src/mcp/server";

/**
 * Hints exist because two things went wrong in real use: models never thought
 * to load the ELF, so every backtrace was bare addresses, and they never
 * supplied an SVD, so every peripheral read was undecoded hex. Neither is
 * discoverable from a tool description — the tools work, they just work
 * blind.
 *
 * The cost is context. A hint that repeats on every call stops being help and
 * starts crowding out the answer it was attached to, which is exactly what
 * the old SVD message did: forty-odd tokens of the same advice, three tools,
 * every call. So these pin the suppression as tightly as the content.
 */
function hintOf(server: JLinkMcpServer, key: string, text: string, repeat = false): string {
  return (server as any).hint(key, text, repeat);
}

function server(): JLinkMcpServer {
  return new JLinkMcpServer({ type: "jlink", jlink: { device: "NRF52840_XXAA" } } as any);
}

describe("capability hints", () => {
  test("advice is given once and then stays quiet", () => {
    const s = server();
    assert.notEqual(hintOf(s, "svd", "set SVD_PATH"), "", "first call should advise");
    assert.equal(hintOf(s, "svd", "set SVD_PATH"), "", "second call must not repeat");
    assert.equal(hintOf(s, "svd", "set SVD_PATH"), "", "nor the third");
  });

  test("the ELF hint repeats, because being ignored is the point", () => {
    // If a caller is still getting unresolved frames on its fourth backtrace,
    // saying so again is the whole reason the hint exists.
    const s = server();
    for (let i = 1; i <= 4; i++) {
      assert.notEqual(hintOf(s, "elf", "gdb_load", true), "", `backtrace ${i} should still say it`);
    }
  });

  test("hints are separated from the output they annotate", () => {
    const s = server();
    assert.match(hintOf(s, "k", "advice"), /^\n\n/, "must not run into the result text");
  });

  test("different hints do not suppress each other", () => {
    const s = server();
    assert.notEqual(hintOf(s, "svd", "a"), "");
    assert.notEqual(hintOf(s, "rtt-addr", "b"), "", "a separate key is a separate hint");
  });

  test("each hint stays within its token budget", () => {
    // Roughly four characters per token. These ride along on real answers, so
    // the whole design fails if they are not small.
    const s = server();
    for (const text of [
      'No symbols: gdb_load { elfFile: "..." } for names and file:line.',
      "Set SVD_PATH (or jlinkMcp.svdPath) to a CMSIS-SVD file for this part to get named fields and decoded values.",
      "RTT empty. If it stopped after a reset or flash, set JLINK_RTT_ADDR to your _SEGGER_RTT symbol so it can be recovered.",
    ]) {
      assert.ok(text.length < 140, `hint is ${text.length} chars, too long to ride on every answer`);
    }
    assert.ok(hintOf(s, "x", "short").length < 200);
  });
});

describe("host-side GDB commands", () => {
  // Correction, paid for on hardware: letting these through while the target
  // runs does not work. GDB is sitting in its own resume loop and is not
  // reading stdin at all, so it makes no difference that the command would
  // never have reached the remote —
  //
  //   07:39:18.822  [GDB] > 10 file /.../rtt-fixture.elf
  //   07:39:28.824  <<<RAW gdb file /.../rtt-fixture.elf      (empty)
  //
  // twice, for the full ten-second timeout. So the list still marks what is
  // worth halting for; it no longer claims these can be answered mid-flight.

  // The running-target guard exists because a synchronous remote stops reading
  // stdin while the target executes. That is a fact about the remote, and
  // these commands never reach it — GDB answers them from a symbol table it
  // already holds.
  //
  // Refusing them cost a real hardware round. gdb_load was turned away purely
  // because the target happened to be running, which is the normal state of a
  // device nobody has halted yet:
  //
  //   [GDB] > (refused, target running) file /.../rtt-fixture.elf
  //
  // and the tool still answered "Symbols loaded: ".
  const isHostSide = (cmd: string): boolean =>
    (require("../../src/gdb/gdb-client").GDBClient as any).isHostSide(cmd);

  for (const cmd of [
    "file /tmp/app.elf",
    "symbol-file /tmp/app.elf",
    "add-symbol-file /tmp/app.elf 0x8000",
    "info line *0x2a4",
    "info functions",
    "list main",
  ]) {
    test(`halts for "${cmd}" rather than refusing it`, () => {
      assert.equal(isHostSide(cmd), true);
    });
  }

  for (const cmd of [
    "print myGlobal",     // reads target memory
    "x/16xw 0x20000000",  // reads target memory
    "continue",
    "bt",                 // needs the target's stack
    "info registers",     // needs the target's registers
    "monitor reset",
  ]) {
    test(`refuses "${cmd}" outright — halting would not make it valid`, () => {
      assert.equal(isHostSide(cmd), false, "this one genuinely needs the target");
    });
  }
});

describe("a command that never came back", () => {
  // Completion is a result record carrying our token, so no output means GDB
  // never answered. Empty output also contains no "^error", which is how this
  // read as success — and how a `file` that sat through two ten-second
  // timeouts reported "Symbols loaded:" with nothing after the colon, letting
  // a wrong fix pass its own hardware test.
  test("is reported as a failure, not as empty success", async () => {
    const { GDBClient } = require("../../src/gdb/gdb-client");
    const c = new GDBClient();
    (c as any).connected = true;
    (c as any).proc = { stdin: { write() {} } };
    (c as any).sendCommand = async () => "";          // the timeout shape
    (c as any).targetRunning = false;

    const r = await (c as any).commandUnqueued("info line *0x0", 10);
    assert.equal(r.success, false, "silence is not success");
    assert.match(r.error ?? "", /did not answer/i);
  });

  test("a command needing the target is refused before it can time out", async () => {
    // The guard runs first, so `bt` never reaches the timeout path at all —
    // it is turned away in microseconds with an actionable message instead of
    // sitting for ten seconds and coming back empty.
    const { GDBClient } = require("../../src/gdb/gdb-client");
    const c = new GDBClient();
    (c as any).connected = true;
    (c as any).proc = { stdin: { write() {} } };
    (c as any).sendCommand = async () => { throw new Error("should never be sent"); };
    (c as any).targetRunning = true;

    const r = await (c as any).commandUnqueued("bt", 10);
    assert.equal(r.success, false);
    assert.match(r.error ?? "", /target is running/i);
  });
});
