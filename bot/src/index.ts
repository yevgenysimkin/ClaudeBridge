import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../.env") });

import { createServer } from "node:http";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { loadEnvConfig, loadAgentConfigs, AgentConfig } from "./config.js";
import { RelayClient } from "./relay-client.js";

const PROMPT_FILENAME = ".claude-bridge-prompt";
const HOOK_PORT = 9876;

// Pending permission responses: requestId → { resolve, channel }
const pendingPermissions = new Map<
  string,
  { resolve: (decision: { approved: boolean; message?: string }) => void; channel: string }
>();

// Agent configs indexed by channel ID
let agents: Map<string, AgentConfig>;

async function main(): Promise<void> {
  console.log("ClaudeBridge Watcher starting...");

  const envConfig = loadEnvConfig();
  const agentConfigs = loadAgentConfigs();
  agents = new Map(agentConfigs.map((a) => [a.id, a]));

  console.log(`[config] Relay: ${envConfig.relayUrl}`);
  console.log(`[config] Channels: ${agentConfigs.map((a) => a.id).join(", ") || "(none)"}`);

  // Connect to relay
  const relay = new RelayClient(envConfig.relayUrl, envConfig.relayAuthToken);

  relay.onMessage((msg) => {
    const type = msg.type as string;

    if (type === "message" && msg.sender === "user") {
      // User sent a message from phone → write to prompt file
      const channelId = msg.channel as string;
      const content = msg.content as string;
      const agent = agents.get(channelId);
      if (agent) {
        writePromptFile(agent.cwd, content);
        console.log(`[watcher] Wrote prompt to ${agent.cwd}/${PROMPT_FILENAME}`);
      }
    }

    if (type === "message" && msg.sender === "user") {
      // Check if this is a permission response (y/n)
      const content = (msg.content as string).trim().toLowerCase();
      const channelId = msg.channel as string;

      // Find any pending permission for this channel
      for (const [reqId, pending] of pendingPermissions) {
        if (pending.channel === channelId) {
          if (content === "y" || content === "yes") {
            pending.resolve({ approved: true });
          } else if (content === "n" || content === "no") {
            pending.resolve({ approved: false });
          } else {
            pending.resolve({ approved: false, message: content });
          }
          pendingPermissions.delete(reqId);
          break;
        }
      }
    }

    // Also handle explicit permission_response messages from the app's approve/deny buttons
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

  // Register channels
  for (const agent of agentConfigs) {
    relay.registerChannel(agent.id, agent.name, "idle");
  }

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
 * Write a prompt to the bridge prompt file in the given directory.
 */
function writePromptFile(cwd: string, content: string): void {
  const promptPath = resolve(cwd, PROMPT_FILENAME);
  // Ensure directory exists
  if (!existsSync(cwd)) {
    mkdirSync(cwd, { recursive: true });
  }
  writeFileSync(promptPath, content, "utf-8");
}

/**
 * Local HTTP server that hook scripts use to submit permission requests
 * and poll for responses. Keeps hooks simple (just curl).
 *
 * POST /permission  — hook submits a permission request
 *   Body: { channel, requestId, toolName, toolInput }
 *   Response: blocks until user responds, returns { approved, message? }
 *
 * The hook script does a single blocking curl and gets the answer.
 */
function startHookServer(relay: RelayClient): void {
  const server = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/permission") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const { channel, requestId, toolName, toolInput } = JSON.parse(body);

          // Forward to relay as a bot message with permission metadata
          relay.sendBotMessage(channel, `Permission request: ${toolName}`, {
            needsAttention: true,
            permissionRequest: { requestId, toolName, toolInput },
          });

          // Wait for response (with timeout)
          const decision = await new Promise<{ approved: boolean; message?: string }>(
            (resolveDecision) => {
              pendingPermissions.set(requestId, { resolve: resolveDecision, channel });

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
    } else if (req.method === "POST" && req.url === "/message") {
      // Claude Code sends a response to appear on the phone
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const { channel, content } = JSON.parse(body);
          relay.sendBotMessage(channel, content);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid request" }));
        }
      });
    } else if (req.method === "POST" && req.url === "/message") {
      // Claude Code sends a response to appear on the phone
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const { channel, content } = JSON.parse(body);
          relay.sendBotMessage(channel, content);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid request" }));
        }
      });
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  server.listen(HOOK_PORT, "127.0.0.1");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
