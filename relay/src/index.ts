import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type {
  ClientMessage,
  AuthMessage,
  RelayMessage,
  ChannelList,
  PtyOutput,
} from "./protocol.js";

// --- Config ---
const PORT = parseInt(process.env.PORT || "3000", 10);
const AUTH_TOKEN = process.env.RELAY_AUTH_TOKEN;
const AUTH_TIMEOUT_MS = 10_000;
const RING_BUFFER_SIZE = 500; // chunks per channel

if (!AUTH_TOKEN) {
  console.error("FATAL: RELAY_AUTH_TOKEN is not set.");
  process.exit(1);
}

// --- State ---

interface Client {
  ws: WebSocket;
  clientType: "bot" | "app";
  authenticated: boolean;
  ownedChannels: Set<string>;
}

const clients = new Set<Client>();

const channelRegistry = new Map<string, {
  name: string;
  agentStatus: "running" | "stopped" | "idle";
  pendingPermission: boolean;
}>();

// Per-channel ring buffer for reconnecting clients
const channelBuffers = new Map<string, string[]>();

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
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  const client: Client = { ws, clientType: "app", authenticated: false, ownedChannels: new Set() };
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
        handleRemoveChannel(msg.channel);
        break;
      case "pty_output":
        handlePtyOutput(client, msg);
        break;
      case "pty_input":
        handlePtyInput(client, msg.channel, msg.data);
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
        channelBuffers.delete(channel);
        console.log(`[relay] Auto-removed channel: ${channel} (bot disconnected)`);
      }
      broadcastChannelList();
    }

    console.log(`[relay] ${client.clientType} disconnected. Clients: ${clients.size}`);
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

  // Send buffer catch-up for all channels to reconnecting app clients
  if (client.clientType === "app") {
    for (const [channel, buffer] of channelBuffers) {
      if (buffer.length > 0) {
        send(client.ws, {
          type: "buffer_sync",
          channel,
          data: buffer.join(""),
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
    channelRegistry.set(channel, { name, agentStatus, pendingPermission: false });
  }
  // Initialize ring buffer if needed
  if (!channelBuffers.has(channel)) {
    channelBuffers.set(channel, []);
  }
  broadcastChannelList();
  console.log(`[relay] Channel registered: ${channel} (${name}) [${agentStatus}]`);
}

function handleRemoveChannel(channel: string): void {
  if (channelRegistry.delete(channel)) {
    channelBuffers.delete(channel);
    broadcastChannelList();
    console.log(`[relay] Channel removed: ${channel}`);
  }
}

function handlePtyOutput(client: Client, msg: PtyOutput): void {
  if (client.clientType !== "bot") {
    send(client.ws, { type: "error", message: "Only bot clients can send pty_output." });
    return;
  }

  // Append to ring buffer
  let buffer = channelBuffers.get(msg.channel);
  if (!buffer) {
    buffer = [];
    channelBuffers.set(msg.channel, buffer);
  }
  buffer.push(msg.data);
  if (buffer.length > RING_BUFFER_SIZE) {
    buffer.shift();
  }

  // Update pending permission flag
  if (msg.isPermission) {
    const info = channelRegistry.get(msg.channel);
    if (info && !info.pendingPermission) {
      info.pendingPermission = true;
      broadcastChannelUpdate(msg.channel);
    }
  }

  // Broadcast to app clients only (proxy already has the output locally)
  broadcastToApps(msg);
}

function handlePtyInput(client: Client, channel: string, data: string): void {
  // Forward input from app to bot (PTY proxy)
  const msg: RelayMessage = { type: "pty_input", channel, data };
  broadcastToBots(msg);

  // If this looks like a permission response, clear the pending flag
  // Recognizes: y/n/yes/no and digit strings (numbered option selection)
  const trimmed = data.trim().toLowerCase();
  if (trimmed === "y" || trimmed === "n" || trimmed === "yes" || trimmed === "no" || /^\d+$/.test(trimmed)) {
    const info = channelRegistry.get(channel);
    if (info && info.pendingPermission) {
      info.pendingPermission = false;
      broadcastChannelUpdate(channel);
    }
  }
}

function handlePing(_client: Client, pingId: string): void {
  const msg = JSON.stringify({ type: "ping", pingId });
  for (const c of clients) {
    if (c.authenticated && c.clientType === "app" && c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(msg);
    }
  }
}

function handlePong(_client: Client, pingId: string): void {
  const msg = JSON.stringify({ type: "pong", pingId });
  for (const c of clients) {
    if (c.authenticated && c.clientType === "bot" && c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(msg);
    }
  }
}

// --- Broadcasting ---

function broadcastToApps(msg: RelayMessage): void {
  const json = JSON.stringify(msg);
  for (const c of clients) {
    if (c.authenticated && c.clientType === "app" && c.ws.readyState === WebSocket.OPEN) {
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
      pendingPermission: info.pendingPermission,
    })),
  };
  send(client.ws, list);
}

function broadcastChannelList(): void {
  for (const c of clients) {
    if (c.authenticated) sendChannelList(c);
  }
}

function broadcastChannelUpdate(channel: string): void {
  const info = channelRegistry.get(channel);
  if (!info) return;
  const msg: RelayMessage = {
    type: "channel_update",
    channel,
    agentStatus: info.agentStatus,
    pendingPermission: info.pendingPermission,
  };
  broadcastToApps(msg);
  broadcastToBots(msg);
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
