import * as net from "net";
import { EventEmitter } from "events";
import { log, logError } from "../utils/logger";

/**
 * A TCP proxy server that sits between the RTT telnet port and external consumers
 * (like Trice or Pigweed detokenizer). It tees the data so both the MCP server
 * and external tools can consume the RTT stream simultaneously.
 *
 * Architecture:
 *   JLinkGDBServer:19021 (RTT) --> TelnetProxy:19400 --> multiple clients
 *                                                    --> internal buffer (for MCP)
 */
export class TelnetProxy extends EventEmitter {
  private server: net.Server | null = null;
  private sourceSocket: net.Socket | null = null;
  private clients = new Set<net.Socket>();
  private listenPort: number;
  private sourceHost: string;
  private sourcePort: number;
  private running = false;
  private dataBuffer: string[] = [];
  private maxBufferLines = 2000;

  constructor(
    listenPort: number = 19400,
    sourceHost: string = "localhost",
    sourcePort: number = 19021
  ) {
    super();
    this.listenPort = listenPort;
    this.sourceHost = sourceHost;
    this.sourcePort = sourcePort;
  }

  /** Start the proxy: connect to source and listen for clients */
  async start(): Promise<{ success: boolean; message: string }> {
    if (this.running) {
      return { success: true, message: `Telnet proxy already running on port ${this.listenPort}` };
    }

    try {
      // Connect to RTT source
      await this.connectToSource();

      // Start listening server
      await this.startServer();

      this.running = true;
      return {
        success: true,
        message: `Telnet proxy listening on port ${this.listenPort}, connected to ${this.sourceHost}:${this.sourcePort}`,
      };
    } catch (err) {
      logError("Failed to start telnet proxy", err);
      return {
        success: false,
        message: `Failed to start telnet proxy: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private connectToSource(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sourceSocket = new net.Socket();

      this.sourceSocket.on("connect", () => {
        log(`Telnet proxy connected to source ${this.sourceHost}:${this.sourcePort}`);
        resolve();
      });

      this.sourceSocket.on("data", (data: Buffer) => {
        const text = data.toString();

        // Buffer for MCP access
        const lines = text.split("\n");
        for (const line of lines) {
          if (line.trim()) {
            this.dataBuffer.push(line);
            if (this.dataBuffer.length > this.maxBufferLines) {
              this.dataBuffer.shift();
            }
          }
        }

        // Forward to all connected clients
        for (const client of this.clients) {
          try {
            client.write(data);
          } catch {
            this.clients.delete(client);
          }
        }

        this.emit("data", text);
      });

      this.sourceSocket.on("close", () => {
        log("Telnet proxy: source connection closed");
        this.emit("sourceDisconnected");
      });

      this.sourceSocket.on("error", (err) => {
        logError("Telnet proxy source error", err);
        reject(err);
      });

      this.sourceSocket.connect(this.sourcePort, this.sourceHost);
    });
  }

  private startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((client) => {
        log(`Telnet proxy: client connected from ${client.remoteAddress}:${client.remotePort}`);
        this.clients.add(client);

        client.on("close", () => {
          this.clients.delete(client);
          log("Telnet proxy: client disconnected");
        });

        client.on("error", () => {
          this.clients.delete(client);
        });

        // Forward client data to source (for down-channel)
        client.on("data", (data: Buffer) => {
          if (this.sourceSocket && !this.sourceSocket.destroyed) {
            this.sourceSocket.write(data);
          }
        });
      });

      this.server.on("error", (err) => {
        logError("Telnet proxy server error", err);
        reject(err);
      });

      this.server.listen(this.listenPort, "127.0.0.1", () => {
        log(`Telnet proxy server listening on port ${this.listenPort}`);
        resolve();
      });
    });
  }

  /** Stop the proxy */
  stop(): void {
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();

    if (this.sourceSocket) {
      this.sourceSocket.destroy();
      this.sourceSocket = null;
    }

    if (this.server) {
      this.server.close();
      this.server = null;
    }

    this.running = false;
    this.dataBuffer = [];
    log("Telnet proxy stopped");
  }

  /** Get buffered data */
  getBuffer(lines?: number): string[] {
    if (lines) return this.dataBuffer.slice(-lines);
    return [...this.dataBuffer];
  }

  /** Clear buffer */
  clearBuffer(): void {
    this.dataBuffer = [];
  }

  /** Write data to source (device) */
  writeToSource(data: string): boolean {
    if (this.sourceSocket && !this.sourceSocket.destroyed) {
      this.sourceSocket.write(data);
      return true;
    }
    return false;
  }

  /** Get proxy status */
  getStatus(): {
    running: boolean;
    listenPort: number;
    sourceConnected: boolean;
    clientCount: number;
    bufferedLines: number;
  } {
    return {
      running: this.running,
      listenPort: this.listenPort,
      sourceConnected: !!this.sourceSocket && !this.sourceSocket.destroyed,
      clientCount: this.clients.size,
      bufferedLines: this.dataBuffer.length,
    };
  }
}
