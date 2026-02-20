/**
 * CLI Orchestrator — Headless Claude Code agent via `claude` subprocess.
 *
 * Spawns `claude` with --input-format stream-json / --output-format stream-json
 * to get structured JSONL over stdin/stdout. Uses the user's MAX plan auth
 * (no API key required). Both surfaces (Chromattica desktop, Android phone)
 * consume structured events — no ANSI, no PTY, no regex parsing.
 *
 * Usage:
 *   node dist/orchestrator.js [--prompt "initial prompt"] [--channel <id>] [--resume]
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RelayClient } from "./relay-client.js";
import { PermissionRouter } from "./permission-router.js";
import { loadEnvConfig } from "./config.js";

// --- Config ---

const LOG_FILE = process.env.BRIDGE_LOG || "/tmp/claudebridge-orchestrator.log";
const STREAM_BATCH_INTERVAL_MS = 80;
const CHANNEL_NAME = process.env.CHANNEL_NAME || "Claude Session";
const UPLOAD_DIR = join(tmpdir(), "claudebridge-uploads");

/** Matches FileAttachment from relay protocol.ts */
interface FileAttachment {
  filename: string;
  mimeType: string;
  data: string;  // base64
  sizeBytes: number;
}

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  appendFileSync(LOG_FILE, `${ts} [orch] ${msg}\n`);
}

// --- Session persistence ---

const SESSION_DIR = process.env.SESSION_DIR || join(process.env.HOME || "/tmp", ".claudebridge", "sessions");

function sessionFilePath(channel: string): string {
  return join(SESSION_DIR, `${channel}.json`);
}

function saveSession(channel: string, sessionId: string): void {
  mkdirSync(SESSION_DIR, { recursive: true });
  writeFileSync(sessionFilePath(channel), JSON.stringify({ channel, sessionId, savedAt: Date.now() }));
  log(`Session saved: ${sessionId} → ${sessionFilePath(channel)}`);
}

function loadSession(channel: string): string | null {
  const path = sessionFilePath(channel);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    log(`Session loaded: ${data.sessionId} from ${path}`);
    return data.sessionId;
  } catch {
    return null;
  }
}

// --- CLI args ---

function parseArgs(): { prompt?: string; channel?: string; resume?: boolean; cwd?: string } {
  const args = process.argv.slice(2);
  let prompt: string | undefined;
  let channel: string | undefined;
  let resume = false;
  let cwd: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--prompt" && args[i + 1]) {
      prompt = args[++i];
    } else if (args[i] === "--channel" && args[i + 1]) {
      channel = args[++i];
    } else if (args[i] === "--cwd" && args[i + 1]) {
      cwd = args[++i];
    } else if (args[i] === "--resume") {
      resume = true;
    } else if (!prompt && !args[i].startsWith("--")) {
      prompt = args[i];
    }
  }

  return { prompt, channel, resume, cwd };
}

// --- Streaming text batcher ---

class StreamBatcher {
  private buffer = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flush: (text: string) => void;

  constructor(flush: (text: string) => void) {
    this.flush = flush;
  }

  append(text: string): void {
    this.buffer += text;
    if (!this.timer) {
      this.timer = setTimeout(() => this.doFlush(), STREAM_BATCH_INTERVAL_MS);
    }
  }

  finalize(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer) {
      this.doFlush();
    }
  }

  private doFlush(): void {
    this.timer = null;
    const text = this.buffer;
    this.buffer = "";
    if (text) this.flush(text);
  }
}

// --- CLI JSONL message → relay agent_event mapper ---

