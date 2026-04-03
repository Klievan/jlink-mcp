#!/usr/bin/env node
/**
 * Standalone MCP server entry point.
 * Run with: node out/mcp/standalone.js
 *
 * Environment variables:
 *   PROBE_TYPE       - "jlink" (default), "openocd", "blackmagic"
 *
 *   J-Link:
 *     JLINK_DEVICE, JLINK_INSTALL_DIR, JLINK_INTERFACE, JLINK_SPEED,
 *     JLINK_SERIAL, JLINK_GDB_PORT, JLINK_RTT_PORT, JLINK_SWO_PORT
 *
 *   OpenOCD:
 *     OPENOCD_BINARY, OPENOCD_INTERFACE, OPENOCD_TARGET,
 *     OPENOCD_GDB_PORT, OPENOCD_TELNET_PORT
 *
 *   Black Magic Probe:
 *     BMP_GDB_PATH, BMP_SERIAL_PORT, BMP_TARGET_INDEX
 *
 *   Telnet proxy:
 *     TELNET_PROXY_PORT, TELNET_PROXY_SOURCE_PORT, TELNET_PROXY_SOURCE_HOST
 */

// Provide a minimal vscode stub (only needed for config.ts imports that reference vscode)
const vscodeStub = {
  workspace: {
    getConfiguration: (_section: string) => ({
      get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
    }),
  },
};

const Module = require("module");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...args: any[]) {
  if (request === "vscode") return request;
  return originalResolve.call(this, request, ...args);
};
require.cache["vscode"] = { id: "vscode", filename: "vscode", loaded: true, exports: vscodeStub } as any;

import { JLinkMcpServer } from "./server";
import { ProbeFactoryConfig, ProbeType } from "../probe/factory";
import { initLogger } from "../utils/logger";

// Stderr logger for standalone mode
initLogger({ appendLine(msg: string) { process.stderr.write(msg + "\n"); } } as any);

function env(key: string): string | undefined { return process.env[key]; }
function envNum(key: string, def: number): number { const v = env(key); return v ? Number(v) : def; }

function buildProbeConfig(): ProbeFactoryConfig {
  const probeType = (env("PROBE_TYPE") || "jlink") as ProbeType;

  switch (probeType) {
    case "jlink":
      return {
        type: "jlink",
        jlink: {
          device: env("JLINK_DEVICE") || "Unspecified",
          installDir: env("JLINK_INSTALL_DIR"),
          interface: (env("JLINK_INTERFACE") as "SWD" | "JTAG") || undefined,
          speed: env("JLINK_SPEED") ? Number(env("JLINK_SPEED")) : undefined,
          serialNumber: env("JLINK_SERIAL"),
          gdbPort: env("JLINK_GDB_PORT") ? Number(env("JLINK_GDB_PORT")) : undefined,
          rttTelnetPort: env("JLINK_RTT_PORT") ? Number(env("JLINK_RTT_PORT")) : undefined,
          swoTelnetPort: env("JLINK_SWO_PORT") ? Number(env("JLINK_SWO_PORT")) : undefined,
        },
      };

    case "openocd":
      return {
        type: "openocd",
        openocd: {
          binaryPath: env("OPENOCD_BINARY"),
          interfaceConfig: env("OPENOCD_INTERFACE"),
          targetConfig: env("OPENOCD_TARGET"),
          gdbPort: env("OPENOCD_GDB_PORT") ? Number(env("OPENOCD_GDB_PORT")) : undefined,
          telnetPort: env("OPENOCD_TELNET_PORT") ? Number(env("OPENOCD_TELNET_PORT")) : undefined,
        },
      };

    case "blackmagic":
      return {
        type: "blackmagic",
        blackmagic: {
          gdbPath: env("BMP_GDB_PATH"),
          serialPort: env("BMP_SERIAL_PORT"),
          targetIndex: env("BMP_TARGET_INDEX") ? Number(env("BMP_TARGET_INDEX")) : undefined,
        },
      };

    default:
      process.stderr.write(`Unknown PROBE_TYPE: ${probeType}. Using jlink.\n`);
      return { type: "jlink" };
  }
}

async function main() {
  const probeConfig = buildProbeConfig();
  process.stderr.write(`Starting MCP server with probe: ${probeConfig.type}\n`);

  const server = new JLinkMcpServer(
    probeConfig,
    undefined, // rttPort derived from probe
    {
      listenPort: envNum("TELNET_PROXY_PORT", 19400),
      sourceHost: env("TELNET_PROXY_SOURCE_HOST") || "localhost",
      sourcePort: env("TELNET_PROXY_SOURCE_PORT") ? Number(env("TELNET_PROXY_SOURCE_PORT")) : undefined,
    }
  );

  process.on("SIGINT", () => { server.dispose(); process.exit(0); });
  process.on("SIGTERM", () => { server.dispose(); process.exit(0); });

  await server.startStdio();
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err}\n`);
  process.exit(1);
});
