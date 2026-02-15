import { config } from "dotenv";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../.env") });

import { createServer } from "node:http";
import { writeFileSync, mkdirSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { loadEnvConfig } from "./config.js";
import { RelayClient } from "./relay-client.js";

const BRIDGE_DIR = resolve(process.env.HOME || "/tmp", ".claude/bridge");
const HOOK_PORT = 9876;
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// --- Global Mode ---
// Cached from relay. "desktop" = normal terminal permissions, "phone" = phone approves.
let cachedMode: "phone" | "desktop" = "desktop";

// --- Session Registry ---

interface Session {
  sessionId: string;
  cwd: string;
  name: string;
  registeredAt: number;
  lastSeen: number;
}

const sessions = new Map<string, Session>();

// Pending permission responses: requestId → { resolve, sessionId }
const pendingPermissions = new Map<
  string,
  { resolve: (decision: { approved: boolean; message?: string }) => void; sessionId: string }
>();

async function main(): Promise<void> {
  console.log("ClaudeBridge Watcher starting...");

  const envConfig = loadEnvConfig();
  console.log(`[config] Relay: ${envConfig.relayUrl}`);

  // Ensure bridge directory exists
  if (!existsSync(BRIDGE_DIR)) {
    mkdirSync(BRIDGE_DIR, { recursive: true });
  }

  // Connect to relay
  const relay = new RelayClient(envConfig.relayUrl, envConfig.relayAuthToken);

  relay.onMessage((msg) => {
    const type = msg.type as string;

    // Cache mode from relay
    if (type === "channel_list" && typeof msg.mode === "string") {
      cachedMode = msg.mode as "phone" | "desktop";
      console.log(`[watcher] Mode from relay: ${cachedMode}`);
    }
    if (type === "mode_changed" && typeof msg.mode === "string") {
      cachedMode = msg.mode as "phone" | "desktop";
      console.log(`[watcher] Mode changed: ${cachedMode}`);
    }

    if (type === "message" && msg.sender === "user") {
      const channelId = msg.channel as string;
      const content = (msg.content as string).trim();
      const session = sessions.get(channelId);

      if (!session) return;

      // Check if this is a permission response (y/n/yes/no)
      let handledAsPermission = false;
      const contentLower = content.toLowerCase();

      for (const [reqId, pending] of pendingPermissions) {
        if (pending.sessionId === channelId) {
          if (contentLower === "y" || contentLower === "yes") {
            pending.resolve({ approved: true });
          } else if (contentLower === "n" || contentLower === "no") {
            pending.resolve({ approved: false });
          } else {
            pending.resolve({ approved: false, message: content });
          }
          pendingPermissions.delete(reqId);
          handledAsPermission = true;
          break;
        }
      }

      // If not a permission response, write as a prompt
      if (!handledAsPermission) {
        writePromptFile(session.sessionId, content);
        console.log(`[watcher] Wrote prompt for session ${session.sessionId}`);
      }
    }

    // Handle explicit permission_response messages (from app's approve/deny buttons)
    if (type === "permission_response") {
      const reqId = msg.requestId as string;
      const pending = pendingPermissions.get(reqId);
      if (pending) {
        pending.resolve({
          approved: msg.approved as boolean,
          message: msg.message as string | undefined,
        });
        pendingPermissions.delete(reqId);
      }
    }
  });

  // Connect and wait for auth
  relay.connect();
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (relay.isConnected) {
        clearInterval(check);
        resolve();
      }
    }, 200);
  });

  // Clean up stale session directories on startup
  cleanupStaleSessions();

  // Start local HTTP server for hook scripts
  startHookServer(relay);

  console.log(`ClaudeBridge Watcher running. Hook server on port ${HOOK_PORT}.`);

  // Graceful shutdown
  const shutdown = () => {
    console.log("\nShutting down...");
    relay.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * Write a prompt to the session's prompt file.
 */
function writePromptFile(sessionId: string, content: string): void {
  const sessionDir = resolve(BRIDGE_DIR, sessionId);
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  writeFileSync(resolve(sessionDir, "prompt"), content, "utf-8");
}

/**
 * Derive a friendly display name from a cwd path.
 * e.g. "/Users/yevgenysimkin/AfM/ClaudeBridge" → "ClaudeBridge"
 */
function deriveSessionName(cwd: string, sessionId: string): string {
  const dir = basename(cwd);
  const shortId = sessionId.slice(0, 8);
  return dir ? `${dir} (${shortId})` : shortId;
}

/**
 * Local HTTP server for hook scripts and bridge.sh.
 *
 * GET  /mode        — returns current mode (phone/desktop)
 * POST /register    — hook registers a new session
 * POST /permission  — hook submits a permission request
 * POST /message     — bridge.sh sends a message to the phone
 */
function startHookServer(relay: RelayClient): void {
  const server = createServer(async (req, res) => {
    // --- GET /mode ---
    if (req.method === "GET" && req.url === "/mode") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ mode: cachedMode }));
      return;
    }

    // --- POST /register ---
    if (req.method === "POST" && req.url === "/register") {
      let body = "";
      req.on("data", (chunk: string) => (body += chunk));
      req.on("end", () => {
        try {
          const { sessionId, cwd } = JSON.parse(body);

          if (!sessionId) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "sessionId required" }));
            return;
          }

          // Create or update session
          const existing = sessions.get(sessionId);
          if (existing) {
            existing.lastSeen = Date.now();
            existing.cwd = cwd || existing.cwd;
          } else {
            const name = deriveSessionName(cwd || "", sessionId);
            const session: Session = {
              sessionId,
              cwd: cwd || "",
              name,
              registeredAt: Date.now(),
              lastSeen: Date.now(),
            };
            sessions.set(sessionId, session);

            // Register channel on relay
            relay.registerChannel(sessionId, name, "running");
            console.log(`[watcher] Session registered: ${sessionId} → ${name}`);
          }

          // Ensure session directory exists
          const sessionDir = resolve(BRIDGE_DIR, sessionId);
          if (!existsSync(sessionDir)) {
            mkdirSync(sessionDir, { recursive: true });
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid request" }));
        }
      });
      return;
    }

    // --- POST /permission ---
    if (req.method === "POST" && req.url === "/permission") {
      let body = "";
      req.on("data", (chunk: string) => (body += chunk));
      req.on("end", async () => {
        try {
          const { sessionId, requestId, toolName, toolInput, summary } = JSON.parse(body);

          // Auto-register if not yet known
          if (!sessions.has(sessionId)) {
            const name = `Session (${sessionId.slice(0, 8)})`;
            sessions.set(sessionId, {
              sessionId,
              cwd: "",
              name,
              registeredAt: Date.now(),
              lastSeen: Date.now(),
            });
            relay.registerChannel(sessionId, name, "running");
          }

          sessions.get(sessionId)!.lastSeen = Date.now();

          // Use summary if provided, otherwise fall back to tool name
          const displayText = summary || `Permission request: ${toolName}`;

          // Forward to relay as a bot message with permission metadata
          relay.sendBotMessage(sessionId, displayText, {
            needsAttention: true,
            permissionRequest: { requestId, toolName, toolInput },
          });

          // Wait for response (with timeout)
          const decision = await new Promise<{ approved: boolean; message?: string }>(
            (resolveDecision) => {
              pendingPermissions.set(requestId, { resolve: resolveDecision, sessionId });

              // 5 minute timeout
              setTimeout(() => {
                if (pendingPermissions.has(requestId)) {
                  pendingPermissions.delete(requestId);
                  resolveDecision({ approved: false, message: "Timed out waiting for response" });
                }
              }, 5 * 60 * 1000);
            }
          );

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(decision));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid request" }));
        }
      });
      return;
    }

    // --- POST /message ---
    if (req.method === "POST" && req.url === "/message") {
      let body = "";
      req.on("data", (chunk: string) => (body += chunk));
      req.on("end", () => {
        try {
          const { sessionId, content } = JSON.parse(body);

          if (!sessionId || !content) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "sessionId and content required" }));
            return;
          }

          // Auto-register if not yet known
          if (!sessions.has(sessionId)) {
            const name = `Session (${sessionId.slice(0, 8)})`;
            sessions.set(sessionId, {
              sessionId,
              cwd: "",
              name,
              registeredAt: Date.now(),
              lastSeen: Date.now(),
            });
            relay.registerChannel(sessionId, name, "running");
          }

          sessions.get(sessionId)!.lastSeen = Date.now();

          relay.sendBotMessage(sessionId, content);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid request" }));
        }
      });
      return;
    }

    // --- Fallback ---
    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(HOOK_PORT, "127.0.0.1");
}

/**
 * Remove session directories older than 24 hours.
 */
function cleanupStaleSessions(): void {
  if (!existsSync(BRIDGE_DIR)) return;
  const now = Date.now();
  let cleaned = 0;

  for (const entry of readdirSync(BRIDGE_DIR)) {
    // Skip non-directory entries and the "disabled" kill-switch file
    const entryPath = resolve(BRIDGE_DIR, entry);
    try {
      const stat = statSync(entryPath);
      if (!stat.isDirectory()) continue;
      if (now - stat.mtimeMs > SESSION_MAX_AGE_MS) {
        rmSync(entryPath, { recursive: true, force: true });
        cleaned++;
      }
    } catch {
      // Ignore errors on individual entries
    }
  }

  if (cleaned > 0) {
    console.log(`[watcher] Cleaned up ${cleaned} stale session(s).`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
