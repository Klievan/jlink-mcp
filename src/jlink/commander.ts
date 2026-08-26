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

// ─────────────────────────────────────────────────────────────────────
// NOTE: this module is a remnant of the pre-ProbeBackend design and is
// now reached from exactly one place — the VSCode "Flash Firmware"
// command in extension.ts, which imports flashFirmware.
//
// It used to also carry its own parseRegisters / parseMemoryDump /
// decodeFaultRegisters / formatRegistersCompact / parseLittleEndian32
// and a full set of command wrappers. Those were dead copies of the
// implementations on ProbeBackend, and they had silently diverged: they
// still contained the memory-dump bug that dropped half of every J-Link
// line at the mid-line byte-group separator, and never gained GDB
// register-format support. Anyone wiring them back up would have
// inherited both. They are deleted rather than fixed twice — the live
// implementations live on ProbeBackend (src/probe/backend.ts) and are
// covered by test/unit/.
//
// Prefer routing new work through ProbeBackend. Do not re-add parsing
// helpers here.
// ─────────────────────────────────────────────────────────────────────
/**
 * Executes J-Link Commander commands by spawning JLinkExe with a script.
 * Each call opens a new connection, runs the commands, and exits.
 *
 * `-ExitOnError 1` is deliberately omitted. J-Link's autoconnect flow
 * prints an "Error: Failed to initialize DAP" line before a successful
 * connect-under-reset fallback, and `-ExitOnError` treats that transient
 * message as fatal, causing the script to be dropped before the user's
 * commands run. Genuine failures are still surfaced via the stdout
 * classification below and via the non-zero exit code when JLinkExe
 * itself refuses to run.
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
      let success = code === 0;
      if (!success) {
        logError(`JLink Commander exited with code ${code}`);
      }
      // Without -ExitOnError, JLinkExe may exit 0 even when the target
      // could not be reached. Flag those cases explicitly so callers can
      // still branch on `.success`.
      const raw = stdout.toLowerCase();
      let error: string | undefined = stderr || undefined;
      if (raw.includes("inittarget() returned error") || raw.includes("could not connect") || raw.includes("cannot connect")) {
        success = false;
        error = error || "Target attach failed (see rawOutput for details).";
      } else if (raw.includes("failed to open dll") || raw.includes("no j-link") || raw.includes("no emulators found")) {
        success = false;
        error = error || "No J-Link probe found.";
      }
      resolve({
        success,
        rawOutput: stdout,
        output: stripBoilerplate(stdout),
        error,
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