function mapCliMessageToEvents(
  msg: Record<string, unknown>,
  channel: string,
  relay: RelayClient,
  batcher: StreamBatcher,
): void {
  const type = msg.type as string;

  switch (type) {
    // --- System init ---
    case "system": {
      if (msg.subtype === "init") {
        relay.sendAgentEvent(channel, "system", {
          sessionId: msg.session_id,
          model: msg.model,
          tools: msg.tools,
          cwd: msg.cwd,
          version: msg.claude_code_version,
          permissionMode: msg.permissionMode,
        });
      }
      break;
    }

    // --- Full assistant message (turn complete) ---
    case "assistant": {
      batcher.finalize();
      const message = msg.message as Record<string, unknown>;
      const content = message?.content as Array<Record<string, unknown>> | undefined;

      if (!content) break;

      for (const block of content) {
        if (block.type === "text") {
          relay.sendAgentEvent(channel, "assistant_text", {
            text: block.text,
          }, { isFinal: true });
        } else if (block.type === "thinking") {
          relay.sendAgentEvent(channel, "thinking", {
            thinking: block.thinking,
          });
        } else if (block.type === "tool_use") {
          relay.sendAgentEvent(channel, "tool_use", {
            toolName: block.name,
            toolUseId: block.id,
            input: summarizeToolInput(block.name as string, block.input as Record<string, unknown>),
          });
        } else if (block.type === "tool_result") {
          relay.sendAgentEvent(channel, "tool_result", {
            toolUseId: block.tool_use_id,
            isError: block.is_error ?? false,
            content: truncateContent(block.content),
          });
        }
      }
      break;
    }

    // --- Streaming partial (with --include-partial-messages) ---
    case "stream_event": {
      const evt = msg.event as Record<string, unknown>;
      if (!evt) break;

      const evtType = evt.type as string;

      if (evtType === "content_block_delta") {
        const delta = evt.delta as Record<string, unknown>;
        if (delta?.type === "text_delta" && delta.text) {
          batcher.append(delta.text as string);
        } else if (delta?.type === "thinking_delta" && delta.thinking) {
          relay.sendAgentEvent(channel, "thinking", {
            thinking: delta.thinking,
          }, { isFinal: false });
        }
      } else if (evtType === "content_block_start") {
        const block = evt.content_block as Record<string, unknown>;
        if (block?.type === "tool_use") {
          relay.sendAgentEvent(channel, "tool_use", {
            toolName: block.name,
            toolUseId: block.id,
            input: {},
          });
        }
      } else if (evtType === "content_block_stop") {
        batcher.finalize();
      }
      break;
    }

    // --- Turn result ---
    case "result": {
      batcher.finalize();
      const data: Record<string, unknown> = {
        subtype: msg.subtype,
        isError: msg.is_error,
        numTurns: msg.num_turns,
        totalCostUsd: msg.total_cost_usd,
        duration_ms: msg.duration_ms,
      };
      if (msg.subtype === "success") {
        data.result = msg.result;
        data.stopReason = msg.stop_reason;
      } else {
        data.errors = msg.errors;
      }
      if ((msg.permission_denials as unknown[])?.length) {
        data.permissionDenials = msg.permission_denials;
      }
      relay.sendAgentEvent(channel, "result", data, { isFinal: true });
      break;
    }

    // --- Tool progress ---
    case "tool_progress": {
      relay.sendAgentEvent(channel, "tool_result", {
        toolUseId: msg.tool_use_id,
        toolName: msg.tool_name,
        elapsedSeconds: msg.elapsed_time_seconds,
        isProgress: true,
      });
      break;
    }

    // --- Rate limit info (MAX plan) ---
    case "rate_limit_event": {
      const info = msg.rate_limit_info as Record<string, unknown>;
      if (info) {
        log(`Rate limit: status=${info.status}, resets=${info.resetsAt}`);
      }
      break;
    }

    // Feature 7: Permission events from CLI.
    // The `claude` CLI with --permission-mode default may emit permission request
    // messages as JSONL. If so, they'd appear here as an unknown type.
    // TODO: Test with `--permission-mode default` to determine if permission events
    // are emitted. If they are, wire them through PermissionRouter → relay → clients.
    // If not, --permission-mode plan (read-only) is the safest fallback, with
    // AskUserQuestion events still relayed for user interaction.

    default:
      // user echo, auth_status, etc. — silently skip
      break;
  }
}

