#!/usr/bin/env node
/**
 * Extract raw probe/GDB transcripts from a HIL run's server log and promote
 * them to golden fixtures.
 *
 *   node test/golden/promote.js <captures-dir> [--write]
 *
 * The unit tier replays RAW probe output through the parsers. That is a
 * different layer from what the MCP tools return, which is already parsed —
 * an earlier version of this script promoted tool output and would have
 * produced fixtures that no parser ever sees. The server emits the raw text
 * in <<<RAW ... RAW>>> blocks when JLINK_MCP_LOG_RAW=1, which the HIL
 * workflow sets; this pulls those blocks out of the run log.
 *
 * Promotion is deliberate and reviewed, never automatic. A flaky run must not
 * be able to rewrite the baseline the fast tier is measured against — that
 * would turn the golden files from an assertion into an echo. Without
 * --write this only reports what it found.
 */
const fs = require("fs");
const path = require("path");

const GOLDEN = __dirname;

/** fixture name <- first raw block whose command matches, if it passes `ok` */
const WANTED = [
  { fixture: "jlink-halt-regs.txt", channel: "jlink", match: /(^|;\s*)regs\b/,
    ok: (t) => /^R0 = [0-9A-F]{8}/m.test(t) && /SP\(R13\)/.test(t) },
  { fixture: "jlink-mem-dump.txt", channel: "jlink", match: /^mem 0x0,/,
    ok: (t) => /^[0-9A-F]{8} = ([0-9A-F]{2} ){8}/m.test(t) },
  { fixture: "gdb-info-all-registers.txt", channel: "gdb", match: /^info all-registers$/,
    ok: (t) => /~"(pc|r0)\s/.test(t) },
  { fixture: "gdb-mi-x20bx-raw.txt", channel: "gdb", match: /^x\/20bx/,
    ok: (t) => /~"0x[0-9a-f]+/.test(t) },
];

const [dir, ...flags] = process.argv.slice(2);
const write = flags.includes("--write");
if (!dir) {
  console.error("usage: node test/golden/promote.js <captures-dir> [--write]");
  process.exit(2);
}

/** Pull every <<<RAW channel command ... RAW>>> block out of the logs. */
function readBlocks(d) {
  const blocks = [];
  for (const f of fs.readdirSync(d).filter((n) => n.startsWith("server-stderr"))) {
    const text = fs.readFileSync(path.join(d, f), "utf8");
    // The logger stamps a timestamp onto the first line of each call, so both
    // delimiters may carry one. Only the opening line of the body is stamped
    // (the payload is logged as a single multi-line string), but the closing
    // delimiter is its own call and always is.
    const re = /<<<RAW (\S+) (.*?)\n([\s\S]*?)\n(?:\[[^\]]+\]\s*)?RAW>>>/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      // Strip the logger's per-line timestamp prefix to recover the tool's
      // own bytes — those, not our formatting, are what the parsers see.
      const body = m[3].split("\n").map((l) => l.replace(/^\[[^\]]+\]\s?/, "")).join("\n");
      blocks.push({ channel: m[1], command: m[2].trim(), body });
    }
  }
  return blocks;
}

const blocks = readBlocks(dir);
console.log(`found ${blocks.length} raw blocks in ${dir}\n`);
if (!blocks.length) {
  console.log("Nothing to promote. Is JLINK_MCP_LOG_RAW=1 set for the HIL job?");
  process.exit(1);
}

let promoted = 0;
for (const want of WANTED) {
  const hit = blocks.find((b) => b.channel === want.channel && want.match.test(b.command));
  if (!hit) { console.log(`skip  ${want.fixture} — no matching ${want.channel} command in this run`); continue; }
  if (!hit.body.trim()) { console.log(`SKIP  ${want.fixture} — empty capture; a broken run must not become the baseline`); continue; }
  if (!want.ok(hit.body)) { console.log(`SKIP  ${want.fixture} — failed its shape check; refusing to promote`); continue; }
  console.log(`ok    ${want.fixture} <- ${want.channel} "${hit.command}" (${hit.body.length} bytes)`);
  if (write) fs.writeFileSync(path.join(GOLDEN, want.fixture), hit.body.endsWith("\n") ? hit.body : hit.body + "\n");
  promoted++;
}

console.log(`\n${write ? "wrote" : "would write"} ${promoted} fixture(s).`);
if (write) console.log("Review the diff, update the status table in test/golden/README.md, and re-run npm test.");
else console.log("Re-run with --write to apply.");
