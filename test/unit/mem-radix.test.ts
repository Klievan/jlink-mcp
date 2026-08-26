import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { JLinkBackend } from "../../src/probe/jlink";
import { ProcessManager } from "../../src/utils/process-manager";

/**
 * J-Link Commander's `mem` parses its byte count as hex. A decimal count is
 * therefore silently misread, and the caller gets more bytes than it asked
 * for without any error:
 *
 *   mem 0x0, 20   -> 0x20 = 32 bytes
 *   mem 0x0, 256  -> 0x256 = 598 bytes
 *
 * Both observed on the nRF52840-DK. readFaultRegisters (20) and snapshot (64)
 * were both over-reading, and any caller counting the bytes back got a number
 * that did not match its request.
 */
describe("readMemory emits an explicit hex byte count", () => {
  function capture(): { cmds: string[][]; backend: JLinkBackend } {
    const backend = new JLinkBackend({ device: "NRF52840_XXAA" }, new ProcessManager());
    const cmds: string[][] = [];
    // Intercept at execRaw so we see the literal J-Link script, without
    // spawning anything.
    (backend as any).execRaw = async (c: string[]) => {
      cmds.push(c);
      return { success: true, rawOutput: "", output: "" };
    };
    return { cmds, backend };
  }

  const cases: [number, number, string][] = [
    [0x00000000, 20, "mem 0x0, 0x14"],
    [0x00000000, 256, "mem 0x0, 0x100"],
    [0xe000ed28, 20, "mem 0xe000ed28, 0x14"],
    [0x20000000, 64, "mem 0x20000000, 0x40"],
    [0x20000000, 4, "mem 0x20000000, 0x4"],
    [0x20000000, 4096, "mem 0x20000000, 0x1000"],
  ];

  for (const [addr, len, expected] of cases) {
    test(`${len} bytes at 0x${addr.toString(16)} -> ${expected}`, async () => {
      const { cmds, backend } = capture();
      await backend.readMemory(addr, len);
      assert.equal(cmds[cmds.length - 1][0], expected);
    });
  }

  test("the DHCSR preflight read uses the same hex form", async () => {
    const { cmds, backend } = capture();
    await backend.readMemory(0xe000edf0, 4);
    assert.equal(cmds[cmds.length - 1][0], "mem 0xe000edf0, 0x4");
  });

  test("a decimal count would have over-read", () => {
    // Guards the reasoning, not the code: if someone reverts to a decimal
    // count, these are the byte counts the target would actually return.
    assert.equal(parseInt("20", 16), 32);
    assert.equal(parseInt("256", 16), 598);
    assert.equal(parseInt("64", 16), 100);
  });
});
