import * as vscode from "vscode";
import { JLinkMcpServer } from "./mcp/server";
import { GDBServerManager } from "./jlink/gdb-server";
import { RTTClient } from "./rtt/rtt-client";
import { TelnetProxy } from "./telnet/telnet-proxy";
import { ProcessManager } from "./utils/process-manager";
import { initLogger, log, logError } from "./utils/logger";
import { isPortListening, findGdbServerHolders } from "./utils/gdb-server-probe";
import { getConfig } from "./utils/config";

let mcpServer: JLinkMcpServer | undefined;
let processManager: ProcessManager | undefined;
let gdbServer: GDBServerManager | undefined;
let rttClient: RTTClient | undefined;
let telnetProxy: TelnetProxy | undefined;
let outputChannel: vscode.OutputChannel | undefined;
let rttOutputChannel: vscode.OutputChannel | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let gdbWatch: NodeJS.Timeout | undefined;
let lastGdbRunning: boolean | undefined;

export function activate(context: vscode.ExtensionContext) {
  // Output channels
  outputChannel = vscode.window.createOutputChannel("J-Link MCP");
  rttOutputChannel = vscode.window.createOutputChannel("J-Link RTT");
  initLogger(outputChannel);

  log("J-Link MCP Extension activating...");

  // ── Register MCP Server Definition Provider ──────────────────────
  // This is the native VSCode API (1.99+) for exposing MCP servers.
  // VSCode (Copilot Chat, Claude, etc.) auto-discovers and manages the
  // MCP server lifecycle. The provider reads the user's settings to
  // pass configuration as environment variables to the standalone server.

  const mcpDidChange = new vscode.EventEmitter<void>();

  const mcpProvider = vscode.lm.registerMcpServerDefinitionProvider(
    "jlinkMcp.mcpServer",
    {
      onDidChangeMcpServerDefinitions: mcpDidChange.event,

      provideMcpServerDefinitions(_token: vscode.CancellationToken) {
        const cfg = vscode.workspace.getConfiguration("jlinkMcp");
        const serverScript = vscode.Uri.joinPath(
          context.extensionUri, "out", "mcp", "standalone.js"
        ).fsPath;

        // Build env vars from the user's VSCode settings so the standalone
        // server gets the same config without needing VSCode APIs.
        //
        // Every setting declared in package.json must appear here. A setting
        // that shows up in the settings UI and is then dropped on the floor is
        // worse than one that does not exist: the user configures it, sees no
        // effect, and has no way to tell whether the setting or the hardware
        // is at fault. There is a test that fails if the two lists diverge.
        const env: Record<string, string | number | null> = {};
        const put = (key: string, value: string | number | undefined | null) => {
          if (value !== undefined && value !== null && value !== "") env[key] = value;
        };

        // Which backend to drive. Without this the OpenOCD and Black Magic
        // support is unreachable from the extension entirely.
        const probeType = cfg.get<string>("probeType");
        if (probeType && probeType !== "jlink") put("PROBE_TYPE", probeType);

        // J-Link
        const device = cfg.get<string>("jlink.device");
        if (device && device !== "Unspecified") put("JLINK_DEVICE", device);
        put("JLINK_INSTALL_DIR", cfg.get<string>("jlink.installDir"));
        put("JLINK_INTERFACE", cfg.get<string>("jlink.interface"));
        put("JLINK_SPEED", cfg.get<number>("jlink.speed"));
        put("JLINK_SERIAL", cfg.get<string>("jlink.serialNumber"));
        put("JLINK_GDB_PORT", cfg.get<number>("jlink.gdbPort"));
        put("JLINK_RTT_PORT", cfg.get<number>("jlink.rttTelnetPort"));
        put("JLINK_SWO_PORT", cfg.get<number>("jlink.swoTelnetPort"));
        // Read as hex with or without an 0x prefix, since that is how a map
        // file reports a symbol address.
        const rttAddr = cfg.get<string>("rtt.controlBlockAddress")?.trim();
        if (rttAddr) put("JLINK_RTT_ADDR", String(parseInt(rttAddr, 16)));

        // OpenOCD
        put("OPENOCD_BINARY", cfg.get<string>("openocd.binaryPath"));
        put("OPENOCD_INTERFACE", cfg.get<string>("openocd.interfaceConfig"));
        put("OPENOCD_TARGET", cfg.get<string>("openocd.targetConfig"));
        put("OPENOCD_GDB_PORT", cfg.get<number>("openocd.gdbPort"));
        put("OPENOCD_TELNET_PORT", cfg.get<number>("openocd.telnetPort"));

        // Black Magic Probe
        put("BMP_GDB_PATH", cfg.get<string>("blackmagic.gdbPath"));
        put("BMP_SERIAL_PORT", cfg.get<string>("blackmagic.serialPort"));
        put("BMP_TARGET_INDEX", cfg.get<number>("blackmagic.targetIndex"));

        // Telnet proxy for Trice / Pigweed detokenizers
        put("TELNET_PROXY_PORT", cfg.get<number>("telnetProxy.listenPort"));
        put("TELNET_PROXY_SOURCE_PORT", cfg.get<number>("telnetProxy.sourcePort"));
        put("TELNET_PROXY_SOURCE_HOST", cfg.get<string>("telnetProxy.sourceHost"));

        // The GDB used for source-level debugging.
        put("GDB_PATH", cfg.get<string>("gdbPath"));

        // CMSIS-SVD description, for symbolic peripheral reads.
        put("SVD_PATH", cfg.get<string>("svdPath"));

        return [
          new vscode.McpStdioServerDefinition(
            "J-Link Debug Probe",
            process.execPath,      // Use VSCode's bundled Node.js
            [serverScript],
            env,
            context.extension.packageJSON.version
          ),
        ];
      },

      resolveMcpServerDefinition(server, _token) {
        // Could prompt for device selection here if needed.
        // For now, just pass through.
        return server;
      },
    }
  );
  context.subscriptions.push(mcpProvider, mcpDidChange);

  // Re-fire MCP change event when settings change so VSCode restarts
  // the MCP server with updated config.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("jlinkMcp")) {
        log("J-Link MCP settings changed, notifying VSCode MCP client");
        mcpDidChange.fire();
      }
    })
  );

  log("MCP server definition provider registered");

  // ── Core services for extension UI ───────────────────────────────
  processManager = new ProcessManager();
  const config = getConfig();
  gdbServer = new GDBServerManager(processManager);
  rttClient = new RTTClient("localhost", config.jlink.rttTelnetPort);
  telnetProxy = new TelnetProxy(
    config.telnetProxy.listenPort,
    config.telnetProxy.sourceHost,
    config.telnetProxy.sourcePort
  );

  // RTT data → output channel (cleaned)
  rttClient.on("data", (msg) => {
    for (const line of msg.lines) {
      if (line.deviceTime && line.level && line.module) {
        rttOutputChannel?.appendLine(`[${line.deviceTime}] <${line.level}> ${line.module}: ${line.message}`);
      } else {
        rttOutputChannel?.appendLine(line.message);
      }
    }
  });

  // Status bar
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.text = "$(debug-disconnect) J-Link";
  statusBarItem.tooltip = "J-Link MCP - Click for status";
  statusBarItem.command = "jlinkMcp.showStatus";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand("jlinkMcp.freeProbe", () => offerToFreeProbe())
  );
  startGdbServerWatch(context);

  // ── Register Commands ────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("jlinkMcp.showStatus", async () => {
      const gdbStatus = gdbServer!.getStatus();
      const rttStats = rttClient!.getStats();
      const proxyStatus = telnetProxy!.getStatus();
      const configInfo = getConfig();

      const statusText = [
        "# J-Link MCP Status",
        "",
        `**Device:** ${configInfo.jlink.device}`,
        `**Interface:** ${configInfo.jlink.interface} @ ${configInfo.jlink.speed} kHz`,
        `**J-Link Install Dir:** ${configInfo.jlink.installDir || "(auto-detect)"}`,
        "",
        "## GDB Server",
        `- Running: ${gdbStatus.running ? "Yes" : "No"}`,
        `- GDB Port: ${gdbStatus.gdbPort}`,
        `- RTT Telnet Port: ${gdbStatus.rttTelnetPort}`,
        "",
        "## RTT",
        `- Connected: ${rttStats.connected ? "Yes" : "No"}`,
        `- Messages buffered: ${rttStats.messageCount}`,
        "",
        "## Telnet Proxy",
        `- Running: ${proxyStatus.running ? "Yes" : "No"}`,
        `- Listen Port: ${proxyStatus.listenPort}`,
        `- Clients Connected: ${proxyStatus.clientCount}`,
        `- Buffered Lines: ${proxyStatus.bufferedLines}`,
      ].join("\n");

      const doc = await vscode.workspace.openTextDocument({
        content: statusText,
        language: "markdown",
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("jlinkMcp.startGdbServer", () => {
      const result = gdbServer!.start();
      if (result.success) {
        vscode.window.showInformationMessage(result.message);
        updateStatusBar(true);
      } else {
        vscode.window.showErrorMessage(result.message);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("jlinkMcp.stopGdbServer", () => {
      const result = gdbServer!.stop();
      vscode.window.showInformationMessage(result.message);
      updateStatusBar(false);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("jlinkMcp.connectRtt", async () => {
      try {
        await rttClient!.connect();
        vscode.window.showInformationMessage("Connected to RTT");
        rttOutputChannel!.show();
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to connect to RTT: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("jlinkMcp.disconnectRtt", () => {
      rttClient!.disconnect();
      vscode.window.showInformationMessage("Disconnected from RTT");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("jlinkMcp.startTelnetProxy", async () => {
      const result = await telnetProxy!.start();
      if (result.success) {
        vscode.window.showInformationMessage(result.message);
      } else {
        vscode.window.showErrorMessage(result.message);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("jlinkMcp.stopTelnetProxy", () => {
      telnetProxy!.stop();
      vscode.window.showInformationMessage("Telnet proxy stopped");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("jlinkMcp.flashFirmware", async () => {
      const uri = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: {
          "Firmware Files": ["hex", "bin", "elf"],
          "All Files": ["*"],
        },
        title: "Select firmware file to flash",
      });

      if (!uri || uri.length === 0) return;

      const filePath = uri[0].fsPath;
      const { flashFirmware } = await import("./jlink/commander");

      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Flashing firmware..." },
        async () => {
          const result = await flashFirmware(filePath);
          if (result.success) {
            vscode.window.showInformationMessage(`Firmware flashed successfully: ${filePath}`);
          } else {
            vscode.window.showErrorMessage(`Flash failed: ${result.error || result.output}`);
          }
        }
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("jlinkMcp.showOutput", () => {
      outputChannel!.show();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("jlinkMcp.showRttOutput", () => {
      rttOutputChannel!.show();
    })
  );

  // ── Cleanup on deactivation ──────────────────────────────────────
  context.subscriptions.push({
    dispose() {
      rttClient?.disconnect();
      telnetProxy?.stop();
      processManager?.killAll();
      mcpServer?.dispose();
    },
  });

  log("J-Link MCP Extension activated");
  outputChannel.show(true);
}

/**
 * Poll the GDB port and show what is actually true.
 *
 * updateStatusBar used to be called only from this extension's own start/stop
 * commands, so it reported what *we* had done. An LLM driving the MCP server
 * starts the GDB server in the separate process VSCode spawns for MCP, which
 * the extension host never sees — so the bar read "disconnected" while the
 * probe was held, and the next thing to want the probe failed for reasons
 * nothing on screen explained.
 *
 * A listening port is observable regardless of who is responsible, so poll
 * that instead of trusting our own memory.
 */
function startGdbServerWatch(context: vscode.ExtensionContext) {
  const port = () => vscode.workspace.getConfiguration("jlinkMcp").get<number>("jlink.gdbPort") ?? 2331;

  const tick = async () => {
    const running = await isPortListening(port());
    if (running === lastGdbRunning) return;   // only redraw on change
    lastGdbRunning = running;
    updateStatusBar(running);
  };

  void tick();
  gdbWatch = setInterval(() => void tick(), 3000);
  context.subscriptions.push({ dispose: () => { if (gdbWatch) clearInterval(gdbWatch); } });
}

/**
 * Offer to free the probe.
 *
 * Stops our own server when we own it. Otherwise finds who holds the port —
 * and refuses to kill anything that is not a J-Link GDB server, because a
 * listening port proves something is there, not that it is ours.
 */
async function offerToFreeProbe() {
  const port = vscode.workspace.getConfiguration("jlinkMcp").get<number>("jlink.gdbPort") ?? 2331;

  if (gdbServer?.isRunning?.()) {
    const r = gdbServer.stop();
    vscode.window.showInformationMessage(r.message);
    lastGdbRunning = undefined;
    return;
  }

  const holders = await findGdbServerHolders(port);
  const ours = holders.filter((h) => h.isGdbServer);

  if (holders.length === 0) {
    vscode.window.showInformationMessage(`Nothing is listening on GDB port ${port}.`);
    return;
  }
  if (ours.length === 0) {
    // Say who it is and stop. Being in the way is not grounds for a kill.
    vscode.window.showWarningMessage(
      `Port ${port} is held by something that is not a J-Link GDB server ` +
      `(pid ${holders[0].pid}: ${holders[0].commandLine.slice(0, 80)}). Leaving it alone.`);
    return;
  }

  const pick = await vscode.window.showWarningMessage(
    `A J-Link GDB server (pid ${ours.map((h) => h.pid).join(", ")}) is holding the probe. ` +
    `Stop it so other tools can use the probe?`,
    { modal: true }, "Stop it");
  if (pick !== "Stop it") return;

  for (const h of ours) {
    try { process.kill(h.pid, "SIGTERM"); } catch (e: any) {
      vscode.window.showErrorMessage(`Could not stop pid ${h.pid}: ${e?.message ?? e}`);
    }
  }
  lastGdbRunning = undefined;
  vscode.window.showInformationMessage("Stopped the GDB server; the probe is free.");
}

function updateStatusBar(gdbRunning: boolean) {
  if (!statusBarItem) return;
  if (gdbRunning) {
    // Deliberately loud. The failure this addresses is someone forgetting a
    // session is live and then losing an hour to a probe that will not
    // attach, so a quiet colour change would not have helped them.
    statusBarItem.text = "$(debug) J-Link: GDB server running";
    statusBarItem.tooltip = "A GDB server is holding the probe. Click to stop it and free the probe for other tools.";
    statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    statusBarItem.command = "jlinkMcp.freeProbe";
  } else {
    statusBarItem.text = "$(debug-disconnect) J-Link";
    statusBarItem.tooltip = "J-Link MCP — no GDB server running. Click for status.";
    statusBarItem.backgroundColor = undefined;
    statusBarItem.command = "jlinkMcp.showStatus";
  }
}

export function deactivate() {
  log("J-Link MCP Extension deactivating...");
  rttClient?.disconnect();
  telnetProxy?.stop();
  processManager?.killAll();
  mcpServer?.dispose();
}
