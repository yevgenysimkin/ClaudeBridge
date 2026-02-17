import WebSocket from "ws";
import { appendFileSync } from "node:fs";
const RECONNECT_DELAY_MS = 3_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const PING_INTERVAL_MS = 25_000; // Keep connection alive through Railway's proxy
// --- File-based logging (stderr corrupts Claude Code's TUI) ---
const LOG_FILE = process.env.BRIDGE_LOG || "/tmp/claudebridge-proxy.log";
function log(msg) {
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
    ws = null;
    relayUrl;
    authToken;
    handlers = [];
    reconnectDelay = RECONNECT_DELAY_MS;
    stopping = false;
    authenticated = false;
    pingTimer = null;
    registeredChannel = null;
    constructor(relayUrl, authToken) {
        // Convert http(s) to ws(s)
        this.relayUrl = relayUrl.replace(/^http/, "ws");
        this.authToken = authToken;
    }
    /** Connect to the relay and authenticate. */
    connect() {
        this.stopping = false;
        this.doConnect();
    }
    /** Register a handler for incoming relay messages. */
    onMessage(handler) {
        this.handlers.push(handler);
    }
    /** Send a raw JSON message to the relay. */
    send(msg) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        }
    }
    /** Register a channel with the relay. Remembers registration for auto-re-register on reconnect. */
    registerChannel(channel, name, agentStatus) {
        this.registeredChannel = { channel, name, agentStatus };
        this.send({ type: "register_channel", channel, name, agentStatus });
    }
    /** Whether the client is connected and authenticated. */
    get isConnected() {
        return this.authenticated && this.ws?.readyState === WebSocket.OPEN;
    }
    /** Disconnect and stop reconnecting. */
    stop() {
        this.stopping = true;
        this.cleanup();
    }
    // --- Private ---
    cleanup() {
        this.stopPing();
        if (this.ws) {
            // Remove all listeners to prevent ghost events from old sockets
            this.ws.removeAllListeners();
            try {
                this.ws.close();
            }
            catch { /* ignore */ }
            this.ws = null;
        }
        this.authenticated = false;
    }
    startPing() {
        this.stopPing();
        this.pingTimer = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.ping();
            }
        }, PING_INTERVAL_MS);
    }
    stopPing() {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }
    doConnect() {
        if (this.stopping)
            return;
        // Clean up any previous connection before creating a new one
        this.cleanup();
        log(`Connecting to ${this.relayUrl}...`);
        this.ws = new WebSocket(this.relayUrl);
        this.ws.on("open", () => {
            log("Connected. Authenticating...");
            this.reconnectDelay = RECONNECT_DELAY_MS;
            this.ws.send(JSON.stringify({
                type: "auth",
                token: this.authToken,
                clientType: "bot",
            }));
        });
        this.ws.on("message", (raw) => {
            let msg;
            try {
                msg = JSON.parse(raw.toString());
            }
            catch {
                log("Invalid JSON from relay.");
                return;
            }
            // Handle auth result
            if (msg.type === "auth_result") {
                if (msg.success) {
                    this.authenticated = true;
                    this.startPing();
                    log("Authenticated.");
                    // Re-register channel if we had one (reconnect after relay restart)
                    if (this.registeredChannel) {
                        const { channel, name, agentStatus } = this.registeredChannel;
                        this.send({ type: "register_channel", channel, name, agentStatus });
                        log(`Re-registered channel: ${channel}`);
                    }
                }
                else {
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
//# sourceMappingURL=relay-client.js.map