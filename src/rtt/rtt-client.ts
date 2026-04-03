import * as net from "net";
import { EventEmitter } from "events";
import { log, logError } from "../utils/logger";

/** Strip ANSI escape sequences from text */
function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "").replace(/\[0m/g, "");
}

/** Check if a line is SEGGER RTT header boilerplate */
function isRttHeader(line: string): boolean {
  return (
    line.startsWith("SEGGER J-Link") ||
    line.startsWith("Process: JLink") ||
    line.trim() === ""
  );
}

export interface ParsedLogLine {
  /** Device uptime timestamp like "00:03:09.516,100" */
  deviceTime: string | null;
  /** Log level: dbg, inf, wrn, err */
  level: string | null;
  /** Module name like "main", "inference_engine" */
  module: string | null;
  /** The actual log message */
  message: string;
  /** Original raw line */
  raw: string;
}

/** Parse a Zephyr-style log line: [HH:MM:SS.mmm,uuu] <level> module: message */
function parseZephyrLog(line: string): ParsedLogLine {
  const match = line.match(
    /^\[(\d{2}:\d{2}:\d{2}\.\d{3},?\d{0,3})\]\s*<(\w+)>\s*(\w[\w._-]*):\s*(.*)$/
  );
  if (match) {
    return {
      deviceTime: match[1],
      level: match[2],
      module: match[3],
      message: match[4],
      raw: line,
    };
  }
  return { deviceTime: null, level: null, module: null, message: line, raw: line };
}

export interface RTTMessage {
  channel: number;
  timestamp: Date;
  /** Raw data from the device */
  rawData: string;
  /** Cleaned lines (ANSI stripped, headers removed) */
  lines: ParsedLogLine[];
}

/**
 * Connects to RTT via telnet (when JLinkGDBServer is running).
 * JLinkGDBServer exposes RTT channel 0 on a configurable telnet port (default 19021).
 *
 * Automatically strips ANSI escape codes and SEGGER banners.
 * Parses Zephyr-style log lines into structured fields.
 */
export class RTTClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private host: string;
  private port: number;
  private messages: RTTMessage[] = [];
  /** Flat buffer of all parsed log lines for searching */
  private allLines: ParsedLogLine[] = [];
  private maxMessages = 5000;
  private maxLines = 20000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connected = false;
  private lineBuffer = "";

  constructor(host: string = "localhost", port: number = 19021) {
    super();
    this.host = host;
    this.port = port;
  }

  /** Connect to RTT telnet port */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.connected) {
        resolve();
        return;
      }

      this.socket = new net.Socket();

      this.socket.on("connect", () => {
        log(`RTT Client connected to ${this.host}:${this.port}`);
        this.connected = true;
        this.emit("connected");
        resolve();
      });

      this.socket.on("data", (data: Buffer) => {
        const raw = data.toString();
        // Clean and split into lines, handling partial lines
        const cleaned = stripAnsi(raw);
        this.lineBuffer += cleaned;
        const parts = this.lineBuffer.split("\n");
        // Last part might be incomplete
        this.lineBuffer = parts.pop() || "";

        const parsedLines: ParsedLogLine[] = [];
        for (const part of parts) {
          const trimmed = part.trim();
          if (!trimmed || isRttHeader(trimmed)) continue;
          parsedLines.push(parseZephyrLog(trimmed));
        }

        if (parsedLines.length > 0) {
          const msg: RTTMessage = {
            channel: 0,
            timestamp: new Date(),
            rawData: raw,
            lines: parsedLines,
          };
          this.messages.push(msg);
          if (this.messages.length > this.maxMessages) {
            this.messages.shift();
          }

          for (const line of parsedLines) {
            this.allLines.push(line);
          }
          while (this.allLines.length > this.maxLines) {
            this.allLines.shift();
          }

          this.emit("data", msg);
        }
      });

      this.socket.on("close", () => {
        log("RTT Client disconnected");
        this.connected = false;
        this.emit("disconnected");
      });

      this.socket.on("error", (err) => {
        logError("RTT Client error", err);
        this.connected = false;
        reject(err);
      });

      this.socket.connect(this.port, this.host);
    });
  }

  /** Disconnect */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
    this.lineBuffer = "";
  }

  /** Send data to RTT down-channel (host → device) */
  send(data: string): boolean {
    if (!this.socket || !this.connected) return false;
    this.socket.write(data);
    return true;
  }

  /** Get recent log lines as formatted text */
  getLines(count: number = 50): string[] {
    const lines = this.allLines.slice(-count);
    return lines.map((l) => {
      if (l.deviceTime && l.level && l.module) {
        return `[${l.deviceTime}] <${l.level}> ${l.module}: ${l.message}`;
      }
      return l.message;
    });
  }

  /** Search/filter log lines */
  search(opts: {
    level?: string;
    module?: string;
    pattern?: string;
    count?: number;
  }): ParsedLogLine[] {
    let results = [...this.allLines];

    if (opts.level) {
      const lvl = opts.level.toLowerCase();
      results = results.filter((l) => l.level?.toLowerCase() === lvl);
    }

    if (opts.module) {
      const mod = opts.module.toLowerCase();
      results = results.filter((l) => l.module?.toLowerCase().includes(mod));
    }

    if (opts.pattern) {
      try {
        const re = new RegExp(opts.pattern, "i");
        results = results.filter((l) => re.test(l.message) || re.test(l.raw));
      } catch {
        // fall back to simple string match
        const pat = opts.pattern.toLowerCase();
        results = results.filter(
          (l) => l.message.toLowerCase().includes(pat) || l.raw.toLowerCase().includes(pat)
        );
      }
    }

    if (opts.count) {
      results = results.slice(-opts.count);
    }

    return results;
  }

  /** Get messages (for backward compat / resource access) */
  getMessages(count?: number): RTTMessage[] {
    if (count) return this.messages.slice(-count);
    return [...this.messages];
  }

  /** Clear all buffers */
  clearBuffer(): void {
    this.messages = [];
    this.allLines = [];
    this.lineBuffer = "";
  }

  /** Check connection status */
  isConnected(): boolean {
    return this.connected;
  }

  /** Get buffer stats */
  getStats(): {
    connected: boolean;
    lineCount: number;
    messageCount: number;
    host: string;
    port: number;
  } {
    return {
      connected: this.connected,
      lineCount: this.allLines.length,
      messageCount: this.messages.length,
      host: this.host,
      port: this.port,
    };
  }
}
