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
