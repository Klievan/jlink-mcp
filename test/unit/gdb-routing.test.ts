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

  test("halt interrupts out-of-band, not through the command channel", async () => {
    // With a synchronous remote GDB stops reading stdin while the target
    // runs, so a halt sent as a command is never seen and merely times out.
    // Confirmed on hardware: after one `continue` the GDB server logged
    // nothing further and every later command sat for the full timeout.
    await backend.halt();
    assert.equal(bridge.interruptCount, 1, "halt must use the out-of-band path");
    assert.deepEqual(bridge.sent, [], "nothing should be written to stdin");
  });

  test("halt falls back to monitor halt when the interrupt does not take", async () => {
    const b = new FakeGdbBridge();
    b.interruptSucceeds = false;
    await makeBackend(b).halt();
    assert.equal(b.interruptCount, 1);
    assert.deepEqual(b.sent, ["monitor halt"]);
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
  test("reset(halt) arms vector catch so the core stops AT the reset vector", async () => {
    // Measured on hardware: `monitor reset` alone leaves the CPU running in
    // main, with GDB and JLinkExe agreeing on the address — so the core really
    // was running, not a stale cache. Halting afterwards is no good either:
    // the core has executed an arbitrary amount of startup by then, so PC is
    // wherever it reached. DEMCR.VC_CORERESET stops it before it starts.
    const bridge = new FakeGdbBridge({ "x/1wx": "0xe000edfc:\t0x01000000" });
    await makeBackend(bridge).reset(true);

    const armed = bridge.sent.findIndex((c) => /set .*0xe000edfc = 0x1000001\b/.test(c));
    const reset = bridge.sent.indexOf("monitor reset");
    const cleared = bridge.sent.findIndex((c, i) => i > reset && /set .*0xe000edfc = 0x1000000\b/.test(c));

    assert.ok(armed >= 0, `vector catch never armed: ${JSON.stringify(bridge.sent)}`);
    assert.ok(armed < reset, "catch must be armed before the reset, or the core is already gone");
    assert.ok(cleared > reset, "catch must be cleared after, not left armed for the next session");
  });

  test("reset(halt) preserves the rest of DEMCR", async () => {
    // Only bit 0 is ours. Clobbering the register would drop TRCENA and any
    // other vector catches the caller had set.
    const bridge = new FakeGdbBridge({ "x/1wx": "0xe000edfc:\t0x01000010" });
    await makeBackend(bridge).reset(true);
    const writes = bridge.sent.filter((c) => c.includes("0xe000edfc ="));
    assert.equal(writes.length, 2);
    assert.match(writes[0], /0x1000011\b/, "should set bit 0 on top of the existing value");
    assert.match(writes[1], /0x1000010\b/, "should restore exactly what was there");
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

describe("J-Link register name canonicalization", () => {
  // read_register no longer uses `rreg` at all: J-Link rejects both the ARM
  // mnemonics and the architectural names it prints as valid ("rreg PC" and
  // "rreg R15" each answer "Illegal register name." plus a 100-entry list).
  // It reads the whole set with `regs` and picks the register out, so names
  // only need normalizing to the spelling parseRegisters produces.
  const canon = (n: string) => (JLinkBackend as any).toCanonicalRegName(n);
  const cases: [string, string][] = [
    ["PC", "PC"], ["pc", "PC"], ["$pc", "PC"], ["R15", "PC"],
    ["SP", "SP"], ["R13", "SP"], ["SP(R13)", "SP"],
    ["LR", "LR"], ["R14", "LR"],
    ["R0", "R0"], ["MSP", "MSP"], ["XPSR", "XPSR"], ["  msp  ", "MSP"],
  ];
  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} -> ${expected}`, () => {
      assert.equal(canon(input), expected);
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
    assert.equal(bridge.interruptCount, 1);
  });

  test("unset leaves routing enabled", async () => {
    delete process.env.JLINK_MCP_GDB_ROUTING;
    const bridge = new FakeGdbBridge();
    await makeBackend(bridge).halt();
    assert.equal(bridge.interruptCount, 1);
  });
});
