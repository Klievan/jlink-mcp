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

  // Core services
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
