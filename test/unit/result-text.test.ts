import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { JLinkMcpServer } from "../../src/mcp/server";

const render = (r: any, fallback: string) =>
  (JLinkMcpServer as any).resultText(r, fallback);

/**
 * Tools used to render `r.output || "<generic string>"`, which discards the
 * error the layer below produced. On hardware, reading memory during a run
 * came back as "Could not read memory" while the GDB client had produced
 * "Target is running; GDB cannot accept commands until it stops. Use halt..."
 *
 * The generic string is a dead end for whoever is holding the tool. The
 * specific one tells them what to do next.
 */
describe("resultText prefers the most specific text available", () => {
  test("parsed output wins", () => {
    assert.equal(render({ output: "PC = 0x44", rawOutput: "raw", error: "err" }, "fb"), "PC = 0x44");
  });

  test("raw output when there is no parsed output", () => {
    assert.equal(render({ output: "", rawOutput: "raw text", error: "err" }, "fb"), "raw text");
  });

  test("the underlying error rather than the generic fallback", () => {
    const r = { output: "", rawOutput: "", error: "Target is running; use halt." };
    assert.equal(render(r, "Could not read memory"), "Target is running; use halt.");
  });

  test("error and suggested action are combined", () => {
    const r = { output: "", error: "Target unreachable.", suggestedAction: "Try reset with halt." };
    assert.match(render(r, "fb"), /Target unreachable\..*Try reset with halt\./);
  });

  test("the fallback only when there is genuinely nothing else", () => {
    assert.equal(render({}, "Could not read memory"), "Could not read memory");
    assert.equal(render({ output: "  ", rawOutput: "\n" }, "fb"), "fb");
  });

  test("whitespace-only output does not mask a real error", () => {
    // The exact shape that produced the generic message on hardware: a
    // timeout leaves output empty while the error carries the reason.
    const r = { output: "", rawOutput: "", error: "Target is running; GDB cannot accept commands until it stops." };
    assert.match(render(r, "Could not read memory"), /running/i);
    assert.match(render(r, "Could not read memory"), /stops/i);
  });
});
