/**
 * ClaudeBridge Relay Protocol
 *
 * Shared message types between orchestrator, relay, and clients
 * (Chromattica desktop app, Android phone app).
 * All messages are JSON over WebSocket.
 */

// --- Client → Relay ---

/** Authenticate on connect. First message must be this. */
export interface AuthMessage {
  type: "auth";
  token: string;
  clientType: "bot" | "app";
}

/** Bot (orchestrator) registers/updates a channel. */
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

/** Rename a channel (from phone or orchestrator). */
export interface RenameChannel {
  type: "rename_channel";
  channel: string;
  name: string;
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

// --- SDK Protocol: Client → Relay ---

/** Discriminated event kinds for agent_event messages. */
export type AgentEventKind =
  | "system"              // Session init (sessionId, model, tools, etc.)
  | "assistant_text"      // Text content (streaming delta or final block)
  | "tool_use"            // Claude wants to use a tool
  | "tool_result"         // Tool execution result
  | "permission_request"  // Waiting for user approval
  | "permission_resolved" // Permission answered
  | "thinking"            // Extended thinking block
  | "result"              // Turn complete (cost, usage, errors)
  | "session_end";        // Orchestrator shutting down

/**
 * Structured SDK event envelope.
 * Relay treats `data` as opaque JSON — stores and forwards without interpreting.
 */
export interface AgentEvent {
  type: "agent_event";
  channel: string;
  kind: AgentEventKind;
  /** Opaque event payload — shape depends on `kind`. */
  data: Record<string, unknown>;
  timestamp: number;
  /** For streaming text: false while tokens arrive, true on final block. */
  isFinal?: boolean;
  /** Unique ID for correlating requests/responses (e.g., permission flow). */
  requestId?: string;
}

/** Interrupt the currently running agent turn. */
export interface InterruptRequest {
  type: "interrupt_request";
  channel: string;
  timestamp: number;
}

/** File attachment sent with a user prompt. */
export interface FileAttachment {
  filename: string;
  mimeType: string;
  /** Base64-encoded file content. */
  data: string;
  sizeBytes: number;
}

/** App/desktop → relay → orchestrator: user sends a new message. */
export interface UserPrompt {
  type: "user_prompt";
  channel: string;
  text: string;
  timestamp: number;
  attachments?: FileAttachment[];
}

/**
 * App/desktop → relay → orchestrator: user approves/denies a permission
 * or answers an AskUserQuestion.
 */
export interface PermissionResponse {
  type: "permission_response";
  channel: string;
  requestId: string;
  /** "allow", "allowAlways", or "deny" for tool permissions. */
  behavior: "allow" | "allowAlways" | "deny";
  /** For AskUserQuestion: the user's answers keyed by question text. */
  answers?: Record<string, string>;
  timestamp: number;
}

// --- Control Protocol: directory browsing + remote session provocation ---

/**
 * App → bot: ask the desktop for a directory listing under its configured
 * Android-allowed project root. Used by the phone's "Start new session"
 * folder browser. The desktop validates the requested path against its
 * allowedRoot setting; out-of-root paths are rejected with an error.
 *
 * If `path` is absent or empty, the desktop lists the allowedRoot itself.
 */
export interface ListDirectory {
  type: "list_directory";
  /** Correlates response. App generates a fresh id per request. */
  requestId: string;
  path?: string;
  timestamp: number;
}

/** Single entry in a directory listing. */
export interface DirectoryEntry {
  name: string;
  isDir: boolean;
}

/**
 * Bot → app: directory listing response. If allowedRoot is empty, the desktop
 * has not configured a root and remote provocation is disabled — phone shows
 * a "configure in Chromattica settings" affordance.
 */
export interface DirectoryListing {
  type: "directory_listing";
  requestId: string;
  /** Resolved absolute path that was listed. */
  path: string;
  /** Empty string if the desktop has no allowed-root set. */
  allowedRoot: string;
  entries: DirectoryEntry[];
  /** Absent when `path` is the allowedRoot itself. */
  parent?: string;
  error?: string;
  timestamp: number;
}

/**
 * App → bot: provoke a new CB session. The desktop validates projectDir is
 * under allowedRoot before spawning. Silent spawn — the desktop window does
 * NOT raise; the user explicitly chose to start remotely.
 */
export interface RemoteStartSession {
  type: "remote_start_session";
  requestId: string;
  projectDir: string;
  model?: string;
  skipPermissions?: boolean;
  timestamp: number;
}

/**
 * Bot → app: confirmation of remote-start. On success the phone navigates
 * straight into the new session's xterm view via channelId.
 */
export interface RemoteSessionStarted {
  type: "remote_session_started";
  requestId: string;
  channelId?: string;
  error?: string;
  timestamp: number;
}

// --- PTY Protocol: Terminal byte streaming ---

/**
 * Bot → relay → apps: raw PTY output bytes for live xterm.js rendering.
 * Base64-encoded so binary-safe over JSON.
 * The relay keeps a rolling per-channel buffer of recent bytes (separate from
 * the structured agent_event history ring) and replays it to a reconnecting
 * client so it sees the recent terminal state instead of a blank xterm.
 */
export interface TermData {
  type: "term_data";
  channel: string;
  /** Base64-encoded raw PTY bytes (may include ANSI escape sequences). */
  data: string;
  timestamp: number;
}

/**
 * App → relay → bot: keystrokes typed in xterm.js, written into the PTY master fd.
 * Base64-encoded so control sequences (arrow keys, Ctrl-C, etc.) survive JSON.
 */
export interface TermInput {
  type: "term_input";
  channel: string;
  /** Base64-encoded raw keystroke bytes. */
  data: string;
  timestamp: number;
}

/**
 * App → relay → bot: xterm.js viewport resized; PTY needs TIOCSWINSZ ioctl.
 */
export interface TermResize {
  type: "term_resize";
  channel: string;
  cols: number;
  rows: number;
  timestamp: number;
}

export type ClientMessage =
  | AuthMessage
  | RegisterChannel
  | RemoveChannel
  | RenameChannel
  | InterruptRequest
  | AgentEvent
  | UserPrompt
  | PermissionResponse
  | TermData
  | TermInput
  | TermResize
  | ListDirectory
  | DirectoryListing
  | RemoteStartSession
  | RemoteSessionStarted
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
  agentStatus?: "running" | "stopped" | "idle" | "removed";
  pendingPermission?: boolean;
}

/** Error from relay. */
export interface RelayError {
  type: "error";
  message: string;
}

// --- SDK Protocol: Relay → Client ---

/** Full structured event history for reconnecting clients. */
export interface HistorySync {
  type: "history_sync";
  channel: string;
  events: AgentEvent[];
  timestamp: number;
}

export type RelayMessage =
  | AuthResult
  | ChannelList
  | ChannelUpdate
  | InterruptRequest
  | AgentEvent
  | UserPrompt
  | PermissionResponse
  | TermData
  | TermInput
  | TermResize
  | ListDirectory
  | DirectoryListing
  | RemoteStartSession
  | RemoteSessionStarted
  | HistorySync
  | Ping
  | Pong
  | RelayError;
