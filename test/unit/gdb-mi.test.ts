import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { GDBClient } from "../../src/gdb/gdb-client";
import { golden } from "../helpers";

/** cleanMI and the remote-loss table are internal; reach them directly. */
function clean(raw: string): string {
  return (new GDBClient() as any).cleanMI(raw);
}
function isRemoteLoss(raw: string): boolean {
  return (GDBClient as any).REMOTE_LOSS_PATTERNS.some((p: RegExp) => p.test(raw));
}

describe("cleanMI", () => {
  test("unescapes console records into readable text", () => {
    const out = clean(golden("gdb-mi-x20bx-raw.txt"));
    assert.match(out, /^0xe000ed28:/m);
    assert.ok(out.includes("\t"), "escaped tabs must become real tabs");
    assert.ok(!out.includes("\\t"), "no literal backslash-t should survive");
  });

  test("emits one line per console record", () => {
    const lines = clean(golden("gdb-mi-x20bx-raw.txt")).split("\n");
    assert.equal(lines.length, 3);
  });

  test("drops MI bookkeeping records", () => {
    const out = clean(golden("gdb-mi-session-raw.txt"));
    assert.ok(!out.includes("=thread-group-added"));
    assert.ok(!out.includes("(gdb)"));
    assert.ok(!out.includes('&"'));
  });

  test("keeps console output from a session", () => {
    const out = clean(golden("gdb-mi-session-raw.txt"));
    assert.match(out, /Reading symbols from fixture\.elf/);
  });

  test("formats a stop event", () => {
    const out = clean(golden("gdb-mi-session-raw.txt"));
    assert.match(out, /Stopped:/);
    assert.match(out, /breakpoint-hit/);
    assert.match(out, /test_marker_fn/);
  });

  test("surfaces errors as readable text", () => {
    const out = clean(golden("gdb-mi-error-invalid-register.txt"));
    assert.match(out, /Error: Invalid register/);
  });

  test("strips the MI token from result records", () => {
    // Commands are sent as `<token> <command>` and the result comes back as
    // `17^done`. Matching only the bare `^done` left the record in the
    // cleaned text, so every GDB-routed tool appended a stray "17^done" line
    // to whatever the user asked for — and `^running` stopped being
    // recognised entirely. Caught by a real capture; the hand-written fixture
    // had no tokens in it.
    assert.equal(clean("7^done"), "");
    assert.equal(clean("12^running"), "(target running)");
    assert.match(clean('9^error,msg="Invalid register"'), /^Error: Invalid register$/);
    assert.ok(!clean(golden("gdb-mi-x20bx-raw.txt")).includes("^done"));
  });

  test("returns empty string for empty input", () => {
    assert.equal(clean(""), "");
    assert.equal(clean("(gdb)\n"), "");
  });
});

describe("REMOTE_LOSS_PATTERNS", () => {
  // These flip the client to disconnected and force a reconnect on the next
  // command. False positives tear down healthy sessions, so the table has to
  // stay narrow — that is what these tests defend.
  const shouldMatch = [
    "Remote connection closed",
    "Remote communication error.  Target disconnected.",
    "&\"monitor command not supported by this target\\n\"",
    "The program has no registers now.",
    "No target selected",
  ];

  for (const s of shouldMatch) {
    test(`detects loss: ${JSON.stringify(s.slice(0, 40))}`, () => {
      assert.ok(isRemoteLoss(s));
    });
  }

  const shouldNotMatch = [
    "Reading symbols from fixture.elf...",
    "Breakpoint 1 at 0x4b2: file src/main.c, line 42.",
    "0xe000ed28:\t0x00\t0x82",
    'Error: Invalid register `PC\'',
    "Continuing.",
    "^done",
  ];

  for (const s of shouldNotMatch) {
    test(`does not fire on: ${JSON.stringify(s.slice(0, 40))}`, () => {
      assert.ok(!isRemoteLoss(s), "false positive causes a spurious reconnect");
    });
  }

  test("a running-target state error is not treated as remote loss", () => {
    // GDB disagreeing with us about whether the target is running is a state
    // mismatch, not a dead link. Treating it as remote-loss tore down a
    // healthy session and reconnected for no reason. halt() now interrupts
    // through GDB so the disagreement should not arise, but the table must
    // not punish it if it does.
    assert.ok(!isRemoteLoss("Cannot execute this command while the target is running."));
  });

  test("a genuinely dead thread still counts as remote loss", () => {
    assert.ok(isRemoteLoss("Cannot execute this command without a live selected thread."));
  });
});
