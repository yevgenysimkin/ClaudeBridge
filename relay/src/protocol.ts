/**
 * ClaudeBridge Relay Protocol
 *
 * Shared message types between PTY proxy, relay, and Android app.
 * All messages are JSON over WebSocket.
 */

// --- Client → Relay ---

/** Authenticate on connect. First message must be this. */
export interface AuthMessage {
  type: "auth";
  token: string;
  clientType: "bot" | "app";
}

/** Bot (PTY proxy) registers/updates a channel. */
export interface RegisterChannel {
  type: "register_channel";
  channel: string;
  name: string;
  agentStatus: "running" | "stopped" | "idle";
}

/** Remove a channel from the registry. */
export interface RemoveChannel {
  type: "remove_channel";
  channel: string;
}

/** Parsed permission option from a numbered Claude Code prompt. */
export interface PermissionOption {
  number: string;
  label: string;
}

/** PTY proxy → relay → app: terminal output chunk. */
export interface PtyOutput {
  type: "pty_output";
  channel: string;
  data: string;
  timestamp: number;
  isPermission?: boolean;
  permissionOptions?: PermissionOption[];
}

/** App → relay → PTY proxy: user input from phone. */
export interface PtyInput {
  type: "pty_input";
  channel: string;
  data: string;
}

/** Ping to verify app connectivity. */
export interface Ping {
  type: "ping";
  pingId: string;
}

/** Pong auto-response. */
export interface Pong {
  type: "pong";
  pingId: string;
}

export type ClientMessage =
  | AuthMessage
  | RegisterChannel
  | RemoveChannel
  | PtyOutput
  | PtyInput
  | Ping
  | Pong;

// --- Relay → Client ---

/** Auth result. */
export interface AuthResult {
  type: "auth_result";
  success: boolean;
  error?: string;
}

/** List of available channels (sent after auth). */
export interface ChannelList {
  type: "channel_list";
  channels: Array<{
    id: string;
    name: string;
    agentStatus: "running" | "stopped" | "idle";
    pendingPermission: boolean;
  }>;
}

/** Channel status update. */
export interface ChannelUpdate {
  type: "channel_update";
  channel: string;
  name?: string;
  agentStatus?: "running" | "stopped" | "idle";
  pendingPermission?: boolean;
}

/** Full buffer catch-up for reconnecting clients. */
export interface BufferSync {
  type: "buffer_sync";
  channel: string;
  data: string;
  timestamp: number;
}

/** Error from relay. */
export interface RelayError {
  type: "error";
  message: string;
}

export type RelayMessage =
  | AuthResult
  | ChannelList
  | ChannelUpdate
  | PtyOutput
  | PtyInput
  | BufferSync
  | Ping
  | Pong
  | RelayError;
