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
