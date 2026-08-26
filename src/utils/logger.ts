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

/**
 * Log the raw, unparsed output of a probe or GDB command.
 *
 * Off unless JLINK_MCP_LOG_RAW=1, because it is verbose and only useful when
 * capturing fixtures. The hardware tier turns it on so the text the parsers
 * actually consume can be extracted from the run log and frozen as a golden
 * transcript.
 *
 * Without this the two tiers do not join up: the HIL suite can only capture
 * post-parse tool output, which is the wrong layer to replay through a parser.
 * The delimiters are what makes the blocks machine-extractable from an
 * otherwise interleaved log.
 */
export function logRaw(channel: string, command: string, output: string): void {
  if (process.env.JLINK_MCP_LOG_RAW !== "1") return;
  log(`<<<RAW ${channel} ${command}`);
  log(output);
  log(`RAW>>>`);
}
