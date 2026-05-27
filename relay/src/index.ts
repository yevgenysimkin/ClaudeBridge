import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type {
  ClientMessage,
  AuthMessage,
  RelayMessage,
  ChannelList,
  RenameChannel,
  InterruptRequest,
  AgentEvent,
  UserPrompt,
  PermissionResponse,
  TermData,
  TermInput,
  TermResize,
  ListDirectory,
  DirectoryListing,
  RemoteStartSession,
  RemoteSessionStarted,
} from "./protocol.js";

// --- Config ---
const PORT = parseInt(process.env.PORT || "3000", 10);
const AUTH_TOKEN = process.env.RELAY_AUTH_TOKEN;  // if unset, see ALLOW_PAIRING below
// "Pairing mode" (AUTH_TOKEN unset) accepts any non-empty token and scopes
// channels by whatever token the client picks. Safe for solo / LAN use; a
// foot-gun on a public host because two strangers who pick the same token
// see each other's PTY streams. Refuse to boot in pairing mode unless the
// operator opts in via RELAY_ALLOW_PAIRING=1.
const ALLOW_PAIRING = process.env.RELAY_ALLOW_PAIRING === "1";
const AUTH_TIMEOUT_MS = 10_000;
const RING_BUFFER_SIZE = 500; // structured agent_events per channel
const TERM_BUFFER_MAX_BYTES = 64 * 1024; // raw PTY bytes retained per channel for replay
const MAX_PAYLOAD_BYTES = 20 * 1024 * 1024; // 20MB for file uploads
const BOT_DISCONNECT_GRACE_MS = 60_000; // 60s grace before cleaning up channels

if (!AUTH_TOKEN) {
  if (!ALLOW_PAIRING) {
    console.error(
      "[relay] FATAL: RELAY_AUTH_TOKEN is unset and RELAY_ALLOW_PAIRING is not '1'.\n" +
      "         Refusing to start without an auth strategy. Either:\n" +
      "           - set RELAY_AUTH_TOKEN to a shared secret (recommended; openssl rand -base64 32), or\n" +
      "           - set RELAY_ALLOW_PAIRING=1 to explicitly accept any non-empty token (solo use only)."
    );
    process.exit(1);
  }
  console.warn("[relay] RELAY_ALLOW_PAIRING=1 — pairing mode active. Any non-empty token will authenticate; channels are scoped per token. Safe only on a single-user / private host.");
}

// --- State ---

interface Client {
  ws: WebSocket;
  clientType: "bot" | "app";
  authenticated: boolean;
  token: string;             // auth token — scopes channel visibility
  ownedChannels: Set<string>;
}

const clients = new Set<Client>();

const channelRegistry = new Map<string, {
  name: string;
  agentStatus: "running" | "stopped" | "idle";
  pendingPermission: boolean;
  token: string;             // scopes this channel to its creator's token
}>();

// Per-channel structured event buffer for SDK orchestrator
const channelEvents = new Map<string, AgentEvent[]>();

// Per-channel rolling PTY byte buffer. Kept so apps that subscribe after a
// session has already started (e.g., desktop opening a session panel for a
// phone-initiated channel) still see the Claude banner / earliest output.
// Stored as the original term_data messages so replay is a straight resend.
const channelTermBuffers = new Map<string, { chunks: TermData[]; totalBytes: number }>();

// Approximate raw byte count of a base64 string without allocating a Buffer.
// Each 4 base64 chars decode to 3 bytes, minus padding.
function approxBase64DecodedBytes(b64: string): number {
  const len = b64.length;
  if (len === 0) return 0;
  let padding = 0;
  if (b64.charCodeAt(len - 1) === 61) padding++;
  if (b64.charCodeAt(len - 2) === 61) padding++;
  return Math.floor((len * 3) / 4) - padding;
}

// Grace timers: channel → timeout handle (bot disconnect → delayed cleanup)
const channelGraceTimers = new Map<string, ReturnType<typeof setTimeout>>();

// --- HTTP server ---
const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      clients: clients.size,
      channels: channelRegistry.size,
    }));
    return;
  }
  res.writeHead(404);
  res.end("Not found");
});

// --- WebSocket server ---
const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD_BYTES });

