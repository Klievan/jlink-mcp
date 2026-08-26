/**
 * Device profile registry.
 *
 * Some target MCUs need small deviations from the generic J-Link connect
 * flow — a lower SWD clock during attach, a debug-freeze register write to
 * keep SWD alive across low-power modes, watchdog freeze so halting the
 * CPU doesn't trigger an IWDG reset, etc. Rather than sprinkling
 * `if (device === "STM32L0…")` checks through the backends, we resolve a
 * profile once from the device name and thread it through both the
 * JLinkExe (Commander) path and the GDB path.
 *
 * Post-attach setup is described as a list of typed ops — plain writes
 * plus read-modify-write bit sets. The same list is emitted as
 * J-Link Commander lines (`w4 …`) or as GDB expressions
 * (`set {unsigned int}… = …`) via the helpers below. That way a profile
 * author never has to think about which channel is going to run first.
 *
 * Adding a new profile is a single object literal at the bottom of this
 * file; nothing else needs to change.
 */

/** Width of a memory-mapped register access. */
export type RegisterWidth = 8 | 16 | 32;

/** Plain memory-mapped write: `*addr = value`. */
export interface WriteOp {
  kind: "write";
  address: number;
  value: number;
  bits: RegisterWidth;
  label?: string;
}

/**
 * Read-modify-write bit set: `*addr |= mask`. Use this for registers
 * whose other bits belong to the user's firmware (e.g. `RCC_APB2ENR`)
 * and must not be clobbered by our debug setup.
 */
export interface SetBitsOp {
  kind: "setBits";
  address: number;
  mask: number;
  bits: RegisterWidth;
  label?: string;
}

/** One step of a post-attach setup sequence. */
export type PostAttachOp = WriteOp | SetBitsOp;

/**
 * Extra behavior a specific target family needs when talking to J-Link.
 * All fields are optional; unset means "use the backend default".
 */
export interface DeviceProfile {
  /** Human-readable identifier used in logs (e.g. "stm32l0"). */
  id: string;
  /**
   * Case-insensitive predicate on the device name string as passed to
   * `-device`. First match wins, so order more specific entries earlier.
   */
  match: RegExp;
  /**
   * Preferred SWD clock in kHz for the initial attach. Applied only when
   * the caller has not explicitly overridden the speed.
   */
  speedKhz?: number;
  /**
   * Ops to perform once immediately after attach and before the caller's
   * commands. Order is preserved. Typical uses: clocking DBGMCU, keeping
   * SWD alive across low-power modes, freezing watchdogs so a halt
   * doesn't trigger a reset.
   */
  postAttachOps?: PostAttachOp[];
  /** One-line note surfaced in logs to explain why the profile exists. */
  notes?: string;
}

/**
 * Fallback profile used when no entry matches. Intentionally empty so the
 * default code path is unchanged for unknown devices.
 */
export const DEFAULT_PROFILE: DeviceProfile = {
  id: "default",
  match: /.*/,
};

/**
 * Ordered from most-specific to least-specific. `resolveDeviceProfile`
 * returns the first entry whose `match` fires against the device string.
 */
const PROFILES: DeviceProfile[] = [
  {
    id: "stm32l0",
    match: /^STM32L0/i,
    // Cortex-M0+ over DPv0. The default 4 MHz attach is unreliable when
    // the MCU is running from MSI at reset; drop to 1 MHz for the initial
    // handshake. Users can still override via JLINK_SPEED / settings.
    speedKhz: 1000,
    postAttachOps: [
      // On STM32L0, DBGMCU sits on APB2 and its registers are gated by
      // RCC_APB2ENR.DBGMCUEN (bit 22). Without this, writes to DBGMCU
      // are silently discarded. Must be a bit-set — RCC_APB2ENR carries
      // other user peripheral clocks (SYSCFGEN, TIMxEN, USART1EN, …).
      {
        kind: "setBits",
        address: 0x40021034,
        mask: 1 << 22,
        bits: 32,
        label: "RCC_APB2ENR.DBGMCUEN",
      },
      // DBGMCU_CR: only DBG_STOP (bit 0) and DBG_STANDBY (bit 1) are
      // defined on L0 per RM0367 §26.9.2 / RM0451 §27.9.2. There is no
      // DBG_SLEEP bit — Sleep mode leaves the debugger alive by default.
      // Bit 2 is reserved and must be kept at its reset value, so we
      // write 0x3, not the F1/F4 convention of 0x7.
      {
        kind: "write",
        address: 0x40015804,
        value: 0x00000003,
        bits: 32,
        label: "DBGMCU_CR (DBG_STOP|DBG_STANDBY)",
      },
      // DBGMCU_APB1_FZ: freeze IWDG (bit 10) and WWDG (bit 11) when the
      // core is halted. Without this, halting for more than the IWDG
      // period triggers a reset the moment we resume — every halt looks
      // like a mystery reboot. Bit-set to preserve any freeze bits the
      // user may have configured for other peripherals.
      {
        kind: "setBits",
        address: 0x40015808,
        mask: (1 << 11) | (1 << 10),
        bits: 32,
        label: "DBGMCU_APB1_FZ (IWDG+WWDG freeze on halt)",
      },
    ],
    notes:
      "STM32L0: 1 MHz SWD, clock DBGMCU on APB2, keep debug alive in Stop/Standby, freeze watchdogs on halt.",
  },
  {
    id: "stm32l1",
    match: /^STM32L1/i,
    speedKhz: 1000,
    postAttachOps: [
      // DBGMCU_CR on L1: bits 0/1/2 = DBG_SLEEP/DBG_STOP/DBG_STANDBY.
      {
        kind: "write",
        address: 0xE0042004,
        value: 0x00000007,
        bits: 32,
        label: "DBGMCU_CR (DBG_SLEEP|DBG_STOP|DBG_STANDBY)",
      },
    ],
    notes: "STM32L1: reduce SWD to 1 MHz, keep debug alive in Sleep/Stop/Standby.",
  },
  {
    id: "stm32f0",
    match: /^STM32F0/i,
    speedKhz: 1000,
    postAttachOps: [
      // DBGMCU_CR on F0: same bit layout as L0.
      {
        kind: "write",
        address: 0x40015804,
        value: 0x00000003,
        bits: 32,
        label: "DBGMCU_CR (DBG_STOP|DBG_STANDBY)",
      },
    ],
    notes: "STM32F0: reduce SWD to 1 MHz, keep debug alive in Stop/Standby.",
  },
];

