import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as net from "net";
import { isPortListening, parseListenerPids, looksLikeGdbServer } from "../../src/utils/gdb-server-probe";

/**
 * The complaint: an LLM starts a GDB server, the user forgets a session is
 * live, and every later attempt to attach fails in a way that looks like
 * broken hardware.
 *
 * The extension cannot answer "is a server running" from its own memory. The
 * MCP server runs in a separate process — the one VSCode spawns — so an
 * LLM-started server is invisible to the extension host. A listening port is
 * observable whoever is responsible, which is why detection works that way.
 */
describe("detecting a GDB server nobody told us about", () => {
  test("sees a listening port", async () => {
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as net.AddressInfo).port;
    try {
      assert.equal(await isPortListening(port), true);
    } finally {
      srv.close();
    }
  });

  test("reports a free port as free rather than hanging", async () => {
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as net.AddressInfo).port;
    await new Promise<void>((r) => srv.close(() => r()));
    assert.equal(await isPortListening(port, "127.0.0.1", 250), false);
  });
});

describe("who holds the port", () => {
  test("reads bare PIDs, the shape lsof -t emits", () => {
    assert.deepEqual(parseListenerPids("4242\n4243\n", 1), [4242, 4243]);
  });

  test("reads the trailing PID column, the shape netstat emits", () => {
    const netstat = "  TCP    127.0.0.1:2331   0.0.0.0:0   LISTENING       9184";
    assert.deepEqual(parseListenerPids(netstat, 1), [9184]);
  });

  test("never returns our own pid", () => {
    // Not tidiness. lsof answers with whatever holds the port, and in
    // development that has already been this very process — a kill built on
    // "whatever owns the port" would take down the extension host that asked.
    assert.deepEqual(parseListenerPids("4242\n777\n", 777), [4242]);
  });

  test("ignores blank and unparseable lines", () => {
    assert.deepEqual(parseListenerPids("\n\nno pid here\n4242\n", 1), [4242]);
  });
});

describe("what we are willing to kill", () => {
  test("recognises a J-Link GDB server", () => {
    assert.equal(looksLikeGdbServer(
      "/opt/SEGGER/JLink/JLinkGDBServerCLExe -device NRF52840_XXAA -if SWD -port 2331"), true);
    assert.equal(looksLikeGdbServer("JLinkGDBServer -device STM32F407VG"), true);
  });

  test("refuses to claim anything else is one", () => {
    // A listening port proves something is there, not that it is ours. Being
    // in the way is not grounds for a kill.
    for (const cmd of [
      "node /Users/me/some-server.js --port 2331",
      "/usr/bin/python3 -m http.server 2331",
      "openocd -f interface/stlink.cfg",
      "",
    ]) {
      assert.equal(looksLikeGdbServer(cmd), false, `must not kill: ${cmd}`);
    }
  });

  test("does not confuse JLinkExe with the GDB server", () => {
    // JLinkExe holds the probe too, but killing it is a different decision
    // and this path is only about the GDB server on the port.
    assert.equal(looksLikeGdbServer("/opt/SEGGER/JLink/JLinkExe -device NRF52840_XXAA"), false);
  });
});

import { formatDuration, renderGdbStatus } from "../../src/utils/gdb-server-probe";

describe("how long it has been up", () => {
  test("stays short enough for a status bar", () => {
    assert.equal(formatDuration(12_000), "12s");
    assert.equal(formatDuration(47 * 60_000), "47m");
    assert.equal(formatDuration(125 * 60_000), "2h 5m");
  });

  test("does not render negative time from a clock skew", () => {
    assert.equal(formatDuration(-5000), "0s");
  });
});

describe("what the status bar says", () => {
  const base = { running: true, startedByExtension: false, elapsedMs: 47 * 60_000,
                 observedStart: true, device: "nRF52840_XXAA", gdbPort: 2331,
                 rttPort: 19021, rttListening: true };

  test("names who started it, which is the whole complaint", () => {
    // A session you opened is one you remember. The one an assistant opened is
    // the one that gets forgotten and then blocks every other tool.
    assert.match(renderGdbStatus(base).text, /MCP/);
    assert.match(renderGdbStatus({ ...base, startedByExtension: true }).text, /you/);
  });

  test("puts the elapsed time where it will be read", () => {
    assert.match(renderGdbStatus(base).text, /47m/);
  });

  test("keeps the bar text short", () => {
    // VSCode truncates a long status bar item, and a truncated warning is a
    // warning nobody reads.
    const t = renderGdbStatus(base).text.replace(/\$\([a-z-]+\)/g, "");
    assert.ok(t.length <= 28, `status text is ${t.length} chars: ${t}`);
  });

  test("does not claim an uptime it did not watch", () => {
    // If the server was already running when the window opened, all we
    // honestly know is how long we have known — not how long it has been up.
    const seen = renderGdbStatus({ ...base, observedStart: false });
    assert.match(seen.tooltip, /already running when the extension started/i);
    assert.ok(!/\bUp 47m\b/.test(seen.tooltip), "must not present a lower bound as an uptime");

    assert.match(renderGdbStatus(base).tooltip, /Up 47m/);
  });

  test("the tooltip carries the detail the bar has no room for", () => {
    const { tooltip } = renderGdbStatus(base);
    assert.match(tooltip, /nRF52840_XXAA/);
    assert.match(tooltip, /2331/);
    assert.match(tooltip, /19021/);
    assert.match(tooltip, /one client at a time/i, "should explain why it matters");
  });

  test("says when the device is not configured rather than leaving a blank", () => {
    assert.match(renderGdbStatus({ ...base, device: undefined }).tooltip, /not configured/i);
  });

  test("reports RTT being down without implying the server is", () => {
    const { tooltip } = renderGdbStatus({ ...base, rttListening: false });
    assert.match(tooltip, /RTT: not listening/);
    assert.match(tooltip, /GDB server running/);
  });

  test("an idle probe reads as free, and offers status rather than a kill", () => {
    const { text, tooltip } = renderGdbStatus({ ...base, running: false });
    assert.match(text, /debug-disconnect/);
    assert.match(tooltip, /probe is free/i);
  });
});