wss.on("connection", (ws) => {
  const client: Client = { ws, clientType: "app", authenticated: false, token: "", ownedChannels: new Set() };
  clients.add(client);

  const authTimer = setTimeout(() => {
    if (!client.authenticated) {
      send(ws, { type: "error", message: "Auth timeout." });
      ws.close();
    }
  }, AUTH_TIMEOUT_MS);

  ws.on("message", (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: "error", message: "Invalid JSON." });
      return;
    }

    if (!client.authenticated) {
      if (msg.type === "auth") {
        handleAuth(client, msg);
        clearTimeout(authTimer);
      } else {
        send(ws, { type: "error", message: "Must authenticate first." });
      }
      return;
    }

    switch (msg.type) {
      case "register_channel":
        handleRegisterChannel(client, msg.channel, msg.name, msg.agentStatus);
        break;
      case "remove_channel":
        handleRemoveChannel(client, msg.channel);
        break;
      case "rename_channel":
        handleRenameChannel(client, msg.channel, msg.name);
        break;
      case "interrupt_request":
        handleInterruptRequest(client, msg);
        break;
      case "agent_event":
        handleAgentEvent(client, msg);
        break;
      case "user_prompt":
        handleUserPrompt(client, msg);
        break;
      case "permission_response":
        handlePermissionResponse(client, msg);
        break;
      case "term_data":
        handleTermData(client, msg);
        break;
      case "term_input":
        handleTermInput(client, msg);
        break;
      case "term_resize":
        handleTermResize(client, msg);
        break;
      case "list_directory":
        handleListDirectory(client, msg);
        break;
      case "directory_listing":
        handleDirectoryListing(client, msg);
        break;
      case "remote_start_session":
        handleRemoteStartSession(client, msg);
        break;
      case "remote_session_started":
        handleRemoteSessionStarted(client, msg);
        break;
      case "ping":
        handlePing(client, msg.pingId);
        break;
      case "pong":
        handlePong(client, msg.pingId);
        break;
      default:
        send(ws, { type: "error", message: "Unknown message type." });
    }
  });

  ws.on("close", () => {
    clients.delete(client);
    clearTimeout(authTimer);

    // Bot disconnect: start grace timer instead of nuking channels immediately.
    // If the bot reconnects and re-registers before the timer fires, the
    // channel and its history survive intact.
    if (client.clientType === "bot" && client.ownedChannels.size > 0) {
      for (const channel of client.ownedChannels) {
        // Cancel any existing grace timer for this channel (e.g., rapid reconnect cycle)
        const existing = channelGraceTimers.get(channel);
        if (existing) clearTimeout(existing);

        const timer = setTimeout(() => {
          channelGraceTimers.delete(channel);
          // Only clean up if no bot has re-claimed this channel
          const info = channelRegistry.get(channel);
          if (!info) return;  // already removed by explicit remove_channel
          // Check if any connected bot now owns this channel
          let reclaimed = false;
          for (const c of clients) {
            if (c.authenticated && c.clientType === "bot" && c.ownedChannels.has(channel)) {
              reclaimed = true;
              break;
            }
          }
          if (!reclaimed) {
            channelRegistry.delete(channel);
            channelEvents.delete(channel);
            channelTermBuffers.delete(channel);
            console.log(`[relay] Grace period expired — removed channel: ${channel}`);
            broadcastChannelList(info.token);
          }
        }, BOT_DISCONNECT_GRACE_MS);

        channelGraceTimers.set(channel, timer);
        console.log(`[relay] Bot disconnected — grace timer started for channel: ${channel} (${BOT_DISCONNECT_GRACE_MS / 1000}s)`);
      }
    }

    console.log(`[relay] ${client.clientType} disconnected. Clients: ${clients.size}`);
  });

  ws.on("error", (err) => console.error("[relay] WS error:", err.message));
});

// --- Handlers ---

function handleAuth(client: Client, msg: AuthMessage): void {
  // If RELAY_AUTH_TOKEN is set, enforce exact match (locked mode).
  // If unset, accept any non-empty token (pairing mode — C generates the token).
  const tokenValid = AUTH_TOKEN
    ? msg.token === AUTH_TOKEN
    : msg.token && msg.token.length > 0;

  if (!tokenValid) {
    send(client.ws, { type: "auth_result", success: false, error: AUTH_TOKEN ? "Invalid token." : "Token required." });
    client.ws.close();
    return;
  }

  client.authenticated = true;
  client.clientType = msg.clientType;
  client.token = AUTH_TOKEN || msg.token;  // locked mode: normalize to the shared token
  send(client.ws, { type: "auth_result", success: true });
  sendChannelList(client);

  // Send structured event history for reconnecting app clients (token-scoped)
  if (client.clientType === "app") {
    for (const [channel, events] of channelEvents) {
      const info = channelRegistry.get(channel);
      if (events.length > 0 && info && info.token === client.token) {
        send(client.ws, {
          type: "history_sync",
          channel,
          events,
          timestamp: Date.now(),
        });
      }
    }

    // Replay buffered PTY bytes so late subscribers see the recent terminal
    // state (banner, prompt, last few interactions) instead of an empty xterm.
    for (const [channel, buffer] of channelTermBuffers) {
      const info = channelRegistry.get(channel);
      if (!info || info.token !== client.token) continue;
      for (const chunk of buffer.chunks) {
        send(client.ws, chunk);
      }
    }
  }

  console.log(`[relay] ${msg.clientType} authenticated. Clients: ${clients.size}`);
}

