import * as vscode from "vscode";

let outputChannel: vscode.OutputChannel | undefined;

export function initLogger(channel: vscode.OutputChannel): void {
  outputChannel = channel;
}

export function log(message: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}`;
  outputChannel?.appendLine(line);
}

export function logError(message: string, error?: unknown): void {
  const errMsg =
    error instanceof Error ? error.message : String(error ?? "");
  log(`ERROR: ${message}${errMsg ? ` - ${errMsg}` : ""}`);
}
