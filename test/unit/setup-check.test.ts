import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { JLinkBackend } from "../../src/probe/jlink";
import { ProcessManager } from "../../src/utils/process-manager";
import { readFileSync } from "fs";
import { join } from "path";
import { repoRoot } from "../helpers";

/**
 * The first thing a new user hits is not a debugging problem, it is an
 * installation one — and it used to surface as `spawn JLinkExe ENOENT`, which
 * names a binary they have never heard of and says nothing about what to
 * install. check_setup exists to turn that into a checklist.
 */
describe("the installation check", () => {
  const mk = (installDir?: string) =>
    new JLinkBackend({ device: "X", ...(installDir ? { installDir } : {}) } as any, new ProcessManager());

  test("names the directory it looked in when the path is wrong", () => {
    const r = mk("/nope/segger").checkInstallation();
    assert.equal(r.ok, false);
    assert.match(r.detail, /\/nope\/segger/, "must say where it looked");
    assert.match(r.suggestedAction ?? "", /installDir|JLINK_INSTALL_DIR/);
  });

  test("points at the download when nothing is installed anywhere", () => {
    // The case that matters: someone who has never installed the J-Link pack.
    // Telling them a binary is missing is useless; telling them where to get
    // it is the whole job.
    const b = mk();
    (b as any).config.installDir = "";
    const orig = process.env.PATH;
    process.env.PATH = "/nonexistent-dir-for-this-test";
    try {
      const r = b.checkInstallation();
      assert.equal(r.ok, false);
      assert.match(r.suggestedAction ?? "", /segger\.com\/downloads\/jlink/);
    } finally {
      process.env.PATH = orig;
    }
  });
});

describe("deciding whether a probe is attached", () => {
  // A positive test, not an absence of known failure strings. The first draft
  // hunted for phrases like "no ... found" and reported "connected" on a
  // machine with no probe, because the real output was:
  //
  //   Connecting to J-Link via USB...FAILED: Failed to open DLL
  //
  // which matched none of them. Both samples below are verbatim from real
  // runs — one from the hardware runner, one from a laptop with nothing
  // plugged in.
  const connected = /connecting to j-link\b[^\n]*?O\.K\./i;

  // Every string below is verbatim from a real run. The first version of this
  // check was written from one of them and shipped a false "no probe" on a
  // board that worked — so all four live here now.
  test("recognises the hardware runner's phrasing", () => {
    assert.equal(connected.test("Connecting to J-Link ...O.K."), true);
  });

  test("recognises the same probe on a laptop, which words it differently", () => {
    // J-Link says "via USB" here and not on the runner. Nothing about the
    // probe changed; only the sentence did.
    assert.equal(connected.test("Connecting to J-Link via USB...O.K."), true);
  });

  test("does not read a wedged USB connection as a probe", () => {
    assert.equal(connected.test("Connecting to J-Link via USB...FAILED: Cannot connect to J-Link."), false);
  });

  test("does not read a USB failure as a connection", () => {
    assert.equal(connected.test("Connecting to J-Link via USB...FAILED: Failed to open DLL"), false);
  });

  test("does not read an empty scan as a connection", () => {
    assert.equal(connected.test(""), false);
  });
});

describe("tools that must not editorialise", () => {
  // probe_command is the escape hatch. People reach for it precisely when the
  // friendly tools have failed them, so replacing the probe's own words with
  // advice is the one thing it must never do.
  //
  // It used to route through resultText, which on a failure returns the reason
  // and suggested action *instead of* the output. A recovery that printed a
  // full J-Link transcript came back as "Recovery failed. Try: 1) reset with
  // halt..." and nothing else, costing someone 25 minutes re-running the same
  // commands by hand to see output the tool already had.
  test("a failing probe_command still returns the transcript", () => {
    const src = readFileSync(join(repoRoot(__dirname), "src/mcp/server.ts"), "utf8");
    // Scope to this handler only — the next tool along legitimately uses
    // resultText, and a fixed-size window catches it.
    const start = src.indexOf('"probe_command"');
    const next = src.indexOf("this.server.tool(", start + 10);
    const handler = src.slice(start, next > start ? next : start + 1600);
    assert.ok(/rawOutput \|\| r\.output/.test(handler),
      "probe_command must read the raw transcript, not a formatted summary");
    // Strip comments first: the handler's own comment names resultText while
    // explaining why it does not use it, and matching that is matching prose.
    const code = handler.replace(/\/\/[^\n]*/g, "");
    assert.ok(!/resultText/.test(code),
      "probe_command must not route through resultText — it swaps output for advice on failure");
  });
});