function handleRegisterChannel(client: Client, channel: string, name: string, agentStatus: "running" | "stopped" | "idle"): void {
  client.ownedChannels.add(channel);

  // Cancel grace timer if bot is reclaiming a channel after disconnect
  const graceTimer = channelGraceTimers.get(channel);
  if (graceTimer) {
    clearTimeout(graceTimer);
    channelGraceTimers.delete(channel);
    console.log(`[relay] Grace timer cancelled — bot reclaimed channel: ${channel}`);
  }

  const existing = channelRegistry.get(channel);
  if (existing) {
    existing.name = name;
    existing.agentStatus = agentStatus;
  } else {
    channelRegistry.set(channel, { name, agentStatus, pendingPermission: false, token: client.token });
  }
  if (!channelEvents.has(channel)) {
    channelEvents.set(channel, []);
  }
  broadcastChannelList(client.token);
  console.log(`[relay] Channel registered: ${channel} (${name}) [${agentStatus}]`);
}

function handleRemoveChannel(client: Client, channel: string): void {
  const info = channelRegistry.get(channel);
  if (!info || info.token !== client.token) return;  // token mismatch — ignore
  channelRegistry.delete(channel);
  channelEvents.delete(channel);
  channelTermBuffers.delete(channel);
  // Notify orchestrator so it can kill the subprocess
  broadcastToBots({ type: "channel_update", channel, agentStatus: "removed" }, client.token);
  broadcastChannelList(client.token);
  console.log(`[relay] Channel removed: ${channel}`);
}

function handleInterruptRequest(client: Client, msg: InterruptRequest): void {
  const info = channelRegistry.get(msg.channel);
  if (!info) {
    send(client.ws, { type: "error", message: `Channel not found: ${msg.channel}` });
    return;
  }
  if (info.token !== client.token) return;  // token mismatch — ignore
  broadcastToBots(msg, client.token);
  console.log(`[relay] Interrupt request for channel: ${msg.channel}`);
}

function handleRenameChannel(client: Client, channel: string, name: string): void {
  const info = channelRegistry.get(channel);
  if (!info || info.token !== client.token) return;  // token mismatch — ignore
  info.name = name;
  broadcastChannelUpdate(channel);
  console.log(`[relay] Channel renamed: ${channel} → ${name}`);
}

// --- SDK Protocol Handlers ---

function handleAgentEvent(client: Client, msg: AgentEvent): void {
  if (client.clientType !== "bot") {
    send(client.ws, { type: "error", message: "Only bot clients can send agent_event." });
    return;
  }

  const info = channelRegistry.get(msg.channel);
  if (info && info.token !== client.token) return;  // token mismatch — ignore

  // Append to structured event buffer
  let events = channelEvents.get(msg.channel);
  if (!events) {
    events = [];
    channelEvents.set(msg.channel, events);
  }
  events.push(msg);
  if (events.length > RING_BUFFER_SIZE) {
    events.shift();
  }

  // Broadcast to app clients with same token
  broadcastToApps(msg, client.token);
}

function handleUserPrompt(client: Client, msg: UserPrompt): void {
  // Forward to bot (orchestrator) and mirror to other app clients — scoped by token
  broadcastToBots(msg, client.token);
  // Echo to all app clients so every surface sees the user's message
  broadcastToApps({ ...msg, type: "user_prompt" }, client.token);
}

function handlePermissionResponse(client: Client, msg: PermissionResponse): void {
  // Forward permission response to bot (orchestrator) — scoped by token
  broadcastToBots(msg, client.token);
}

// --- PTY Protocol Handlers ---
// Terminal traffic is live and NOT added to the structured event history
// (channelEvents). It IS retained in a small rolling byte buffer
// (channelTermBuffers, ~64KB per channel) so a client that subscribes after a
// session has already started still sees the most recent PTY output — e.g.
// the desktop opening a session panel for a phone-initiated channel finds
// the Claude banner already drawn instead of an empty terminal.

function handleTermData(client: Client, msg: TermData): void {
  if (client.clientType !== "bot") {
    send(client.ws, { type: "error", message: "Only bot clients can send term_data." });
    return;
  }
  const info = channelRegistry.get(msg.channel);
  if (info && info.token !== client.token) return;
  broadcastToApps(msg, client.token);

  let buffer = channelTermBuffers.get(msg.channel);
  if (!buffer) {
    buffer = { chunks: [], totalBytes: 0 };
    channelTermBuffers.set(msg.channel, buffer);
  }
  buffer.chunks.push(msg);
  buffer.totalBytes += approxBase64DecodedBytes(msg.data);
  while (buffer.totalBytes > TERM_BUFFER_MAX_BYTES && buffer.chunks.length > 1) {
    const dropped = buffer.chunks.shift()!;
    buffer.totalBytes -= approxBase64DecodedBytes(dropped.data);
  }
}

