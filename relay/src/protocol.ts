/**
 * ClaudeBridge Relay Protocol
 *
 * Shared message types between relay, bot, and Android app.
 * All messages are JSON over WebSocket.
 */

// --- Client → Relay ---

/** Authenticate on connect. First message must be this. */
export interface AuthMessage {
  type: "auth";
  token: string;
  clientType: "bot" | "app";
}

/** Send a chat message to a channel (user → agent, or agent → user). */
export interface SendMessage {
  type: "send";
  channel: string;
  content: string;
}

/** Respond to a permission prompt. */
export interface PermissionResponse {
  type: "permission_response";
  channel: string;
  requestId: string;
  approved: boolean;
  message?: string; // denial reason or AskUserQuestion answer
}

/** Request message history for a channel. */
export interface HistoryRequest {
  type: "history";
  channel: string;
  limit?: number;
  before?: number; // timestamp
}

/** Bot registers/updates a channel (agent). */
export interface RegisterChannel {
  type: "register_channel";
  channel: string;
  name: string;
  agentStatus: "running" | "stopped" | "idle";
}

/** Bot sends a message with metadata (permission request, tool use, result). */
export interface BotMessage {
  type: "bot_message";
  channel: string;
  content: string;
  metadata?: MessageMetadata;
}

export type ClientMessage =
  | AuthMessage
  | SendMessage
  | PermissionResponse
  | HistoryRequest
  | RegisterChannel
  | BotMessage;

// --- Relay → Client ---

/** Auth result. */
export interface AuthResult {
  type: "auth_result";
  success: boolean;
  error?: string;
}

/** A message in a channel. */
export interface ChannelMessage {
  type: "message";
  id: number;
  channel: string;
  sender: "bot" | "user" | "system";
  content: string;
  timestamp: number;
  metadata?: MessageMetadata;
}

export interface MessageMetadata {
  /** For permission requests */
  permissionRequest?: {
    requestId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
  };
  /** For user questions from agent */
  userQuestion?: {
    requestId: string;
    questions: Array<{
      question: string;
      options: Array<{ label: string; description?: string }>;
    }>;
  };
  /** For result messages */
  result?: {
    success: boolean;
    costUsd?: number;
    durationMs?: number;
    numTurns?: number;
  };
  /** For tool-use notifications */
  toolUse?: {
    toolName: string;
    summary: string;
  };
  /** Whether this message needs user attention (permission, question) */
  needsAttention?: boolean;
}

/** List of available channels (sent after auth). */
export interface ChannelList {
  type: "channel_list";
  channels: Array<{
    id: string;
    name: string;
    agentStatus: "running" | "stopped" | "idle";
    unread: number;
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

/** Message history response. */
export interface HistoryResponse {
  type: "history_response";
  channel: string;
  messages: ChannelMessage[];
  hasMore: boolean;
}

/** Error from relay. */
export interface RelayError {
  type: "error";
  message: string;
}

export type RelayMessage =
  | AuthResult
  | ChannelMessage
  | ChannelList
  | ChannelUpdate
  | HistoryResponse
  | RelayError;
