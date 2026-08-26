import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { JLinkBackend } from "../../src/probe/jlink";
import { ProcessManager } from "../../src/utils/process-manager";
import { FakeGdbBridge } from "../helpers";

function makeBackend(bridge?: FakeGdbBridge) {
  const backend = new JLinkBackend({ device: "NRF52840_XXAA" }, new ProcessManager());
  if (bridge) backend.setGdbBridge(bridge);
  return backend;
}

/**
 * A J-Link probe serves one client at a time. Spawning JLinkExe while
 * JLinkGDBServer holds the session evicts the server, leaving the GDB client
 * attached to a dead socket. These tests pin the routing decision — which
 * channel each operation uses — without touching hardware.
 *
 * Every assertion here is about the command *string* sent to GDB. Whether the
 * target actually halts is the HIL tier's job.
 */
describe("GDB routing — command mapping", () => {
  let bridge: FakeGdbBridge;
  let backend: JLinkBackend;

  beforeEach(() => {
    bridge = new FakeGdbBridge();
    backend = makeBackend(bridge);
  });

  test("halt uses the monitor channel, not GDB's execution state machine", async () => {
    await backend.halt();
    assert.deepEqual(bridge.sent, ["monitor halt"]);
  });

  test("resume continues the target", async () => {
    await backend.resume();
    assert.deepEqual(bridge.sent, ["continue"]);
  });

  test("step issues an instruction step", async () => {
    await backend.step();
    assert.deepEqual(bridge.sent, ["stepi"]);
  });

  test("readAllRegisters asks for the full set", async () => {
    await backend.readAllRegisters();
    assert.deepEqual(bridge.sent, ["info all-registers"]);
  });

  test("setBreakpoint uses a GDB breakpoint, not SetBP", async () => {
    // Via JLinkExe this would evict the GDB session AND lose the breakpoint
    // when the transient process exits — the caller pays twice.
    await backend.setBreakpoint(0x44);
    assert.deepEqual(bridge.sent, ["break *0x44"]);
  });

  test("clearBreakpoints deletes GDB breakpoints", async () => {
    await backend.clearBreakpoints();
    assert.deepEqual(bridge.sent, ["delete breakpoints"]);
  });

  test("writeMemory writes a 32-bit word", async () => {
    await backend.writeMemory(0x20000000, 0xdeadbeef);
    assert.deepEqual(bridge.sent, ["set {unsigned int}0x20000000 = 0xdeadbeef"]);
  });
});

describe("GDB routing — reset sequencing", () => {
  test("reset(halt) sends a single command", async () => {
    const bridge = new FakeGdbBridge();
    await makeBackend(bridge).reset(true);
    assert.deepEqual(bridge.sent, ["monitor reset"]);
  });

  test("reset(run) sends two separate commands, never one multi-line string", async () => {
    // Regression: these were sent as "monitor reset\nmonitor go". GDBClient
    // writes the string straight to stdin and resolves on the first
    // ^done/(gdb), orphaning the second response in the shared output buffer
    // where it can satisfy the *next* command's completion check and desync
    // every reply after it.
    const bridge = new FakeGdbBridge();
    await makeBackend(bridge).reset(false);

    assert.deepEqual(bridge.sent, ["monitor reset", "monitor go"]);
    for (const cmd of bridge.sent) {
      assert.ok(!cmd.includes("\n"), `command must be a single line: ${JSON.stringify(cmd)}`);
    }
  });
});

describe("GDB routing — register name translation", () => {
  // GDB register names are lowercase and case-sensitive; `info registers PC`
  // fails with "Invalid register `PC'". The read_register tool documents
  // 'PC', 'SP', 'R0' as its examples, so the documented usage must work.
  const cases: [string, string][] = [
    ["PC", "pc"],
    ["SP", "sp"],
    ["R0", "r0"],
    ["MSP", "msp"],
    ["XPSR", "xpsr"],
    ["$pc", "pc"],
    ["  pc  ", "pc"],
    ["R13", "sp"],
    ["R14", "lr"],
    ["R15", "pc"],
    ["SP(R13)", "sp"],
    ["IPSR", "xpsr"],
    ["APSR", "xpsr"],
  ];

  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} → ${expected}`, async () => {
      const bridge = new FakeGdbBridge();
      await makeBackend(bridge).readRegister(input);
      assert.deepEqual(bridge.sent, [`info registers ${expected}`]);
    });
  }
});

describe("J-Link register name translation", () => {
  // The mirror of the GDB mapping above, for the JLinkExe path. J-Link names
  // core registers architecturally and rejects the ARM mnemonics:
  //   J-Link> rreg PC
  //   Illegal register name.
  // Two of read_register's own three documented examples ('PC', 'SP') hit
  // that, observed on real hardware before this mapping existed.
  const toJLink = (n: string) => (JLinkBackend as any).toJLinkRegName(n);
  const cases: [string, string][] = [
    ["PC", "R15"],
    ["SP", "R13"],
    ["LR", "R14"],
    ["pc", "R15"],
    ["R0", "R0"],
    ["r0", "R0"],
    ["MSP", "MSP"],
    ["PSP", "PSP"],
    ["XPSR", "XPSR"],
    ["CONTROL", "CONTROL"],
    ["$pc", "R15"],
    ["  sp  ", "R13"],
  ];
  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} -> ${expected}`, () => {
      assert.equal(toJLink(input), expected);
    });
  }
});

describe("GDB routing — when the bridge is unavailable", () => {
  test("no bridge means nothing is routed through GDB", async () => {
    // Without a GDB session there is no competing client, so the JLinkExe
    // path is correct. We assert only that the bridge was not consulted;
    // actually spawning JLinkExe is the HIL tier's job.
    const bridge = new FakeGdbBridge();
    const backend = makeBackend();
    backend.setGdbBridge(undefined);
    await backend.halt().catch(() => { /* JLinkExe absent in CI — expected */ });
    assert.deepEqual(bridge.sent, []);
  });

  test("a disconnected bridge is not used", async () => {
    const bridge = new FakeGdbBridge({}, false);
    const backend = makeBackend(bridge);
    await backend.halt().catch(() => { /* JLinkExe absent in CI — expected */ });
    assert.deepEqual(bridge.sent, [], "must not route through a dead GDB session");
  });
});

describe("GDB routing — JLINK_MCP_GDB_ROUTING opt-out", () => {
  const original = process.env.JLINK_MCP_GDB_ROUTING;
  afterEach(() => {
    if (original === undefined) delete process.env.JLINK_MCP_GDB_ROUTING;
    else process.env.JLINK_MCP_GDB_ROUTING = original;
  });

  for (const value of ["0", "false", "FALSE"]) {
    test(`${JSON.stringify(value)} forces the legacy JLinkExe path`, async () => {
      process.env.JLINK_MCP_GDB_ROUTING = value;
      const bridge = new FakeGdbBridge();
      const backend = makeBackend(bridge);
      await backend.halt().catch(() => { /* JLinkExe absent in CI — expected */ });
      assert.deepEqual(bridge.sent, []);
    });
  }

  test("any other value leaves routing enabled", async () => {
    process.env.JLINK_MCP_GDB_ROUTING = "1";
    const bridge = new FakeGdbBridge();
    await makeBackend(bridge).halt();
    assert.deepEqual(bridge.sent, ["monitor halt"]);
  });

  test("unset leaves routing enabled", async () => {
    delete process.env.JLINK_MCP_GDB_ROUTING;
    const bridge = new FakeGdbBridge();
    await makeBackend(bridge).halt();
    assert.deepEqual(bridge.sent, ["monitor halt"]);
  });
});