function handleTermInput(client: Client, msg: TermInput): void {
  if (client.clientType !== "app") {
    send(client.ws, { type: "error", message: "Only app clients can send term_input." });
    return;
  }
  const info = channelRegistry.get(msg.channel);
  if (!info || info.token !== client.token) return;
  broadcastToBots(msg, client.token);
}

function handleTermResize(client: Client, msg: TermResize): void {
  if (client.clientType !== "app") {
    send(client.ws, { type: "error", message: "Only app clients can send term_resize." });
    return;
  }
  const info = channelRegistry.get(msg.channel);
  if (!info || info.token !== client.token) return;
  broadcastToBots(msg, client.token);
}

// --- Control Protocol Handlers ---
// These messages are channel-less: they go to/from the desktop's "control bot"
// which owns directory browsing and remote session creation. Token-scoped via
// client.token; the desktop validates path / project-dir against its
// configured Android-allowed root before acting on anything.

function handleListDirectory(client: Client, msg: ListDirectory): void {
  if (client.clientType !== "app") {
    send(client.ws, { type: "error", message: "Only app clients can send list_directory." });
    return;
  }
  broadcastToBots(msg, client.token);
}

function handleDirectoryListing(client: Client, msg: DirectoryListing): void {
  if (client.clientType !== "bot") {
    send(client.ws, { type: "error", message: "Only bot clients can send directory_listing." });
    return;
  }
  broadcastToApps(msg, client.token);
}

function handleRemoteStartSession(client: Client, msg: RemoteStartSession): void {
  if (client.clientType !== "app") {
    send(client.ws, { type: "error", message: "Only app clients can send remote_start_session." });
    return;
  }
  broadcastToBots(msg, client.token);
}

function handleRemoteSessionStarted(client: Client, msg: RemoteSessionStarted): void {
  if (client.clientType !== "bot") {
    send(client.ws, { type: "error", message: "Only bot clients can send remote_session_started." });
    return;
  }
  broadcastToApps(msg, client.token);
}

function handlePing(client: Client, pingId: string): void {
  const msg = JSON.stringify({ type: "ping", pingId });
  for (const c of clients) {
    if (c.authenticated && c.clientType === "app" && c.token === client.token && c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(msg);
    }
  }
}

function handlePong(client: Client, pingId: string): void {
  const msg = JSON.stringify({ type: "pong", pingId });
  for (const c of clients) {
    if (c.authenticated && c.clientType === "bot" && c.token === client.token && c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(msg);
    }
  }
}

// --- Broadcasting ---

function broadcastToApps(msg: RelayMessage, token?: string): void {
  const json = JSON.stringify(msg);
  for (const c of clients) {
    if (c.authenticated && c.clientType === "app" && c.ws.readyState === WebSocket.OPEN) {
      if (token && c.token !== token) continue;  // token mismatch — skip
      c.ws.send(json);
    }
  }
}

function broadcastToBots(msg: RelayMessage, token?: string): void {
  const json = JSON.stringify(msg);
  for (const c of clients) {
    if (c.authenticated && c.clientType === "bot" && c.ws.readyState === WebSocket.OPEN) {
      if (token && c.token !== token) continue;  // token mismatch — skip
      c.ws.send(json);
    }
  }
}

function send(ws: WebSocket, msg: RelayMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function sendChannelList(client: Client): void {
  const list: ChannelList = {
    type: "channel_list",
    channels: [...channelRegistry.entries()]
      .filter(([, info]) => info.token === client.token)
      .map(([id, info]) => ({
        id,
        name: info.name,
        agentStatus: info.agentStatus,
        pendingPermission: info.pendingPermission,
      })),
  };
  send(client.ws, list);
}

function broadcastChannelList(token?: string): void {
  for (const c of clients) {
    if (c.authenticated) {
      if (token && c.token !== token) continue;
      sendChannelList(c);
    }
  }
}

function broadcastChannelUpdate(channel: string): void {
  const info = channelRegistry.get(channel);
  if (!info) return;
  const msg: RelayMessage = {
    type: "channel_update",
    channel,
    name: info.name,
    agentStatus: info.agentStatus,
    pendingPermission: info.pendingPermission,
  };
  broadcastToApps(msg, info.token);
  broadcastToBots(msg, info.token);
}

// --- Start ---
server.listen(PORT, () => {
  console.log(`[relay] ClaudeBridge Relay on port ${PORT}`);
});

const shutdown = () => {
  console.log("[relay] Shutting down...");
  wss.close();
  server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
