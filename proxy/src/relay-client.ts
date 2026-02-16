import WebSocket from "ws";
import { appendFileSync } from "node:fs";

const RECONNECT_DELAY_MS = 3_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const PING_INTERVAL_MS = 25_000; // Keep connection alive through Railway's proxy

export type RelayMessageHandler = (msg: Record<string, unknown>) => void;

// --- File-based logging (stderr corrupts Claude Code's TUI) ---

const LOG_FILE = process.env.BRIDGE_LOG || "/tmp/claudebridge-proxy.log";

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  appendFileSync(LOG_FILE, `${ts} ${msg}\n`);
}

/**
 * WebSocket client that connects to the ClaudeBridge relay.
 * Handles auth, reconnection, and message routing.
 *
 * All logging goes to a file (not stderr) to avoid corrupting the PTY TUI.
 */
export class RelayClient {
  private ws: WebSocket | null = null;
  private relayUrl: string;
  private authToken: string;
  private handlers: RelayMessageHandler[] = [];
  private reconnectDelay = RECONNECT_DELAY_MS;
  private stopping = false;
  private authenticated = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(relayUrl: string, authToken: string) {
    // Convert http(s) to ws(s)
    this.relayUrl = relayUrl.replace(/^http/, "ws");
    this.authToken = authToken;
  }

  /** Connect to the relay and authenticate. */
  connect(): void {
    this.stopping = false;
    this.doConnect();
  }

  /** Register a handler for incoming relay messages. */
  onMessage(handler: RelayMessageHandler): void {
    this.handlers.push(handler);
  }

  /** Send a raw JSON message to the relay. */
  send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /** Register a channel with the relay. */
  registerChannel(channel: string, name: string, agentStatus: "running" | "stopped" | "idle"): void {
    this.send({ type: "register_channel", channel, name, agentStatus });
  }

  /** Whether the client is connected and authenticated. */
  get isConnected(): boolean {
    return this.authenticated && this.ws?.readyState === WebSocket.OPEN;
  }

  /** Disconnect and stop reconnecting. */
  stop(): void {
    this.stopping = true;
    this.cleanup();
  }

  // --- Private ---

  private cleanup(): void {
    this.stopPing();
    if (this.ws) {
      // Remove all listeners to prevent ghost events from old sockets
      this.ws.removeAllListeners();
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.authenticated = false;
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private doConnect(): void {
    if (this.stopping) return;

    // Clean up any previous connection before creating a new one
    this.cleanup();

    log(`Connecting to ${this.relayUrl}...`);
    this.ws = new WebSocket(this.relayUrl);

    this.ws.on("open", () => {
      log("Connected. Authenticating...");
      this.reconnectDelay = RECONNECT_DELAY_MS;
      this.ws!.send(JSON.stringify({
        type: "auth",
        token: this.authToken,
        clientType: "bot",
      }));
    });

    this.ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        log("Invalid JSON from relay.");
        return;
      }

      // Handle auth result
      if (msg.type === "auth_result") {
        if (msg.success) {
          this.authenticated = true;
          this.startPing();
          log("Authenticated.");
        } else {
          log(`Auth failed: ${msg.error}`);
          this.stopping = true;
          this.ws?.close();
        }
        return;
      }

      // Dispatch to handlers
      for (const handler of this.handlers) {
        handler(msg);
      }
    });

    this.ws.on("close", () => {
      this.authenticated = false;
      this.stopPing();
      if (!this.stopping) {
        log(`Disconnected. Reconnecting in ${this.reconnectDelay / 1000}s...`);
        setTimeout(() => this.doConnect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, MAX_RECONNECT_DELAY_MS);
      }
    });

    this.ws.on("error", (err) => {
      log(`Error: ${err.message}`);
    });
  }
}
