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
} from "./protocol.js";

// --- Config ---
const PORT = parseInt(process.env.PORT || "3000", 10);
const AUTH_TOKEN = process.env.RELAY_AUTH_TOKEN;  // optional — if unset, any non-empty token is accepted
const AUTH_TIMEOUT_MS = 10_000;
const RING_BUFFER_SIZE = 500; // events per channel
const MAX_PAYLOAD_BYTES = 20 * 1024 * 1024; // 20MB for file uploads

if (!AUTH_TOKEN) {
  console.log("[relay] RELAY_AUTH_TOKEN not set — accepting any non-empty token (pairing mode).");
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

    // Auto-cleanup: remove channels owned by this bot
    if (client.clientType === "bot" && client.ownedChannels.size > 0) {
      for (const channel of client.ownedChannels) {
        channelRegistry.delete(channel);
        channelEvents.delete(channel);
        console.log(`[relay] Auto-removed channel: ${channel} (bot disconnected)`);
      }
      // Only notify clients with the same token
      broadcastChannelList(client.token);
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
  }

  console.log(`[relay] ${msg.clientType} authenticated. Clients: ${clients.size}`);
}

function handleRegisterChannel(client: Client, channel: string, name: string, agentStatus: "running" | "stopped" | "idle"): void {
  client.ownedChannels.add(channel);
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
