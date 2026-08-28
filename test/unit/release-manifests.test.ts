import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { repoRoot } from "../helpers";

/**
 * server.json lists this package and its version for the MCP registry, and
 * package.json carries an mcpName marker proving the npm package belongs to
 * that registry entry. Three files therefore have to agree, and nothing at
 * build time notices when they stop agreeing — the publish just fails, or
 * worse, lists a version that was never released.
 */
const root = repoRoot(__dirname);
const read = (p: string) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));

const pkg = read("package.json");
const server = read("server.json");
const plugin = read(".claude-plugin/plugin.json");
const marketplace = read(".claude-plugin/marketplace.json");

describe("release manifests agree with each other", () => {
  test("server.json names the npm package we actually publish", () => {
    const npm = server.packages.find((p: any) => p.registryType === "npm");
    assert.ok(npm, "there must be an npm package entry");
    assert.equal(npm.identifier, pkg.name);
  });

  test("versions match across package.json, server.json and the plugin", () => {
    const npm = server.packages.find((p: any) => p.registryType === "npm");
    assert.equal(server.version, pkg.version, "server.json version drifted");
    assert.equal(npm.version, pkg.version, "the npm package entry drifted");
    assert.equal(plugin.version, pkg.version, "plugin.json drifted");
  });

  test("the mcpName marker matches the registry name", () => {
    // This is what proves to the registry that we own the npm package.
    assert.equal(pkg.mcpName, server.name);
  });

  test("the registry name is the verified GitHub namespace", () => {
    assert.match(server.name, /^io\.github\.[A-Za-z0-9-]+\/[a-z0-9-]+$/);
  });

  test("the description fits the registry's 100-character cap", () => {
    // Found by validating against the published schema rather than by reading
    // it: the first draft was 230 characters and would have been rejected.
    assert.ok(server.description.length <= 100,
      `description is ${server.description.length} chars`);
  });

  test("the marketplace points at a plugin that exists", () => {
    assert.equal(marketplace.plugins[0].name, plugin.name);
    for (const skill of plugin.skills ?? []) {
      assert.ok(fs.existsSync(path.join(root, skill)), `missing skill dir: ${skill}`);
      assert.ok(fs.existsSync(path.join(root, skill, "SKILL.md")), `missing SKILL.md in ${skill}`);
    }
  });
});

describe("shipped configs are portable", () => {
  // Both of these were tracked with an absolute path into one developer's home
  // directory, so anyone who cloned the repo got a config that could not work
  // and gave no clue why.
  for (const f of ["mcp-config.json", ".mcp.json"]) {
    test(`${f} has no machine-specific paths`, () => {
      const raw = fs.readFileSync(path.join(root, f), "utf8");
      assert.ok(!/\/Users\/|\/home\/|[A-Z]:\\\\/.test(raw), `${f} contains an absolute path`);
    });

    test(`${f} names no specific target device`, () => {
      // A path is not the only machine-specific thing a config can carry.
      // .mcp.json ships with the plugin, so a device baked into it is wrong
      // for every user who is not the person who committed it — and it
      // defeats check_setup / search_devices / set_device, which exist
      // precisely so nobody has to guess.
      //
      // This file carried a hardcoded device from its first commit in April.
      // A test written the same day for hardcoded *paths* looked straight at
      // it and did not see the hardware.
      const entry = Object.values(read(f).mcpServers)[0] as any;
      const device = entry.env?.JLINK_DEVICE;
      assert.ok(!device || device === "Unspecified",
        `${f} pins JLINK_DEVICE to ${JSON.stringify(device)}; that is per-user config`);
    });

    test(`${f} is valid JSON with an mcpServers block`, () => {
      const d = read(f);
      assert.ok(d.mcpServers, "clients look for mcpServers");
      const entry = Object.values(d.mcpServers)[0] as any;
      assert.ok(entry.command, "needs a command to launch");
    });
  }

  test("the example config uses the published package, not a build path", () => {
    // Someone pasting this into a client has not built anything.
    const entry = Object.values(read("mcp-config.json").mcpServers)[0] as any;
    assert.equal(entry.command, "npx");
    assert.ok(entry.args.includes(pkg.name), "should launch the published package");
  });
});

describe("the README does not lie about the tool count", () => {
  // It said 31 for months while the server had 44. A number that specific
  // reads as checked, so a stale one is worse than none — and the install
  // section it sat next to was stale in the same way, telling people to clone
  // and hand-write four JSON files long after the package was on npm.
  test("matches the tools actually registered", () => {
    const src = fs.readFileSync(path.join(root, "src/mcp/server.ts"), "utf8");
    const registered = (src.match(/this\.server\.tool\(/g) ?? []).length;
    const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
    const claimed = Number((readme.match(/## Tools \((\d+)\)/) ?? [])[1]);
    assert.equal(claimed, registered,
      `README says ${claimed} tools, server.ts registers ${registered}`);
  });

  test("the install section is near the top, where someone stuck will look", () => {
    // It had drifted to line 561, below Environment Variables and Design
    // Decisions. Good instructions nobody reaches are not instructions.
    const lines = fs.readFileSync(path.join(root, "README.md"), "utf8").split("\n");
    const at = lines.findIndex((l) => /^## Installing/.test(l));
    assert.ok(at > 0, "there should be an Installing section");
    assert.ok(at < 200, `Installing is at line ${at + 1}; too far down to find`);
  });
});
