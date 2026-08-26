import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import { ON_HIL_RUNNER, FIXTURE_HEX } from "./harness/mcp-client";
import { repoRoot } from "../helpers";
import * as path from "path";

/**
 * Deliberately NOT skipped off-hardware.
 *
 * Every other suite in this directory skips itself when HIL is unset, which
 * is right for a dev box but means the whole HIL job exits 0 having run
 * nothing if the environment is wrong. A green check that tested no hardware
 * is worse than a red one: it says the probe works when nobody asked it.
 *
 * So this file asserts the environment is what we think it is, and fails the
 * run when it is not.
 */
describe("HIL environment guard", () => {
  test("on CI, the hardware suites must actually be enabled", () => {
    // Locally CI is unset and skipping is expected. On the runner, HIL=1 is
    // set by the workflow — if it is missing, every suite silently no-ops.
    if (process.env.CI === "true" && process.env.HIL !== "1") {
      assert.fail(
        "Running in CI with HIL != 1: the hardware suites would all skip and " +
        "the job would pass without touching the probe. Set HIL=1 in hil.yml, " +
        "or run this job only on the self-hosted runner."
      );
    }
  });

  test("the compiled server exists before we try to drive it", () => {
    const server = path.join(repoRoot(__dirname), "out", "mcp", "standalone.js");
    assert.ok(fs.existsSync(server), `server not built: ${server} — run 'npm run compile'`);
  });

  test("the fixture image is present and non-empty", () => {
    assert.ok(fs.existsSync(FIXTURE_HEX), `missing ${FIXTURE_HEX}`);
    const hex = fs.readFileSync(FIXTURE_HEX, "utf8").trim();
    assert.ok(hex.endsWith(":00000001FF"), "fixture.hex is truncated");
  });

  test("when on hardware, the recovery script is reachable", { skip: !ON_HIL_RUNNER }, () => {
    // hil-recover is what puts the probe back after a wedged run. Without it
    // one bad run poisons every subsequent one.
    assert.ok(fs.existsSync("/usr/local/bin/hil-recover"),
      "hil-recover missing — the runner cannot recover a wedged probe between jobs");
  });
});
