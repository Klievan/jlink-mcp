#!/usr/bin/env node
/**
 * Standalone MCP server entry point.
 * Run with: node out/mcp/standalone.js
 *
 * This can be used outside of VSCode - e.g., from Claude Desktop or any MCP client.
 * When running standalone, logging goes to stderr.
 */

// Environment variable overrides for standalone mode
const ENV_MAP: Record<string, string> = {
  "jlink.device": "JLINK_DEVICE",
  "jlink.installDir": "JLINK_INSTALL_DIR",
  "jlink.interface": "JLINK_INTERFACE",
  "jlink.speed": "JLINK_SPEED",
  "jlink.serialNumber": "JLINK_SERIAL",
  "jlink.gdbPort": "JLINK_GDB_PORT",
  "jlink.rttTelnetPort": "JLINK_RTT_PORT",
  "jlink.swoTelnetPort": "JLINK_SWO_PORT",
  "telnetProxy.listenPort": "TELNET_PROXY_PORT",
  "telnetProxy.sourcePort": "TELNET_PROXY_SOURCE_PORT",
  "telnetProxy.sourceHost": "TELNET_PROXY_SOURCE_HOST",
  "trice.binaryPath": "TRICE_BINARY",
  "trice.idListPath": "TRICE_ID_LIST",
  "trice.encoding": "TRICE_ENCODING",
  "pigweed.tokenDatabase": "PIGWEED_TOKEN_DB",
  "pigweed.pythonPath": "PIGWEED_PYTHON",
};

// Provide a minimal vscode stub for standalone usage with env var support
const vscodeStub = {
  workspace: {
    getConfiguration: (_section: string) => ({
      get: <T>(_key: string, defaultValue?: T): T | undefined => {
        const envKey = ENV_MAP[_key];
        if (envKey && process.env[envKey]) {
          const val = process.env[envKey]!;
          // Auto-convert numbers
          if (typeof defaultValue === "number") return Number(val) as any;
          return val as any;
        }
        return defaultValue;
      },
    }),
  },
};

// Patch require for vscode module
const Module = require("module");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...args: any[]) {
  if (request === "vscode") {
    return request;
  }
  return originalResolve.call(this, request, ...args);
};
require.cache["vscode"] = {
  id: "vscode",
  filename: "vscode",
  loaded: true,
  exports: vscodeStub,
} as any;

import { JLinkMcpServer } from "./server";

// Simple stderr logger for standalone mode
const stderrChannel = {
  appendLine(msg: string) {
    process.stderr.write(msg + "\n");
  },
};

import { initLogger } from "../utils/logger";
initLogger(stderrChannel as any);

async function main() {
  const server = new JLinkMcpServer();

  process.on("SIGINT", () => {
    server.dispose();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    server.dispose();
    process.exit(0);
  });

  await server.startStdio();
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err}\n`);
  process.exit(1);
});
