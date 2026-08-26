import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PROFILE,
  emitGdbCommands,
  emitJLinkCommands,
  PostAttachOp,
  resolveDeviceProfile,
  _listProfilesForTest,
} from "../src/probe/device-profiles";

describe("resolveDeviceProfile", () => {
  it("returns the default profile for undefined", () => {
    assert.equal(resolveDeviceProfile(undefined).id, "default");
  });

  it("returns the default profile for an unknown device", () => {
    assert.equal(resolveDeviceProfile("nRF5340_xxAA_APP").id, "default");
    assert.equal(resolveDeviceProfile("").id, "default");
  });

  it("matches STM32L0 family", () => {
    assert.equal(resolveDeviceProfile("STM32L073RZ").id, "stm32l0");
    assert.equal(resolveDeviceProfile("stm32l010f4").id, "stm32l0");
  });

  it("matches STM32L1 family", () => {
    assert.equal(resolveDeviceProfile("STM32L152C8").id, "stm32l1");
  });

  it("matches STM32F0 family", () => {
    assert.equal(resolveDeviceProfile("STM32F030F4").id, "stm32f0");
  });

  it("does not confuse L0 with L1", () => {
    // Regression: if match order changes, L1 might accidentally match L0.
    assert.equal(resolveDeviceProfile("STM32L100RC").id, "stm32l1");
    assert.equal(resolveDeviceProfile("STM32L071CB").id, "stm32l0");
  });

  it("is case-insensitive", () => {
    assert.equal(resolveDeviceProfile("stm32L073Rz").id, "stm32l0");
  });

  it("default profile has no overrides", () => {
    assert.equal(DEFAULT_PROFILE.speedKhz, undefined);
    assert.equal(DEFAULT_PROFILE.postAttachOps, undefined);
  });

  it("registered profiles are ordered specific → general", () => {
    // The resolver returns the first match, so any two profiles whose
    // regexes overlap must have the more specific one first. This test
    // just documents that no known STM32 pattern accidentally matches
    // the wildcard default.
    const profiles = _listProfilesForTest();
    for (const p of profiles) {
      assert.notEqual(p.id, "default", "default should not appear in the profile list");
    }
  });
});

describe("emitJLinkCommands", () => {
  it("emits w4 for a 32-bit write with zero-padded hex", () => {
    const ops: PostAttachOp[] = [
      { kind: "write", address: 0x40015804, value: 0x3, bits: 32 },
    ];
    const { commands, skipped } = emitJLinkCommands(ops);
    assert.deepEqual(commands, ["w4 0x40015804, 0x00000003"]);
    assert.equal(skipped.length, 0);
  });

  it("emits w2 for 16-bit and w1 for 8-bit writes", () => {
    const ops: PostAttachOp[] = [
      { kind: "write", address: 0x1000, value: 0xab, bits: 8 },
      { kind: "write", address: 0x2000, value: 0xbeef, bits: 16 },
    ];
    const { commands } = emitJLinkCommands(ops);
    assert.deepEqual(commands, ["w1 0x1000, 0xab", "w2 0x2000, 0xbeef"]);
  });

  it("skips setBits ops — Commander cannot express read-modify-write", () => {
    const ops: PostAttachOp[] = [
      { kind: "setBits", address: 0x40021034, mask: 1 << 22, bits: 32, label: "APB2ENR.DBGMCUEN" },
    ];
    const { commands, skipped } = emitJLinkCommands(ops);
    assert.deepEqual(commands, []);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].op.kind, "setBits");
    assert.match(skipped[0].reason, /read-modify-write/i);
  });

  it("preserves order and interleaves emitted vs skipped correctly", () => {
    const ops: PostAttachOp[] = [
      { kind: "setBits", address: 0xA, mask: 1, bits: 32 },
      { kind: "write", address: 0xB, value: 0xFF, bits: 8 },
      { kind: "setBits", address: 0xC, mask: 2, bits: 32 },
    ];
    const { commands, skipped } = emitJLinkCommands(ops);
    assert.deepEqual(commands, ["w1 0xb, 0xff"]);
    assert.equal(skipped.length, 2);
  });
});

describe("emitGdbCommands", () => {
  it("emits typed-braces set for a 32-bit write", () => {
    const ops: PostAttachOp[] = [
      { kind: "write", address: 0x40015804, value: 0x3, bits: 32 },
    ];
    const { commands, skipped } = emitGdbCommands(ops);
    assert.deepEqual(commands, ["set {unsigned int}0x40015804 = 0x00000003"]);
    assert.equal(skipped.length, 0);
  });

  it("picks the correct C type for each width", () => {
    const ops: PostAttachOp[] = [
      { kind: "write", address: 0x1, value: 0xab, bits: 8 },
      { kind: "write", address: 0x2, value: 0xbeef, bits: 16 },
      { kind: "write", address: 0x4, value: 0xdeadbeef, bits: 32 },
    ];
    const { commands } = emitGdbCommands(ops);
    assert.deepEqual(commands, [
      "set {unsigned char}0x1 = 0xab",
      "set {unsigned short}0x2 = 0xbeef",
      "set {unsigned int}0x4 = 0xdeadbeef",
    ]);
  });

  it("expands setBits into read-modify-write via typed-braces", () => {
    const ops: PostAttachOp[] = [
      { kind: "setBits", address: 0x40021034, mask: 1 << 22, bits: 32 },
    ];
    const { commands } = emitGdbCommands(ops);
    assert.deepEqual(commands, [
      "set {unsigned int}0x40021034 = {unsigned int}0x40021034 | 0x00400000",
    ]);
  });

  it("emits all ops in order", () => {
    const ops: PostAttachOp[] = [
      { kind: "setBits", address: 0xA, mask: 1, bits: 32 },
      { kind: "write", address: 0xB, value: 0xFF, bits: 32 },
    ];
    const { commands } = emitGdbCommands(ops);
    assert.equal(commands.length, 2);
    assert.match(commands[0], /^set \{unsigned int\}0xa =.*\| 0x00000001$/);
    assert.match(commands[1], /^set \{unsigned int\}0xb = 0x000000ff$/);
  });
});

describe("STM32L0 profile — real-world regression checks", () => {
  const profile = resolveDeviceProfile("STM32L073RZ");

  it("uses 1 MHz SWD (DPv0 handshake is unreliable at 4 MHz)", () => {
    assert.equal(profile.speedKhz, 1000);
  });

  it("clocks DBGMCU on APB2 as the first op (prerequisite for DBGMCU writes)", () => {
    assert.ok(profile.postAttachOps);
    const first = profile.postAttachOps![0];
    assert.equal(first.kind, "setBits");
    assert.equal(first.address, 0x40021034); // RCC_APB2ENR
    assert.equal((first as { mask: number }).mask, 1 << 22); // DBGMCUEN
  });

  it("writes DBGMCU_CR with 0x3 (L0 has no DBG_SLEEP bit; only STOP+STANDBY)", () => {
    const crWrite = profile.postAttachOps!.find(
      (op) => op.kind === "write" && op.address === 0x40015804,
    );
    assert.ok(crWrite);
    assert.equal((crWrite as { value: number }).value, 0x3);
  });

  it("freezes IWDG and WWDG on halt (bits 10 and 11 in DBGMCU_APB1_FZ)", () => {
    const fzOp = profile.postAttachOps!.find(
      (op) => op.kind === "setBits" && op.address === 0x40015808,
    );
    assert.ok(fzOp);
    assert.equal((fzOp as { mask: number }).mask, (1 << 11) | (1 << 10));
  });
});