// --- Helpers ---

function summarizeToolInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};

  if (toolName === "Bash") {
    summary.command = input.command;
    if (input.description) summary.description = input.description;
    return summary;
  }

  if (input.file_path) summary.file_path = input.file_path;
  if (input.pattern) summary.pattern = input.pattern;
  if (input.path) summary.path = input.path;
  if (input.url) summary.url = input.url;
  if (input.query) summary.query = input.query;

  for (const [key, value] of Object.entries(input)) {
    if (summary[key] !== undefined) continue;
    if (typeof value === "string" && value.length > 200) {
      summary[key] = value.slice(0, 200) + "…";
    } else {
      summary[key] = value;
    }
  }

  return summary;
}

function truncateContent(content: unknown): unknown {
  if (typeof content === "string") {
    return content.length > 500 ? content.slice(0, 500) + "…" : content;
  }
  if (Array.isArray(content)) {
    return content.map(truncateContent);
  }
  return content;
}

/** Write file attachments to disk and return their paths. */
function writeAttachments(channel: string, attachments: FileAttachment[]): string[] {
  const channelDir = join(UPLOAD_DIR, channel);
  mkdirSync(channelDir, { recursive: true });

  const paths: string[] = [];
  for (const att of attachments) {
    const safeName = att.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const filePath = join(channelDir, `${Date.now()}-${safeName}`);
    writeFileSync(filePath, Buffer.from(att.data, "base64"));
    paths.push(filePath);
    log(`Wrote attachment: ${filePath} (${att.sizeBytes} bytes)`);
  }
  return paths;
}

// --- Claude CLI subprocess ---

function spawnClaude(config: {
  model: string;
  permissionMode: string;
  cwd: string;
  sessionId?: string;
}): ChildProcess {
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model", config.model,
    "--permission-mode", config.permissionMode,
  ];

  if (config.sessionId) {
    args.push("--resume", config.sessionId);
  }

  log(`Spawning: claude ${args.join(" ")} (cwd: ${config.cwd})`);

  // Build clean env: unset CLAUDECODE to prevent nested-session detection.
  // If ANTHROPIC_API_KEY is in the env (user configured it), leave it —
  // they're choosing to use their API key. If absent, claude uses MAX auth ($0).
  const env = { ...process.env };
  delete env.CLAUDECODE;

  const child = spawn("claude", args, {
    cwd: config.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });

  return child;
}

/** Write a user message to the claude process stdin in stream-json input format. */
function sendPromptToProcess(child: ChildProcess, text: string): void {
  const msg = JSON.stringify({
    type: "user",
    message: { role: "user", content: text },
  });
  child.stdin?.write(msg + "\n");
}

// --- Main ---

