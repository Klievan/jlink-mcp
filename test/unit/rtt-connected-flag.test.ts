import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { JLinkBackend } from "../../src/probe/jlink";
import { ProbeState } from "../../src/probe/backend";
import { ProcessManager } from "../../src/utils/process-manager";

/**
 * `rttConnected` decides whether a flash restores RTT afterwards, so an
 * assignment that is quietly discarded takes the stream out for the rest of
 * the session — and says nothing.
 *
 * That is what happened. The guard asked whether the state enum read
 * GDB_RUNNING, but that one enum covers both "is the target attached" and "is
 * the server up". Any JLinkExe-routed call runs preflight, which sets
 * TARGET_ATTACHED on success — true, and silent about the server:
 *
 *   [probe] refusing rttConnected = true: state is target_attached, not gdb_running
 *
 * connectRttToRunningTarget resumes before connecting, and with no GDB client
 * that resume goes through JLinkExe, so the refusal landed on the very next
 * line every time.
 */
function backend(serverRunning: boolean) {
  const b = new JLinkBackend({ device: "NRF52840_XXAA" }, new ProcessManager());
  (b as any).isGDBServerRunning = () => serverRunning;
  return b;
}

describe("the rttConnected guard", () => {
  test("accepts the flag while the GDB server is up, whatever the state enum says", () => {
    const b = backend(true);
    (b as any).setState(ProbeState.TARGET_ATTACHED);
    b.rttConnected = true;
    assert.equal(b.rttConnected, true,
      "preflight setting TARGET_ATTACHED says nothing about whether the server is running");
  });

  test("still accepts it in the GDB_RUNNING state", () => {
    const b = backend(true);
    (b as any).setState(ProbeState.GDB_RUNNING);
    b.rttConnected = true;
    assert.equal(b.rttConnected, true);
  });

  test("refuses when no server is running to serve RTT", () => {
    // The server hosts the RTT telnet port, so this refusal is the real rule.
    const b = backend(false);
    (b as any).setState(ProbeState.GDB_RUNNING);
    b.rttConnected = true;
    assert.equal(b.rttConnected, false);
  });

  test("losing the target clears it", () => {
    const b = backend(true);
    (b as any).setState(ProbeState.GDB_RUNNING);
    b.rttConnected = true;
    (b as any).setState(ProbeState.PROBE_CONNECTED);
    assert.equal(b.rttConnected, false);
  });
});
