import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { MessageStore } from "./store.js";
import type {
  ClientMessage,
  AuthMessage,
  RelayMessage,
  ChannelList,
  ChannelMessage,
  ModeChanged,
} from "./protocol.js";

// --- Config ---
const PORT = parseInt(process.env.PORT || "3000", 10);
const AUTH_TOKEN = process.env.RELAY_AUTH_TOKEN;
const DB_PATH = process.env.DB_PATH || "/data/relay.db";
const AUTH_TIMEOUT_MS = 10_000;

if (!AUTH_TOKEN) {
  console.error("FATAL: RELAY_AUTH_TOKEN is not set.");
  process.exit(1);
}

// --- State ---
const store = new MessageStore(DB_PATH);

interface Client {
  ws: WebSocket;
  clientType: "bot" | "app";
  authenticated: boolean;
}

const clients = new Set<Client>();

// Global mode: "phone" means permission requests go to the phone app,
// "desktop" (default) means normal terminal permission prompts.
// Auto-resets to "desktop" when all app clients disconnect.
let currentMode: "phone" | "desktop" = "desktop";

const channelRegistry = new Map<string, {
  name: string;
  agentStatus: "running" | "stopped" | "idle";
  pendingPermission: boolean;
}>();

channelRegistry.set("ops", { name: "Ops", agentStatus: "idle", pendingPermission: false });

// --- HTTP server ---
const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      mode: currentMode,
      clients: clients.size,
      channels: channelRegistry.size,
    }));
    return;
  }
  res.writeHead(404);
  res.end("Not found");
});

// --- WebSocket server ---
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  const client: Client = { ws, clientType: "app", authenticated: false };
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
      case "send":
        handleSend(client, msg.channel, msg.content);
        break;
      case "bot_message":
        handleBotMessage(client, msg.channel, msg.content, msg.metadata);
        break;
      case "register_channel":
        handleRegisterChannel(msg.channel, msg.name, msg.agentStatus);
        break;
      case "permission_response":
        handlePermissionResponse(msg.channel, msg.requestId, msg.approved, msg.message);
        break;
      case "set_mode":
        handleSetMode(client, msg.mode);
        break;
      case "history":
        handleHistory(client, msg.channel, msg.limit, msg.before);
        break;
      default:
        send(ws, { type: "error", message: `Unknown message type.` });
    }
  });

  ws.on("close", () => {
    clients.delete(client);
    clearTimeout(authTimer);
    console.log(`[relay] ${client.clientType} disconnected. Clients: ${clients.size}`);

    // Auto-reset to desktop when all app clients disconnect
    if (client.clientType === "app" && client.authenticated) {
      const appClients = [...clients].filter(c => c.clientType === "app" && c.authenticated);
      if (appClients.length === 0 && currentMode === "phone") {
        currentMode = "desktop";
        console.log("[relay] All app clients disconnected — mode reset to desktop.");
        broadcastModeChanged();
      }
    }
  });

  ws.on("error", (err) => console.error("[relay] WS error:", err.message));
});

// --- Handlers ---

function handleAuth(client: Client, msg: AuthMessage): void {
  if (msg.token !== AUTH_TOKEN) {
    send(client.ws, { type: "auth_result", success: false, error: "Invalid token." });
    client.ws.close();
    return;
  }

  client.authenticated = true;
  client.clientType = msg.clientType;
  send(client.ws, { type: "auth_result", success: true });
  sendChannelList(client);
  console.log(`[relay] ${msg.clientType} authenticated. Clients: ${clients.size}`);
}

function handleSend(client: Client, channel: string, content: string): void {
  const sender = client.clientType === "bot" ? "bot" : "user";
  const stored = store.addMessage(channel, sender, content);
  broadcast(stored);
}

