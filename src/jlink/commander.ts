import { spawn } from "child_process";
import { getConfig, getJLinkExePath } from "../utils/config";
import { log, logError } from "../utils/logger";

export interface JLinkCommandResult {
  success: boolean;
  /** Raw full output from JLinkExe */
  rawOutput: string;
  /** Cleaned output with connection boilerplate stripped */
  output: string;
  error?: string;
}

// Lines that are JLink connection boilerplate - strip these for clean output
const BOILERPLATE_PATTERNS = [
  /^SEGGER J-Link Commander/,
  /^DLL version/,
  /^J-Link Commander will now exit/,
  /^Connecting to J-Link via USB/,
  /^Firmware: J-Link/,
  /^Hardware version:/,
  /^J-Link uptime/,
  /^S\/N:/,
  /^License\(s\):/,
  /^USB speed mode:/,
  /^VTref=/,
  /^Device ".*" selected/,
  /^Connecting to target via SWD/,
  /^Connecting to target via JTAG/,
  /^ConfigTargetSettings\(\)/,
  /^InitTarget\(\)/,
  /^Found SW-DP with ID/,
  /^DPIDR:/,
  /^CoreSight/,
  /^AP map detection/,
  /^AP\[\d+\]:/,
  /^CPUID register:/,
  /^Feature set:/,
  /^Cache:/,
  /^Found Cortex-/,
  /^FPUnit:/,
  /^Security extension: /,
  /^Secure debug:/,
  /^ROMTbl\[\d+\]/,
  /^\[\d+\]\[\d+\]:/,
  /^Memory zones:/,
  /^\s+Zone:/,
  /^Cortex-M\d+ identified/,
  /^Type "connect"/,
  /^Please specify/,
  /^Specify target/,
  /^$/, // blank lines
  /^J-Link>/, // prompt
  /^J-Link\[\d+\]:/,
  /^Syntax:/,
  /^Sleep\(\d+\)/,
  /^Script processing completed/,
];

/** Strip JLink connection boilerplate from output, returning only meaningful data */
export function stripBoilerplate(raw: string): string {
  const lines = raw.split("\n");
  const meaningful: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const isBoilerplate = BOILERPLATE_PATTERNS.some((p) => p.test(trimmed));
    if (!isBoilerplate) {
      meaningful.push(line);
    }
  }
  return meaningful.join("\n").trim();
}

/** Parse register dump into structured JSON */
export function parseRegisters(raw: string): Record<string, string> | null {
  const regs: Record<string, string> = {};
  const regPatterns = [
    // "PC = 0000BF54, CycleCnt = 0000855D"
    /(\w+)\s*=\s*([0-9A-Fa-f]{2,8})(?:,|\s|$)/g,
    // "SP(R13)= 20062880"
    /(\w+)\((\w+)\)\s*=\s*([0-9A-Fa-f]{2,8})/g,
  ];

  // Match standard register lines
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    // Skip non-register lines
    if (!trimmed || trimmed.startsWith("SEGGER") || trimmed.startsWith("Connecting")) continue;

    // "R0 = 20060050, R1 = 00000000, ..."
    let match;
    const simple = /(\w[\w()]*)\s*=\s*([0-9A-Fa-f]{2,8})/g;
    while ((match = simple.exec(trimmed)) !== null) {
      let name = match[1];
      const value = match[2];
      // Normalize SP(R13) → SP
      const parenMatch = name.match(/^(\w+)\(\w+\)$/);
      if (parenMatch) name = parenMatch[1];
      regs[name] = `0x${value}`;
    }

    // "XPSR = 41000000: APSR = nZcvq, ..."
    const xpsrMatch = trimmed.match(/APSR\s*=\s*(\w+)/);
    if (xpsrMatch) regs["APSR"] = xpsrMatch[1];
  }

  return Object.keys(regs).length > 0 ? regs : null;
}

