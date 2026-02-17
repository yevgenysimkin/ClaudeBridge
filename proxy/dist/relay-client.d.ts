export type RelayMessageHandler = (msg: Record<string, unknown>) => void;
/**
 * WebSocket client that connects to the ClaudeBridge relay.
 * Handles auth, reconnection, and message routing.
 *
 * All logging goes to a file (not stderr) to avoid corrupting the PTY TUI.
 */
export declare class RelayClient {
    private ws;
    private relayUrl;
    private authToken;
    private handlers;
    private reconnectDelay;
    private stopping;
    private authenticated;
    private pingTimer;
    private registeredChannel;
    constructor(relayUrl: string, authToken: string);
    /** Connect to the relay and authenticate. */
    connect(): void;
    /** Register a handler for incoming relay messages. */
    onMessage(handler: RelayMessageHandler): void;
    /** Send a raw JSON message to the relay. */
    send(msg: Record<string, unknown>): void;
    /** Register a channel with the relay. Remembers registration for auto-re-register on reconnect. */
    registerChannel(channel: string, name: string, agentStatus: "running" | "stopped" | "idle"): void;
    /** Whether the client is connected and authenticated. */
    get isConnected(): boolean;
    /** Disconnect and stop reconnecting. */
    stop(): void;
    private cleanup;
    private startPing;
    private stopPing;
    private doConnect;
}
//# sourceMappingURL=relay-client.d.ts.map