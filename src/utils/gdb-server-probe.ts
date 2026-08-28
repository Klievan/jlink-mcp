import { exec } from "child_process";
import * as net from "net";

/**
 * Is a GDB server holding the probe, whoever started it?
 *
 * The extension cannot answer this by remembering what it did. An LLM driving
 * the MCP server starts the GDB server in a *different process* — the one
 * VSCode spawns for MCP — so the extension host never sees it happen. That is
 * the whole complaint this exists for: the probe is claimed, nothing in the
 * UI says so, and the next tool to want it fails in a way that looks like
 * broken hardware.
 *
 * So ask the machine rather than our own memory. A listening GDB port is the
 * observable fact, and it is true no matter who is responsible.
 */
export function isPortListening(port: number, host = "127.0.0.1", timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const settle = (v: boolean) => { socket.destroy(); resolve(v); };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

const run = (cmd: string): Promise<string> =>
  new Promise((resolve) => exec(cmd, { timeout: 5000 }, (err, stdout) => resolve(err ? "" : stdout)));

/** PIDs listening on a TCP port, excluding our own. */
export async function findListenerPids(port: number, self = process.pid): Promise<number[]> {
  const out = process.platform === "win32"
    ? await run(`netstat -ano -p TCP | findstr LISTENING | findstr :${port}`)
    : await run(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`);

  return parseListenerPids(out, self);
}

/**
 * Pull PIDs out of lsof or netstat output.
 *
 * Excluding our own PID is not defensive tidiness. lsof answers with whatever
 * holds the port, and during development that has already been this very
 * process — a kill built on "whatever owns the port" would happily take down
 * the extension host that asked the question.
 */
export function parseListenerPids(output: string, self: number): number[] {
  const pids = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    // lsof -t is a bare PID per line; netstat puts it in the last column.
    const m = t.match(/^(\d+)$/) ?? t.match(/(\d+)\s*$/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (Number.isFinite(pid) && pid > 0 && pid !== self) pids.add(pid);
  }
  return [...pids];
}

/** The command line for a PID, or "" if it cannot be read. */
export async function processCommandLine(pid: number): Promise<string> {
  if (process.platform === "win32") {
    const out = await run(`wmic process where processid=${pid} get commandline /value`);
    return (out.match(/CommandLine=(.*)/)?.[1] ?? "").trim();
  }
  return (await run(`ps -p ${pid} -o command=`)).trim();
}

/**
 * Does this command line belong to a J-Link GDB server?
 *
 * Checked before killing anything. A listening port is evidence that
 * *something* holds it, not that the something is ours — port 2331 could be
 * any process on the machine, and "it was in the way" is not a reason to end
 * it.
 */
export function looksLikeGdbServer(commandLine: string): boolean {
  return /JLinkGDBServer/i.test(commandLine);
}

export interface GdbServerHolder {
  pid: number;
  commandLine: string;
  /** False when something else holds the port — reported, never killed. */
  isGdbServer: boolean;
}

/** Who is holding the GDB port, and is it safe to offer to stop them? */
export async function findGdbServerHolders(port: number): Promise<GdbServerHolder[]> {
  const pids = await findListenerPids(port);
  const holders: GdbServerHolder[] = [];
  for (const pid of pids) {
    const commandLine = await processCommandLine(pid);
    holders.push({ pid, commandLine, isGdbServer: looksLikeGdbServer(commandLine) });
  }
  return holders;
}