/** Format registers as a compact, LLM-friendly summary */
export function formatRegistersCompact(regs: Record<string, string>): string {
  const core = ["PC", "SP", "LR", "R0", "R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10", "R11", "R12"];
  const status = ["XPSR", "CONTROL", "PRIMASK", "BASEPRI", "FAULTMASK"];
  const stack = ["MSP", "PSP", "MSPLIM", "PSPLIM"];

  const lines: string[] = [];

  // Core registers
  const coreVals = core.filter((r) => regs[r]).map((r) => `${r}=${regs[r]}`);
  lines.push("Core: " + coreVals.join(" "));

  // Status
  const statusVals = status.filter((r) => regs[r]).map((r) => `${r}=${regs[r]}`);
  if (statusVals.length > 0) lines.push("Status: " + statusVals.join(" "));

  // Stack
  const stackVals = stack.filter((r) => regs[r]).map((r) => `${r}=${regs[r]}`);
  if (stackVals.length > 0) lines.push("Stack: " + stackVals.join(" "));

  // FP registers - only show non-zero ones
  const fpNonZero = Object.entries(regs)
    .filter(([k, v]) => k.startsWith("FPS") && v !== "0x00000000")
    .map(([k, v]) => `${k}=${v}`);
  if (fpNonZero.length > 0) lines.push("FP (non-zero): " + fpNonZero.join(" "));

  return lines.join("\n");
}

/** Parse memory dump lines into hex string */
export function parseMemoryDump(raw: string): { address: string; hex: string; ascii: string }[] {
  const results: { address: string; hex: string; ascii: string }[] = [];
  for (const line of raw.split("\n")) {
    // "E000ED28 = 00 00 00 00 00 00 00 00  01 00 00 00 74 28 06 20  ............t(. "
    const match = line.match(/^([0-9A-Fa-f]{8})\s*=\s*(.+?)\s{2,}(.*)$/);
    if (match) {
      results.push({
        address: `0x${match[1]}`,
        hex: match[2].trim(),
        ascii: match[3].trim(),
      });
    }
  }
  return results;
}

/** Decode ARM Cortex-M fault status registers */
export function decodeFaultRegisters(cfsr: number, hfsr: number, mmfar: number, bfar: number): string {
  const lines: string[] = [];

  // CFSR = UFSR (bits 16-31) | BFSR (bits 8-15) | MMFSR (bits 0-7)
  const mmfsr = cfsr & 0xFF;
  const bfsr = (cfsr >> 8) & 0xFF;
  const ufsr = (cfsr >> 16) & 0xFFFF;

  if (cfsr === 0 && hfsr === 0) {
    lines.push("No faults detected (CFSR=0, HFSR=0)");
    return lines.join("\n");
  }

  // MemManage faults
  if (mmfsr) {
    lines.push("## MemManage Fault (MMFSR):");
    if (mmfsr & 0x01) lines.push("  - IACCVIOL: Instruction access violation");
    if (mmfsr & 0x02) lines.push("  - DACCVIOL: Data access violation");
    if (mmfsr & 0x08) lines.push("  - MUNSTKERR: MemManage on unstacking (exception return)");
    if (mmfsr & 0x10) lines.push("  - MSTKERR: MemManage on stacking (exception entry)");
    if (mmfsr & 0x20) lines.push("  - MLSPERR: MemManage during FP lazy state preservation");
    if (mmfsr & 0x80) {
      lines.push(`  - MMARVALID: Faulting address = 0x${mmfar.toString(16).padStart(8, "0")}`);
    }
  }

  // BusFault
  if (bfsr) {
    lines.push("## BusFault (BFSR):");
    if (bfsr & 0x01) lines.push("  - IBUSERR: Instruction bus error");
    if (bfsr & 0x02) lines.push("  - PRECISERR: Precise data bus error");
    if (bfsr & 0x04) lines.push("  - IMPRECISERR: Imprecise data bus error");
    if (bfsr & 0x08) lines.push("  - UNSTKERR: BusFault on unstacking");
    if (bfsr & 0x10) lines.push("  - STKERR: BusFault on stacking");
    if (bfsr & 0x20) lines.push("  - LSPERR: BusFault during FP lazy state preservation");
    if (bfsr & 0x80) {
      lines.push(`  - BFARVALID: Faulting address = 0x${bfar.toString(16).padStart(8, "0")}`);
    }
  }

  // UsageFault
  if (ufsr) {
    lines.push("## UsageFault (UFSR):");
    if (ufsr & 0x0001) lines.push("  - UNDEFINSTR: Undefined instruction");
    if (ufsr & 0x0002) lines.push("  - INVSTATE: Invalid state (e.g., Thumb bit)");
    if (ufsr & 0x0004) lines.push("  - INVPC: Invalid PC load (bad EXC_RETURN)");
    if (ufsr & 0x0008) lines.push("  - NOCP: No coprocessor");
    if (ufsr & 0x0010) lines.push("  - STKOF: Stack overflow detected");
    if (ufsr & 0x0100) lines.push("  - UNALIGNED: Unaligned memory access");
    if (ufsr & 0x0200) lines.push("  - DIVBYZERO: Division by zero");
  }

  // HardFault
  if (hfsr) {
    lines.push("## HardFault (HFSR):");
    if (hfsr & 0x02) lines.push("  - VECTTBL: Vector table read fault on exception processing");
    if (hfsr & 0x40000000) lines.push("  - FORCED: Forced HardFault (escalated from configurable fault)");
    if (hfsr & 0x80000000) lines.push("  - DEBUGEVT: Debug event triggered HardFault");
  }

  return lines.join("\n");
}

