import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { repoRoot } from "../helpers";

const ROOT = repoRoot(__dirname);
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const extension = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
const standalone = fs.readFileSync(path.join(ROOT, "src", "mcp", "standalone.ts"), "utf8");

/** Just the MCP provider, so a setting mentioned elsewhere does not count. */
const provider = extension.slice(
  extension.indexOf("provideMcpServerDefinitions"),
  extension.indexOf("resolveMcpServerDefinition")
);

/**
 * The extension and the standalone server talk through environment
 * variables, and nothing type-checks that conversation. A setting can be
 * declared in package.json, appear in the VSCode settings UI, and be silently
 * dropped — which is worse than not existing, because the user configures it,
 * sees no effect, and cannot tell whether the setting or their hardware is at
 * fault.
 *
 * Nine of sixteen settings were in exactly that state before these tests.
 */
describe("VSCode settings are actually wired to the server", () => {
  const declared: string[] = Object.keys(pkg.contributes.configuration.properties);

  test("every declared setting is read by the MCP provider", () => {
    const dead = declared.filter((key) => !provider.includes(`"${key.replace("jlinkMcp.", "")}"`));
    assert.deepEqual(dead, [],
      `these settings appear in the settings UI and are never passed to the server:\n  ${dead.join("\n  ")}`);
  });

  test("every env var the provider sets is one the server reads", () => {
    // The other direction: a typo'd env name is silently ignored by the
    // server, which looks identical to the setting having no effect.
    const sent = [...provider.matchAll(/put\("([A-Z_]+)"/g)].map((m) => m[1]);
    assert.ok(sent.length > 10, `expected the provider to pass many env vars, found ${sent.length}`);
    const unknown = sent.filter((name) => !standalone.includes(`"${name}"`));
    assert.deepEqual(unknown, [],
      `the provider sets env vars the server never reads:\n  ${unknown.join("\n  ")}`);
  });

  test("the backend selector is exposed", () => {
    // Without PROBE_TYPE the OpenOCD and Black Magic backends are unreachable
    // from the extension, however loudly the README advertises them.
    assert.ok(declared.includes("jlinkMcp.probeType"), "no setting selects the probe backend");
    assert.ok(provider.includes("PROBE_TYPE"), "probeType is declared but never passed");
    const opts = pkg.contributes.configuration.properties["jlinkMcp.probeType"].enum;
    assert.deepEqual(opts, ["jlink", "openocd", "blackmagic"]);
  });

  test("no setting promises a feature that does not exist", () => {
    // trice.* and pigweed.* configured a detokenizer that was never
    // implemented — the telnet proxy relays bytes and nothing decodes them.
    // Settings for absent features are a promise the tool cannot keep: the
    // user supplies a token database and waits for decoded output forever.
    //
    // A plain guard rather than a clever heuristic. An earlier version of
    // this test inferred "decoding exists" from the word "Trice" appearing in
    // a comment, which is exactly the kind of inference that has cost this
    // project hardware rounds. If decoding is ever implemented, delete this
    // test and add the settings back deliberately.
    const phantom = declared.filter((k) => /trice|pigweed/i.test(k));
    assert.deepEqual(phantom, [],
      `settings for an unimplemented feature: ${phantom.join(", ")}`);
  });
});