/**
 * Resolve the profile for a given device name. Returns `DEFAULT_PROFILE`
 * when nothing matches, so callers never need to null-check.
 */
export function resolveDeviceProfile(device: string | undefined): DeviceProfile {
  if (!device) return DEFAULT_PROFILE;
  for (const profile of PROFILES) {
    if (profile.match.test(device)) return profile;
  }
  return DEFAULT_PROFILE;
}

/** Format a value as `0x` + zero-padded hex for the given access width. */
function hex(value: number, bits: RegisterWidth): string {
  return `0x${(value >>> 0).toString(16).padStart(bits / 4, "0")}`;
}

/** GDB's typed-braces syntax for a given access width. */
function gdbType(bits: RegisterWidth): string {
  return bits === 8 ? "unsigned char" : bits === 16 ? "unsigned short" : "unsigned int";
}

/** J-Link Commander memory-write mnemonic for a given access width. */
function jlinkWriteMnemonic(bits: RegisterWidth): "w1" | "w2" | "w4" {
  return bits === 8 ? "w1" : bits === 16 ? "w2" : "w4";
}

/**
 * Result of emitting an op for a channel. `commands` are the lines the
 * channel should execute; `skipped` is populated when the channel can't
 * express the op faithfully (see notes on the J-Link Commander emitter).
 */
export interface EmittedOps {
  commands: string[];
  skipped: { op: PostAttachOp; reason: string }[];
}

/**
 * Emit J-Link Commander lines that perform the given ops.
 *
 * Commander scripts are a flat command list with no arithmetic on
 * previously read values, so read-modify-write ops (`setBits`) cannot be
 * expressed inline. They are reported in `skipped` so the caller can log
 * a warning. In practice this only affects the JLinkExe fallback path;
 * the GDB path (where post-attach setup normally runs) handles both.
 */
export function emitJLinkCommands(ops: PostAttachOp[]): EmittedOps {
  const commands: string[] = [];
  const skipped: EmittedOps["skipped"] = [];
  for (const op of ops) {
    if (op.kind === "write") {
      commands.push(`${jlinkWriteMnemonic(op.bits)} 0x${op.address.toString(16)}, ${hex(op.value, op.bits)}`);
    } else {
      skipped.push({
        op,
        reason: "J-Link Commander cannot express read-modify-write inline; op runs via GDB only.",
      });
    }
  }
  return { commands, skipped };
}

/**
 * Emit GDB expressions that perform the given ops over the running
 * session. Uses GDB's typed-braces syntax so we don't need per-arch
 * casts, and reads-then-writes for bit ops so we preserve other bits.
 */
export function emitGdbCommands(ops: PostAttachOp[]): EmittedOps {
  const commands: string[] = [];
  for (const op of ops) {
    const t = gdbType(op.bits);
    const a = `0x${op.address.toString(16)}`;
    if (op.kind === "write") {
      commands.push(`set {${t}}${a} = ${hex(op.value, op.bits)}`);
    } else {
      commands.push(`set {${t}}${a} = {${t}}${a} | ${hex(op.mask, op.bits)}`);
    }
  }
  return { commands, skipped: [] };
}

/** Test hook: expose the raw list so unit tests can assert ordering. */
export function _listProfilesForTest(): readonly DeviceProfile[] {
  return PROFILES;
}
