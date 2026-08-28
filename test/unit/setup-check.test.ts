import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { JLinkBackend } from "../../src/probe/jlink";
import { ProcessManager } from "../../src/utils/process-manager";

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
  const connected = /connecting to j-link[\s.]*O\.K\./i;

  test("recognises a probe that answered", () => {
    assert.equal(connected.test("Connecting to J-Link ...O.K."), true);
  });

  test("does not read a USB failure as a connection", () => {
    assert.equal(connected.test("Connecting to J-Link via USB...FAILED: Failed to open DLL"), false);
  });

  test("does not read an empty scan as a connection", () => {
    assert.equal(connected.test(""), false);
  });
});
