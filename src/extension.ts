import * as vscode from "vscode";
import { JLinkMcpServer } from "./mcp/server";
import { GDBServerManager } from "./jlink/gdb-server";
import { RTTClient } from "./rtt/rtt-client";
import { TelnetProxy } from "./telnet/telnet-proxy";
import { ProcessManager } from "./utils/process-manager";
import { initLogger, log, logError } from "./utils/logger";
import { getConfig } from "./utils/config";

let mcpServer: JLinkMcpServer | undefined;
let processManager: ProcessManager | undefined;
let gdbServer: GDBServerManager | undefined;
let rttClient: RTTClient | undefined;
let telnetProxy: TelnetProxy | undefined;
let outputChannel: vscode.OutputChannel | undefined;
let rttOutputChannel: vscode.OutputChannel | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;

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

        // Build env vars from user's VSCode settings so the standalone
        // server gets the same config without needing VSCode APIs.
        const env: Record<string, string | number | null> = {};
        const device = cfg.get<string>("jlink.device");
        if (device && device !== "Unspecified") env["JLINK_DEVICE"] = device;
        const installDir = cfg.get<string>("jlink.installDir");
        if (installDir) env["JLINK_INSTALL_DIR"] = installDir;
        const iface = cfg.get<string>("jlink.interface");
        if (iface) env["JLINK_INTERFACE"] = iface;
        const speed = cfg.get<number>("jlink.speed");
        if (speed) env["JLINK_SPEED"] = speed;
        const serial = cfg.get<string>("jlink.serialNumber");
        if (serial) env["JLINK_SERIAL"] = serial;
        const gdbPort = cfg.get<number>("jlink.gdbPort");
        if (gdbPort) env["JLINK_GDB_PORT"] = gdbPort;
        const rttPort = cfg.get<number>("jlink.rttTelnetPort");
        if (rttPort) env["JLINK_RTT_PORT"] = rttPort;

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

function updateStatusBar(gdbRunning: boolean) {
  if (!statusBarItem) return;
  if (gdbRunning) {
    statusBarItem.text = "$(debug) J-Link Connected";
    statusBarItem.backgroundColor = undefined;
  } else {
    statusBarItem.text = "$(debug-disconnect) J-Link";
    statusBarItem.backgroundColor = undefined;
  }
}

export function deactivate() {
  log("J-Link MCP Extension deactivating...");
  rttClient?.disconnect();
  telnetProxy?.stop();
  processManager?.killAll();
  mcpServer?.dispose();
}
