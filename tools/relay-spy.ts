/**
 * ClaudeBridge Relay Spy — Development observer tool
 *
 * Connects to the relay as an "app" client and logs every message.
 * Useful for debugging, investigating CLI behavior (e.g., permission events),
 * and understanding message flow between orchestrator and clients.
 *
 * Usage:
 *   npx tsx tools/relay-spy.ts                     # uses config.json
 *   npx tsx tools/relay-spy.ts --url wss://...     # override relay URL
 *   npx tsx tools/relay-spy.ts --filter agent_event # only show agent_event in terminal
 *
 * All messages are always written to /tmp/relay-spy.log regardless of --filter.
 */

import WebSocket from "ws";
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// --- Config ---

const CONFIG_PATH = join(
  homedir(),
  "Library/Application Support/Chromattica/claudebridge/config.json"
);
const LOG_FILE = "/tmp/relay-spy.log";

// ANSI color codes
const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  bold: "\x1b[1m",
};

const TYPE_COLORS: Record<string, string> = {
  auth_result: C.cyan,
  channel_list: C.cyan,
  channel_update: C.cyan,
  agent_event: C.green,
  user_prompt: C.blue,
  permission_request: C.yellow,
  permission_response: C.yellow,
  interrupt_request: C.magenta,
  history_sync: C.dim,
  ping: C.dim,
  pong: C.dim,
  error: C.red,
};

// --- CLI args ---

function parseArgs(): { url?: string; token?: string; filter?: string } {
  const args = process.argv.slice(2);
  const result: { url?: string; token?: string; filter?: string } = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--url" && args[i + 1]) result.url = args[++i];
    else if (args[i] === "--token" && args[i + 1]) result.token = args[++i];
    else if (args[i] === "--filter" && args[i + 1]) result.filter = args[++i];
  }

  return result;
}

// --- Main ---

function main(): void {
  const cliArgs = parseArgs();

  // Load config
  let relayUrl = cliArgs.url || "";
  let authToken = cliArgs.token || "";

  if (!relayUrl || !authToken) {
    try {
      const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      if (!relayUrl) relayUrl = config.relayUrl || "";
      if (!authToken) authToken = config.relayAuthToken || "";
    } catch {
      // Config file not found — need CLI args
    }
  }

  if (!relayUrl || !authToken) {
    console.error(
      `${C.red}Error: No relay URL or auth token.${C.reset}\n` +
        `Provide --url and --token, or configure ${CONFIG_PATH}`
    );
    process.exit(1);
  }

  // Normalize URL
  const wsUrl = relayUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
  const filter = cliArgs.filter || null;

  // Clear log file
  writeFileSync(LOG_FILE, "");

  console.log(`${C.bold}ClaudeBridge Relay Spy${C.reset}`);
  console.log(`${C.dim}Relay:  ${wsUrl}${C.reset}`);
  console.log(`${C.dim}Log:    ${LOG_FILE}${C.reset}`);
  if (filter) console.log(`${C.dim}Filter: ${filter}${C.reset}`);
  console.log(`${C.dim}${"─".repeat(60)}${C.reset}\n`);

  let messageCount = 0;

  const ws = new WebSocket(wsUrl);

  ws.on("open", () => {
    console.log(`${C.green}Connected. Authenticating...${C.reset}`);
    ws.send(
      JSON.stringify({
        type: "auth",
        token: authToken,
        clientType: "app",
      })
    );
  });

  ws.on("message", (raw) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      console.log(`${C.red}[Invalid JSON]${C.reset} ${raw.toString().slice(0, 100)}`);
      return;
    }

    messageCount++;
    const ts = new Date().toISOString().slice(11, 23);
    const type = (msg.type as string) || "unknown";

    // Always write to log file (unfiltered)
    const logLine = JSON.stringify({ _ts: new Date().toISOString(), ...msg });
    appendFileSync(LOG_FILE, logLine + "\n");

    // Terminal output (filtered)
    if (filter && type !== filter) return;

    const color = TYPE_COLORS[type] || C.white;
    const num = String(messageCount).padStart(4, " ");

    // Build summary based on message type
    let summary = "";
    switch (type) {
      case "auth_result":
        summary = msg.success ? "✓ authenticated" : `✗ ${msg.error || "failed"}`;
        break;
      case "channel_list": {
        const channels = msg.channels as Array<Record<string, unknown>>;
        summary = `${channels?.length || 0} channel(s)`;
        if (channels?.length) {
          summary += ": " + channels.map((c) => `${c.name}[${c.agentStatus}]`).join(", ");
        }
        break;
      }
      case "channel_update":
        summary = `ch:${msg.channel} status:${msg.agentStatus || "?"} perm:${msg.pendingPermission ?? "?"}`;
        if (msg.name) summary += ` name:"${msg.name}"`;
        break;
      case "agent_event":
        summary = `ch:${msg.channel} kind:${msg.kind}`;
        if (msg.isFinal !== undefined) summary += ` final:${msg.isFinal}`;
        if (msg.requestId) summary += ` req:${msg.requestId}`;
        // Show data preview for certain kinds
        if (msg.kind === "assistant_text") {
          const data = msg.data as Record<string, unknown>;
          const text = (data?.text as string) || "";
          summary += ` "${text.slice(0, 60)}${text.length > 60 ? "…" : ""}"`;
        } else if (msg.kind === "tool_use") {
          const data = msg.data as Record<string, unknown>;
          summary += ` tool:${data?.toolName || "?"}`;
        } else if (msg.kind === "result") {
          const data = msg.data as Record<string, unknown>;
          summary += ` cost:$${Number(data?.totalCostUsd || 0).toFixed(4)} turns:${data?.numTurns || "?"}`;
        }
        break;
      case "user_prompt": {
        const text = (msg.text as string) || "";
        const atts = msg.attachments as unknown[];
        summary = `ch:${msg.channel} "${text.slice(0, 60)}${text.length > 60 ? "…" : ""}"`;
        if (atts?.length) summary += ` +${atts.length} file(s)`;
        break;
      }
      case "permission_response":
        summary = `ch:${msg.channel} req:${msg.requestId} → ${msg.behavior}`;
        break;
      case "interrupt_request":
        summary = `ch:${msg.channel}`;
        break;
      case "history_sync": {
        const events = msg.events as unknown[];
        summary = `ch:${msg.channel} ${events?.length || 0} events`;
        break;
      }
      case "ping":
      case "pong":
        summary = `id:${msg.pingId}`;
        break;
      case "error":
        summary = msg.message as string;
        break;
      default:
        summary = JSON.stringify(msg).slice(0, 80);
    }

    console.log(`${C.dim}${ts}${C.reset} ${C.dim}${num}${C.reset} ${color}${type.padEnd(20)}${C.reset} ${summary}`);
  });

  ws.on("close", (code, reason) => {
    console.log(`\n${C.yellow}Disconnected${C.reset} code:${code} reason:${reason?.toString() || "none"}`);
    console.log(`${C.dim}${messageCount} messages logged to ${LOG_FILE}${C.reset}`);
    process.exit(0);
  });

  ws.on("error", (err) => {
    console.error(`${C.red}WebSocket error:${C.reset} ${err.message}`);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log(`\n${C.dim}Shutting down... (${messageCount} messages logged)${C.reset}`);
    ws.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
