import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { JLinkBackend } from "../../src/probe/jlink";

/**
 * Spawning a GDB server is not starting one.
 *
 * A J-Link serves one client at a time. If another process still holds the
 * probe, JLinkGDBServer prints "Connecting to J-Link failed" and exits about
 * 200 ms later — so reporting success on the spawn alone announced a running
 * server that was already dead. Measured: one HIL suite tore down and the next
 * started 2.2 s later, lost the probe, and ran its entire length with no GDB
 * server and no RTT, reporting nothing wrong.
 */
function fakeServer(script: Array<{ out?: string; exit?: number }>) {
  const proc: any = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.pid = 1234;
  // Play the script on the next tick, so the caller is already waiting.
  setTimeout(() => {
    for (const step of script) {
      if (step.out) proc.stdout.emit("data", Buffer.from(step.out + "\n"));
      if (step.exit !== undefined) proc.emit("exit", step.exit);
    }
  }, 10);
  return proc;
}

function backendWith(scripts: Array<Array<{ out?: string; exit?: number }>>) {
  const spawned: string[] = [];
  const procs = new Map<string, any>();
  const pm: any = {
    spawn: (name: string) => {
      const proc = fakeServer(scripts[Math.min(spawned.length, scripts.length - 1)]);
      spawned.push(name);
      procs.set(name, { process: proc });
      return { process: proc };
    },
    get: (name: string) => procs.get(name),
    kill: (name: string) => { procs.delete(name); return true; },
    killAll: () => {},
  };
  return { backend: new JLinkBackend({ device: "NRF52840_XXAA" }, pm), spawned };
}

describe("GDB server startup", () => {
  test("succeeds once the server says it is waiting for a connection", async () => {
    const { backend, spawned } = backendWith([[{ out: "Waiting for GDB connection..." }]]);
    const r = await backend.startGDBServer();
    assert.equal(r.success, true, r.message);
    assert.equal(spawned.length, 1, "no retry needed");
  });

  test("does not report success for a server that died on startup", async () => {
    const { backend } = backendWith([[
      { out: "Connecting to J-Link failed. Connected correctly?" },
      { exit: 249 },
    ]]);
    const r = await backend.startGDBServer();
    assert.equal(r.success, false);
    assert.match(r.message, /holding the probe/i, "must name the likely cause");
  });

  test("retries a busy probe and succeeds when it frees up", async () => {
    // The realistic case: the previous session's server has been signalled
    // but has not released the USB device yet.
    const { backend, spawned } = backendWith([
      [{ out: "Connecting to J-Link failed. Connected correctly?" }, { exit: 249 }],
      [{ out: "Waiting for GDB connection..." }],
    ]);
    const r = await backend.startGDBServer();
    assert.equal(r.success, true, r.message);
    assert.equal(spawned.length, 2, "should have taken a second attempt");
  });

  test("gives up after three attempts rather than spinning", async () => {
    const { backend, spawned } = backendWith([[
      { out: "Connecting to J-Link failed. Connected correctly?" },
      { exit: 249 },
    ]]);
    const r = await backend.startGDBServer();
    assert.equal(r.success, false);
    assert.equal(spawned.length, 3);
  });
});