function handleBotMessage(
  client: Client,
  channel: string,
  content: string,
  metadata?: ChannelMessage["metadata"],
): void {
  if (client.clientType !== "bot") {
    send(client.ws, { type: "error", message: "Only bot clients can send bot_message." });
    return;
  }

  const stored = store.addMessage(channel, "bot", content, metadata);
  broadcast(stored);

  // Update pending permission flag if this is a permission request
  if (metadata?.needsAttention) {
    const info = channelRegistry.get(channel);
    if (info) {
      info.pendingPermission = true;
      broadcastChannelUpdate(channel);
    }
  }
}

function handleRegisterChannel(channel: string, name: string, agentStatus: "running" | "stopped" | "idle"): void {
  const existing = channelRegistry.get(channel);
  if (existing) {
    existing.name = name;
    existing.agentStatus = agentStatus;
  } else {
    channelRegistry.set(channel, { name, agentStatus, pendingPermission: false });
  }
  broadcastChannelList();
  console.log(`[relay] Channel registered: ${channel} (${name}) [${agentStatus}]`);
}

function handlePermissionResponse(
  channel: string,
  requestId: string,
  approved: boolean,
  message?: string,
): void {
  // Store the user's response as a message
  const content = approved ? "✅ Approved" : `❌ Denied${message ? `: ${message}` : ""}`;
  const stored = store.addMessage(channel, "user", content);
  broadcast(stored);

  // Forward the structured response to all bot clients
  const response: RelayMessage = {
    type: "message",
    id: stored.id,
    channel,
    sender: "system",
    content: "",
    timestamp: stored.timestamp,
    metadata: {
      permissionRequest: { requestId, toolName: "", toolInput: {} },
      // The bot matches on requestId and the fact that it came from system sender
    },
  };
  broadcastToBots(response);

  // Clear pending flag
  const info = channelRegistry.get(channel);
  if (info) {
    info.pendingPermission = false;
    broadcastChannelUpdate(channel);
  }
}

function handleSetMode(client: Client, mode: "phone" | "desktop"): void {
  if (client.clientType !== "app") {
    send(client.ws, { type: "error", message: "Only app clients can set mode." });
    return;
  }
  if (currentMode === mode) return;

  currentMode = mode;
  console.log(`[relay] Mode set to: ${mode}`);
  broadcastModeChanged();
}

function handleHistory(client: Client, channel: string, limit?: number, before?: number): void {
  const result = store.getHistory(channel, limit, before);
  send(client.ws, {
    type: "history_response",
    channel,
    messages: result.messages,
    hasMore: result.hasMore,
  });
}

// --- Broadcasting ---

function broadcast(msg: RelayMessage): void {
  const json = JSON.stringify(msg);
  for (const c of clients) {
    if (c.authenticated && c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(json);
    }
  }
}

function broadcastToBots(msg: RelayMessage): void {
  const json = JSON.stringify(msg);
  for (const c of clients) {
    if (c.authenticated && c.clientType === "bot" && c.ws.readyState === WebSocket.OPEN) {
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
    channels: [...channelRegistry.entries()].map(([id, info]) => ({
      id,
      name: info.name,
      agentStatus: info.agentStatus,
      unread: 0,
      pendingPermission: info.pendingPermission,
    })),
    mode: currentMode,
  };
  send(client.ws, list);
}

function broadcastChannelList(): void {
  for (const c of clients) {
    if (c.authenticated) sendChannelList(c);
  }
}

function broadcastModeChanged(): void {
  const msg: ModeChanged = { type: "mode_changed", mode: currentMode };
  broadcast(msg);
}

function broadcastChannelUpdate(channel: string): void {
  const info = channelRegistry.get(channel);
  if (!info) return;
  broadcast({
    type: "channel_update",
    channel,
    agentStatus: info.agentStatus,
    pendingPermission: info.pendingPermission,
  });
}

// --- Start ---
server.listen(PORT, () => {
  console.log(`[relay] ClaudeBridge Relay on port ${PORT}`);
  console.log(`[relay] DB: ${DB_PATH}`);
});

const shutdown = () => {
  console.log("[relay] Shutting down...");
  store.close();
  wss.close();
  server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
