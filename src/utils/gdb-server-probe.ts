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


// ── What the status bar says ──────────────────────────────────────

export interface GdbStatus {
  running: boolean;
  /** True when this extension started it; false means somebody else did. */
  startedByExtension: boolean;
  /** How long we have known it was up, in ms. */
  elapsedMs: number;
  /**
   * False when it was already running the first time we looked, so the
   * elapsed time is a lower bound rather than an uptime.
   */
  observedStart: boolean;
  device?: string;
  gdbPort: number;
  rttListening?: boolean;
  rttPort?: number;
}

/** "47m", "2h 5m", "12s" — short enough for a status bar. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * Compose the bar text and its tooltip.
 *
 * Pure, so the wording is testable without a running VSCode. The text stays
 * short because VSCode truncates a long status bar item and people come to
 * resent it; everything else goes in the tooltip, which costs no screen space.
 *
 * The distinction the text is built around is who started the server. That is
 * the entire reported complaint in one word: a session you opened is a session
 * you remember, and one an assistant opened is the one that gets forgotten.
 */
export function renderGdbStatus(st: GdbStatus): { text: string; tooltip: string } {
  if (!st.running) {
    return {
      text: "$(debug-disconnect) J-Link",
      tooltip: "J-Link MCP — no GDB server running.\n\nThe probe is free. Click for status.",
    };
  }

  const who = st.startedByExtension ? "you" : "MCP";
  const elapsed = formatDuration(st.elapsedMs);

  const lines = [
    `**GDB server running** — started by ${st.startedByExtension ? "this extension" : "the MCP server (an assistant)"}.`,
    "",
    st.observedStart
      ? `Up ${elapsed}.`
      // Never claim an uptime we did not watch. If it was already running when
      // the extension woke up, all we honestly know is how long we have known.
      : `Known about for ${elapsed} — it was already running when the extension started, so it may be older.`,
    st.device ? `Device: \`${st.device}\`` : "Device: not configured",
    `GDB port: ${st.gdbPort}`,
  ];
  if (st.rttPort !== undefined) {
    lines.push(`RTT: ${st.rttListening ? `up on ${st.rttPort}` : "not listening"}`);
  }
  lines.push("", "A J-Link serves one client at a time, so this is holding the probe.", "Click to stop it and free the probe.");

  return { text: `$(debug) J-Link · ${who} · ${elapsed}`, tooltip: lines.join("\n") };
}
