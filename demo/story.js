#!/usr/bin/env node
/**
 * A scripted debugging session, driven through the real MCP server.
 *
 *   node demo/story.js
 *
 * Every line of output below comes from an actual tool call against actual
 * silicon — the same server an LLM would be talking to, over the same stdio
 * transport. Nothing here is staged: if the board is unplugged, this fails
 * rather than printing something plausible.
 *
 * Written to be recorded (see demo/story.tape), so it narrates and paces
 * itself. The pauses are for a viewer, not for the hardware.
 *
 * Requires: an nRF52840-DK, `npm run compile`, and the fixture firmware at
 * test/hil/fixture/rtt-fixture.hex.
 */
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const FIXTURE = path.join(ROOT, "test", "hil", "fixture", "rtt-fixture.hex");
const SYMS = JSON.parse(fs.readFileSync(path.join(ROOT, "test", "hil", "fixture", "symbols.json"), "utf8"));

// ── presentation ──────────────────────────────────────────────────
const C = {
  dim: "\x1b[2m", reset: "\x1b[0m", bold: "\x1b[1m",
  cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", grey: "\x1b[90m",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A beat between steps, so a viewer can read. Skipped with FAST=1. */
const beat = (ms = 900) => (process.env.FAST === "1" ? Promise.resolve() : sleep(ms));

function say(text) {
  console.log(`\n${C.grey}# ${text}${C.reset}`);
}
function call(tool, args) {
  const a = args && Object.keys(args).length ? ` ${JSON.stringify(args)}` : "";
  console.log(`${C.bold}${C.cyan}> ${tool}${C.reset}${C.dim}${a}${C.reset}`);
}
/** Print tool output indented, optionally only the first N lines. */
function out(text, limit) {
  const lines = text.trimEnd().split("\n");
  const shown = limit ? lines.slice(0, limit) : lines;
  for (const l of shown) {
    let colored = l;
    if (/^⚠|FAULT|Fault|UNALIGNED|UNDEFINSTR|PRECISERR|FORCED/.test(l)) colored = `${C.red}${l}${C.reset}`;
    else if (/^##|^###/.test(l)) colored = `${C.bold}${l}${C.reset}`;
    else if (/<err>|\[ERR\]/.test(l)) colored = `${C.red}${l}${C.reset}`;
    else if (/<wrn>|\[WRN\]/.test(l)) colored = `${C.yellow}${l}${C.reset}`;
    else if (/→/.test(l)) colored = `${C.green}${C.bold}${l}${C.reset}`;
    console.log(`  ${colored}`);
  }
  if (limit && lines.length > limit) console.log(`  ${C.dim}... ${lines.length - limit} more lines${C.reset}`);
}

// ── the session ───────────────────────────────────────────────────
(async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

  const server = path.join(ROOT, "out", "mcp", "standalone.js");
  if (!fs.existsSync(server)) {
    console.error("Build first: npm run compile");
    process.exit(1);
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [server],
    env: { ...process.env, JLINK_DEVICE: "NRF52840_XXAA" },
    stderr: "ignore",
  });
  const client = new Client({ name: "demo", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  const tool = async (name, args = {}) => {
    call(name, args);
    const res = await client.callTool({ name, arguments: args });
    return (res.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
  };

  console.log(`${C.bold}An LLM debugging a board it has never seen.${C.reset}`);
  console.log(`${C.dim}Every line below is a real MCP tool call against a real nRF52840-DK.${C.reset}`);
  await beat(1200);

  // ── Act 1: what is even attached? ──────────────────────────────
  say("First question: what hardware is here?");
  out(await tool("list_devices"), 4);
  await beat();

  // ── Act 2: one call to get a working session ───────────────────
  say("Flash the firmware under test, then open a debug session.");
  out(await tool("flash", { filePath: FIXTURE }), 4);
  await beat();

  say("start_debug_session: GDB server, RTT, and the boot log — one call.");
  out(await tool("start_debug_session", {}), 12);
  await beat(1500);

  // ── Act 3: the device is talking ───────────────────────────────
  say("The device is logging. Filter it the way you would grep — but by level.");
  out(await tool("rtt_search", { level: "wrn" }), 5);
  await beat();

  // ── Act 4: make it crash ───────────────────────────────────────
  say("Now break it on purpose: an unaligned access, injected over the debug port.");
  await tool("halt");
  out(await tool("write_memory", {
    address: "0x" + parseInt(SYMS.test_crash_request, 16).toString(16),
    value: "0x2",
  }), 2);
  await tool("resume");
  await sleep(1200);

  // ── Act 5: the payoff ──────────────────────────────────────────
  say("The board is now in a fault. This is the whole point:");
  out(await tool("diagnose_crash", {}), 34);
  await beat(2000);

  console.log(`\n${C.green}${C.bold}One call.${C.reset} Fault decoded from CFSR, exception frame unwound,`);
  console.log(`faulting instruction named, and the device's own log correlated.`);
  console.log(`${C.dim}No datasheet, no manual bit-twiddling, no guessing.${C.reset}\n`);

  await client.close();
  process.exit(0);
})().catch((e) => {
  console.error(`\n${C.red}Demo failed:${C.reset} ${e.message}`);
  console.error(`${C.dim}Is the DK plugged in? Try: npm run compile${C.reset}`);
  process.exit(1);
});
