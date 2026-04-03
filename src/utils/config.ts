import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

export interface JLinkConfig {
  /** Path to SEGGER J-Link installation directory */
  installDir: string;
  /** Target device name (e.g., "NRF52840_XXAA", "STM32F407VG") */
  device: string;
  /** Interface: SWD or JTAG */
  interface: "SWD" | "JTAG";
  /** Connection speed in kHz */
  speed: number;
  /** Serial number of J-Link (optional, for multi-probe setups) */
  serialNumber?: string;
  /** GDB server port */
  gdbPort: number;
  /** RTT telnet port */
  rttTelnetPort: number;
  /** SWO telnet port */
  swoTelnetPort: number;
}

export interface TelnetProxyConfig {
  /** Port for the telnet proxy (for Trice/Pigweed) */
  listenPort: number;
  /** Source port to proxy from (usually RTT telnet port) */
  sourcePort: number;
  /** Source host */
  sourceHost: string;
}

export interface TriceConfig {
  /** Path to trice binary */
  binaryPath: string;
  /** Path to til.json (Trice ID List) */
  idListPath: string;
  /** Encoding format */
  encoding: string;
}

export interface PigweedConfig {
  /** Path to detokenizer database (.csv or .elf) */
  tokenDatabase: string;
  /** Path to Python or pw command */
  pythonPath: string;
}

export interface ExtensionConfig {
  jlink: JLinkConfig;
  telnetProxy: TelnetProxyConfig;
  trice: TriceConfig;
  pigweed: PigweedConfig;
}

function findJLinkInstallDir(): string {
  const candidates = [
    "/opt/SEGGER/JLink",
    "/usr/local/SEGGER/JLink",
    "/Applications/SEGGER/JLink",
    "C:\\Program Files\\SEGGER\\JLink",
    "C:\\Program Files (x86)\\SEGGER\\JLink",
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  // Also check with version suffix
  for (const base of ["/opt/SEGGER", "/Applications/SEGGER", "/usr/local/SEGGER"]) {
    if (fs.existsSync(base)) {
      try {
        const entries = fs.readdirSync(base).filter((e) => e.startsWith("JLink"));
        if (entries.length > 0) {
          return path.join(base, entries.sort().reverse()[0]);
        }
      } catch {
        // ignore
      }
    }
  }
  return "";
}

export function getConfig(): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration("jlinkMcp");

  return {
    jlink: {
      installDir: cfg.get<string>("jlink.installDir") || findJLinkInstallDir(),
      device: cfg.get<string>("jlink.device") || "Unspecified",
      interface: cfg.get<"SWD" | "JTAG">("jlink.interface") || "SWD",
      speed: cfg.get<number>("jlink.speed") || 4000,
      serialNumber: cfg.get<string>("jlink.serialNumber") || undefined,
      gdbPort: cfg.get<number>("jlink.gdbPort") || 2331,
      rttTelnetPort: cfg.get<number>("jlink.rttTelnetPort") || 19021,
      swoTelnetPort: cfg.get<number>("jlink.swoTelnetPort") || 2332,
    },
    telnetProxy: {
      listenPort: cfg.get<number>("telnetProxy.listenPort") || 19400,
      sourcePort: cfg.get<number>("telnetProxy.sourcePort") || 19021,
      sourceHost: cfg.get<string>("telnetProxy.sourceHost") || "localhost",
    },
    trice: {
      binaryPath: cfg.get<string>("trice.binaryPath") || "trice",
      idListPath: cfg.get<string>("trice.idListPath") || "",
      encoding: cfg.get<string>("trice.encoding") || "TREX",
    },
    pigweed: {
      tokenDatabase: cfg.get<string>("pigweed.tokenDatabase") || "",
      pythonPath: cfg.get<string>("pigweed.pythonPath") || "python3",
    },
  };
}

export function getJLinkExePath(config: JLinkConfig): string {
  const exe = process.platform === "win32" ? "JLink.exe" : "JLinkExe";
  return config.installDir ? path.join(config.installDir, exe) : exe;
}

export function getJLinkGDBServerPath(config: JLinkConfig): string {
  const exe =
    process.platform === "win32"
      ? "JLinkGDBServerCL.exe"
      : "JLinkGDBServerCLExe";
  return config.installDir ? path.join(config.installDir, exe) : exe;
}

export function getJLinkRTTClientPath(config: JLinkConfig): string {
  const exe =
    process.platform === "win32" ? "JLinkRTTClient.exe" : "JLinkRTTClientExe";
  return config.installDir ? path.join(config.installDir, exe) : exe;
}
