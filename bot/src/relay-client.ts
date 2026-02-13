import WebSocket from "ws";

const RECONNECT_DELAY_MS = 3_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

export type RelayMessageHandler = (msg: Record<string, unknown>) => void;

/**
 * WebSocket client that connects to the ClaudeBridge relay.
 * Handles auth, reconnection, and message routing.
 */
export class RelayClient {
  private ws: WebSocket | null = null;
  private relayUrl: string;
  private authToken: string;
  private handlers: RelayMessageHandler[] = [];
  private reconnectDelay = RECONNECT_DELAY_MS;
  private stopping = false;
  private authenticated = false;

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
    } else {
      console.warn("[relay-client] Cannot send — not connected.");
    }
  }

  /** Register a channel (agent) with the relay. */
  registerChannel(channel: string, name: string, agentStatus: "running" | "stopped" | "idle"): void {
    this.send({ type: "register_channel", channel, name, agentStatus });
  }

  /** Send a bot message with optional metadata. */
  sendBotMessage(channel: string, content: string, metadata?: Record<string, unknown>): void {
    this.send({ type: "bot_message", channel, content, metadata });
  }

  /** Send a plain text message. */
  sendText(channel: string, content: string): void {
    this.send({ type: "send", channel, content });
  }

  /** Whether the client is connected and authenticated. */
  get isConnected(): boolean {
    return this.authenticated && this.ws?.readyState === WebSocket.OPEN;
  }

  /** Disconnect and stop reconnecting. */
  stop(): void {
    this.stopping = true;
    this.ws?.close();
    this.ws = null;
  }

  // --- Private ---

  private doConnect(): void {
    if (this.stopping) return;

    console.log(`[relay-client] Connecting to ${this.relayUrl}...`);
    this.ws = new WebSocket(this.relayUrl);
    this.authenticated = false;

    this.ws.on("open", () => {
      console.log("[relay-client] Connected. Authenticating...");
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
        console.warn("[relay-client] Invalid JSON from relay.");
        return;
      }

      // Handle auth result
      if (msg.type === "auth_result") {
        if (msg.success) {
          this.authenticated = true;
          console.log("[relay-client] Authenticated.");
        } else {
          console.error("[relay-client] Auth failed:", msg.error);
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
      if (!this.stopping) {
        console.log(`[relay-client] Disconnected. Reconnecting in ${this.reconnectDelay / 1000}s...`);
        setTimeout(() => this.doConnect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, MAX_RECONNECT_DELAY_MS);
      }
    });

    this.ws.on("error", (err) => {
      console.error("[relay-client] Error:", err.message);
    });
  }
}