/**
 * Executes J-Link Commander commands by spawning JLinkExe with a script.
 * Each call opens a new connection, runs the commands, and exits.
 */
export async function executeJLinkCommands(
  commands: string[],
  deviceOverride?: string
): Promise<JLinkCommandResult> {
  const config = getConfig();
  const jlinkExe = getJLinkExePath(config.jlink);

  const device = deviceOverride || config.jlink.device;
  const scriptLines = [...commands, "exit"];

  const args = [
    "-device", device,
    "-if", config.jlink.interface,
    "-speed", String(config.jlink.speed),
    "-autoconnect", "1",
    "-ExitOnError", "1",
    "-NoGui", "1",
  ];

  if (config.jlink.serialNumber) {
    args.push("-SelectEmuBySN", config.jlink.serialNumber);
  }

  log(`JLink Commander: ${commands.join("; ")}`);

  return new Promise<JLinkCommandResult>((resolve) => {
    const proc = spawn(jlinkExe, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    const script = scriptLines.join("\n") + "\n";
    proc.stdin?.write(script);
    proc.stdin?.end();

    proc.on("error", (err) => {
      logError("JLink Commander spawn error", err);
      resolve({
        success: false,
        rawOutput: stdout,
        output: stdout,
        error: `Failed to spawn JLinkExe: ${err.message}. Is J-Link installed at ${config.jlink.installDir}?`,
      });
    });

    proc.on("exit", (code) => {
      const success = code === 0;
      if (!success) {
        logError(`JLink Commander exited with code ${code}`);
      }
      resolve({
        success,
        rawOutput: stdout,
        output: stripBoilerplate(stdout),
        error: stderr || undefined,
      });
    });

    setTimeout(() => {
      proc.kill("SIGTERM");
      resolve({
        success: false,
        rawOutput: stdout,
        output: stripBoilerplate(stdout),
        error: "JLink Commander timed out after 30 seconds",
      });
    }, 30000);
  });
}

/** Connect and get device info - returns a compact summary */
export async function getDeviceInfo(): Promise<JLinkCommandResult> {
  return executeJLinkCommands(["halt", "regs"]);
}

/** Halt the CPU */
export async function haltDevice(): Promise<JLinkCommandResult> {
  return executeJLinkCommands(["halt"]);
}

/** Resume (go) the CPU */
export async function resumeDevice(): Promise<JLinkCommandResult> {
  return executeJLinkCommands(["go"]);
}

/** Reset the device */
export async function resetDevice(halt: boolean = false): Promise<JLinkCommandResult> {
  return executeJLinkCommands(halt ? ["r", "halt"] : ["r", "go"]);
}

/** Read memory at address */
export async function readMemory(
  address: number,
  numBytes: number
): Promise<JLinkCommandResult> {
  const addrHex = `0x${address.toString(16)}`;
  return executeJLinkCommands([`mem ${addrHex}, ${numBytes}`]);
}

/** Write memory (32-bit words) */
export async function writeMemory(
  address: number,
  value: number
): Promise<JLinkCommandResult> {
  const addrHex = `0x${address.toString(16)}`;
  const valHex = `0x${value.toString(16)}`;
  return executeJLinkCommands([`w4 ${addrHex}, ${valHex}`]);
}

/** Read a CPU register by name */
export async function readRegister(
  register: string
): Promise<JLinkCommandResult> {
  return executeJLinkCommands(["halt", `rreg ${register}`]);
}

/** Read all registers */
export async function readAllRegisters(): Promise<JLinkCommandResult> {
  return executeJLinkCommands(["halt", "regs"]);
}

/** Flash a firmware file */
export async function flashFirmware(
  filePath: string,
  baseAddress?: number
): Promise<JLinkCommandResult> {
  const addr = baseAddress !== undefined ? ` 0x${baseAddress.toString(16)}` : "";
  return executeJLinkCommands([
    "r", "halt",
    `loadfile ${filePath}${addr}`,
    "r", "go",
  ]);
}

/** Erase the chip */
export async function eraseChip(): Promise<JLinkCommandResult> {
  return executeJLinkCommands(["erase"]);
}

/** Set a hardware breakpoint */
export async function setBreakpoint(
  address: number
): Promise<JLinkCommandResult> {
  return executeJLinkCommands([`SetBP 0x${address.toString(16)}`]);
}

/** Clear all breakpoints */
export async function clearBreakpoints(): Promise<JLinkCommandResult> {
  return executeJLinkCommands(["ClrBP"]);
}

/** Step one instruction */
export async function stepInstruction(): Promise<JLinkCommandResult> {
  return executeJLinkCommands(["halt", "s"]);
}

/** Execute arbitrary J-Link commands */
export async function executeRawCommands(
  rawCommands: string[]
): Promise<JLinkCommandResult> {
  return executeJLinkCommands(rawCommands);
}

/** Read fault registers and decode them */
export async function readFaultRegisters(): Promise<{
  result: JLinkCommandResult;
  decoded: string;
  raw: { cfsr: number; hfsr: number; mmfar: number; bfar: number };
}> {
  // Read CFSR, HFSR, MMFAR, BFAR in one shot (16 bytes from 0xE000ED28)
  const result = await executeJLinkCommands(["halt", "mem 0xE000ED28, 20"]);
  const dump = parseMemoryDump(result.rawOutput);

  let cfsr = 0, hfsr = 0, mmfar = 0, bfar = 0;

  // Parse the hex bytes from the memory dump
  if (dump.length > 0) {
    const allHex = dump.map((d) => d.hex).join(" ");
    const bytes = allHex.split(/\s+/).filter(Boolean);
    if (bytes.length >= 16) {
      // Little-endian: CFSR at offset 0, HFSR at 4, (DFSR at 8), MMFAR at 12, BFAR at 16
      cfsr = parseLittleEndian32(bytes, 0);
      hfsr = parseLittleEndian32(bytes, 4);
      mmfar = parseLittleEndian32(bytes, 12);
      bfar = parseLittleEndian32(bytes, 16);
    }
  }

  return {
    result,
    decoded: decodeFaultRegisters(cfsr, hfsr, mmfar, bfar),
    raw: { cfsr, hfsr, mmfar, bfar },
  };
}

function parseLittleEndian32(bytes: string[], offset: number): number {
  if (offset + 3 >= bytes.length) return 0;
  return (
    (parseInt(bytes[offset], 16)) |
    (parseInt(bytes[offset + 1], 16) << 8) |
    (parseInt(bytes[offset + 2], 16) << 16) |
    (parseInt(bytes[offset + 3], 16) << 24)
  ) >>> 0;
}