async function main(): Promise<void> {
  const config = loadEnvConfig();
  const { prompt: initialPrompt, channel: channelArg, resume: shouldResume, cwd } = parseArgs();
  const channel = channelArg || randomUUID();
  const workingDir = cwd || process.cwd();

  log(`Starting orchestrator. Channel: ${channel}`);

  // --- Relay connection ---
  const relay = new RelayClient(config.relayUrl, config.relayAuthToken);
  relay.connect();

  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (relay.isConnected) {
        clearInterval(check);
        resolve();
      }
    }, 100);
  });

  log("Relay connected and authenticated.");
  relay.registerChannel(channel, CHANNEL_NAME, "running");

  // --- Permission router (for future permission event handling) ---
  const permissionRouter = new PermissionRouter(relay, channel);

  // --- Session resume ---
  const savedSessionId = shouldResume ? loadSession(channel) : null;
  if (shouldResume && !savedSessionId) {
    log("Resume requested but no saved session found — starting fresh.");
  }

  // --- Spawn claude subprocess ---
  const child = spawnClaude({
    model: config.model,
    permissionMode: config.permissionMode,
    cwd: workingDir,
    sessionId: savedSessionId || undefined,
  });

  // --- Stream batcher ---
  const batcher = new StreamBatcher((text) => {
    relay.sendAgentEvent(channel, "assistant_text", { text }, { isFinal: false });
  });

  // --- Parse stdout JSONL ---
  const rl: ReadlineInterface = createInterface({ input: child.stdout! });
  let sessionId: string | null = savedSessionId;

  rl.on("line", (line: string) => {
    if (!line.trim()) return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      log(`Invalid JSON from claude stdout: ${line.slice(0, 100)}`);
      return;
    }

    // Capture session ID from init
    if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
      sessionId = msg.session_id as string;
      saveSession(channel, sessionId);
      log(`Session initialized: ${sessionId}`);
    }

    // Log turn completion
    if (msg.type === "result") {
      log(`Turn complete. Cost: $${(msg.total_cost_usd as number)?.toFixed(4)}`);
    }

    mapCliMessageToEvents(msg, channel, relay, batcher);
  });

  // --- Log stderr (debug/errors) ---
  const stderrRl = createInterface({ input: child.stderr! });
  stderrRl.on("line", (line: string) => {
    log(`[stderr] ${line}`);
  });

  // --- Relay message handler ---
  relay.onMessage((msg) => {
    if (msg.type === "user_prompt" && msg.channel === channel) {
      const text = msg.text as string;
      const attachments = (msg as Record<string, unknown>).attachments as FileAttachment[] | undefined;

      if (attachments?.length) {
        // Write files to disk, then send prompt referencing file paths
        const paths = writeAttachments(channel, attachments);
        const fileList = paths.map(p => `- ${p}`).join("\n");
        const augmentedText = text
          ? `${text}\n\nAttached files:\n${fileList}`
          : `Please examine these files:\n${fileList}`;
        log(`User prompt with ${paths.length} attachment(s): ${augmentedText.slice(0, 120)}`);
        sendPromptToProcess(child, augmentedText);
      } else {
        log(`User prompt received: ${text.slice(0, 80)}`);
        sendPromptToProcess(child, text);
      }
    } else if (msg.type === "permission_response" && msg.channel === channel) {
      const requestId = msg.requestId as string;
      const behavior = msg.behavior as "allow" | "deny";
      log(`Permission response: ${requestId} → ${behavior}`);
      permissionRouter.handleResponse(requestId, behavior);
    } else if (msg.type === "interrupt_request" && (msg as Record<string, unknown>).channel === channel) {
      log("Interrupt request received — sending SIGINT to claude subprocess");
      child.kill("SIGINT");
    } else if (msg.type === "channel_update") {
      const update = msg as Record<string, unknown>;
      if (update.channel === channel && update.agentStatus === "removed") {
        log("Channel removed — sending SIGTERM to claude subprocess");
        child.kill("SIGTERM");
      }
    }
  });

  // --- Seed initial prompt ---
  if (initialPrompt) {
    sendPromptToProcess(child, initialPrompt);
  }

  // --- Wait for process exit ---
  const exitCode = await new Promise<number>((resolve) => {
    child.on("close", (code) => {
      resolve(code ?? 1);
    });
  });

  log(`Claude process exited with code ${exitCode}`);

  // --- Cleanup ---
  batcher.finalize();
  permissionRouter.cleanup();
  relay.sendAgentEvent(channel, "session_end", {
    reason: exitCode === 0 ? "completed" : "process_exit",
    exitCode,
  }, { isFinal: true });
  relay.stop();
  log("Orchestrator shut down.");
}

// --- Graceful shutdown ---

let shuttingDown = false;

function handleShutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Received ${signal}. Shutting down...`);
  process.exit(0);
}

process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
