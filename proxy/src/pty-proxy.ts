import { config } from "dotenv";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../.env") });

import * as pty from "node-pty";
import xtermHeadless from "@xterm/headless";
const { Terminal } = xtermHeadless;
import { loadEnvConfig } from "./config.js";
import { RelayClient } from "./relay-client.js";
import { detectPermission } from "./ansi.js";

// --- Configuration ---
const CLAUDE_CMD = resolveCommand(process.env.CLAUDE_CMD || "claude");
const RING_BUFFER_SIZE = 500;
const OUTPUT_BATCH_MS = 80; // Batch PTY output before relaying (reduces WS message flood)

// Session ID: use existing env var or generate one
const SESSION_ID = process.env.CLAUDE_SESSION_ID || `pty-${Date.now().toString(36)}`;

// --- Logging (file-based to avoid corrupting TUI) ---
const LOG_FILE = process.env.BRIDGE_LOG || "/tmp/claudebridge-proxy.log";

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  appendFileSync(LOG_FILE, `${ts} [proxy] ${msg}\n`);
}

// --- Helpers ---

function resolveCommand(cmd: string): string {
  if (cmd.startsWith("/")) return cmd;
  try {
    return execSync(`which ${cmd}`, { encoding: "utf8" }).trim();
  } catch {
    return cmd;
  }
}

// --- State ---
const ringBuffer: string[] = [];
let activePermOptionCount = 0; // Number of parsed options in the current multi-option prompt (0 = none)

const GENERIC_DIRS = new Set([
  "src", "bot", "app", "lib", "dist", "build", "test", "tests",
  "scripts", "config", "res", "main", "proxy",
]);

function deriveSessionName(cwd: string): string {
  let dir = basename(cwd);
  if (GENERIC_DIRS.has(dir)) {
    dir = basename(dirname(cwd));
  }
  return dir || SESSION_ID.slice(0, 8);
}

// --- Main ---
async function main(): Promise<void> {
  const envConfig = loadEnvConfig();
  const sessionName = deriveSessionName(process.cwd());

  // Startup banner goes to stderr (before Claude takes over the terminal)
  process.stderr.write(`[proxy] ClaudeBridge PTY Proxy — session: ${SESSION_ID}\n`);
  process.stderr.write(`[proxy] Logs: ${LOG_FILE}\n`);

  log(`Starting. Session: ${SESSION_ID} (${sessionName})`);
  log(`Relay: ${envConfig.relayUrl}`);
  log(`Command: ${CLAUDE_CMD} ${process.argv.slice(2).join(" ")}`);

  // --- Connect to relay ---
  const relay = new RelayClient(envConfig.relayUrl, envConfig.relayAuthToken);

  // This handler will be wired to `proc` after spawn — capture in closure
  let proc: pty.IPty | null = null;

  relay.onMessage((msg) => {
    if (msg.type === "pty_input" && msg.channel === SESSION_ID && proc) {
      const raw = msg.data as string;
      log(`Phone input: ${JSON.stringify(raw)}, activePermOptionCount=${activePermOptionCount}`);

      const body = raw.replace(/\n$/, "");
      const hasNewline = raw.endsWith("\n");

      // Check if this is free text during a multi-option TUI selection widget.
      // Arrow-key sequences (from selectOption) start with \x1b[ — let those through directly.
      // Anything else is free text that needs TUI navigation to "Type something" first.
      const isArrowNavigation = body.startsWith("\x1b[");

      if (activePermOptionCount > 0 && !isArrowNavigation && body.length > 0) {
        // Navigate to "Type something" (position = optionCount + 1), select it,
        // then type the text — each step needs a delay for the TUI to process.
        const ARROW_DOWN = "\x1b[B";
        const downArrows = ARROW_DOWN.repeat(activePermOptionCount);
        log(`TUI nav: sending ${activePermOptionCount} down-arrows, Enter, then text`);

        proc.write(downArrows);
        setTimeout(() => {
          proc?.write("\r"); // Enter to select "Type something"
          setTimeout(() => {
            if (body.length > 0) proc?.write(body);
            if (hasNewline) {
              setTimeout(() => proc?.write("\r"), 50);
            }
          }, 100); // Wait for text input mode to activate
        }, 50); // Wait for arrows to be processed

        activePermOptionCount = 0;
        return;
      }

      // Standard input: text + Enter as separate writes
      if (body.length > 0) {
        proc.write(body);
      }
      if (hasNewline) {
        setTimeout(() => proc?.write("\r"), 50);
      }
    }
  });

  relay.connect();

  // Wait for auth (with timeout)
  const authOk = await new Promise<boolean>((resolveAuth) => {
    let elapsed = 0;
    const check = setInterval(() => {
      elapsed += 200;
      if (relay.isConnected) {
        clearInterval(check);
        resolveAuth(true);
      } else if (elapsed > 15_000) {
        clearInterval(check);
        resolveAuth(false);
      }
    }, 200);
  });

  if (authOk) {
    relay.registerChannel(SESSION_ID, sessionName, "running");
    log("Relay connected, channel registered.");
  } else {
    log("WARNING: Relay auth timed out. Launching Claude without relay.");
    process.stderr.write("[proxy] WARNING: Relay not connected. Phone won't see output.\n");
  }

  // --- Spawn Claude Code in PTY ---
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 40;

  proc = pty.spawn(CLAUDE_CMD, process.argv.slice(2), {
    name: "xterm-256color",
    cols,
    rows,
    cwd: process.cwd(),
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    } as Record<string, string>,
  });

  // --- Virtual terminal for permission detection ---
  // Claude Code's TUI uses cursor positioning to paint the screen. Raw ANSI stripping
  // destroys the spatial layout, making regex detection unreliable. Instead, we feed
  // all output through a headless xterm that interprets cursor moves, then read the
  // rendered screen buffer as clean lines for detection.
  const vterm = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });

  /** Read the virtual terminal's visible screen as plain text lines. */
  function readScreen(): string {
    const buf = vterm.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line) {
        lines.push(line.translateToString(true));
      }
    }
    return lines.join("\n");
  }

  // --- Batched output relay ---
  // Claude Code outputs many small chunks rapidly (escape sequences, partial lines).
  // Batching reduces WebSocket message count from hundreds/sec to ~12/sec.
  let pendingOutput = "";
  let batchTimer: ReturnType<typeof setTimeout> | null = null;

  function flushOutput(): void {
    batchTimer = null;
    if (pendingOutput.length === 0) return;

    const data = pendingOutput;
    pendingOutput = "";

    // Read the rendered screen from the virtual terminal
    const screenText = readScreen();
    const permInfo = detectPermission(screenText, true);

    // Track multi-option prompt state for TUI navigation on phone input
    if (permInfo.detected && permInfo.options.length > 0) {
      activePermOptionCount = permInfo.options.length;
    } else if (!permInfo.detected) {
      activePermOptionCount = 0;
    }

    if (permInfo.detected) {
      log(`Interactive prompt detected: ${permInfo.options.length} options: ${
        permInfo.options.map(o => `${o.number}. ${o.label}`).join(", ") || "(binary)"
      }`);
      log(`--- SCREEN TEXT ---\n${screenText}\n--- END SCREEN ---`);
    }

    relay.send({
      type: "pty_output",
      channel: SESSION_ID,
      data,
      screenText,
      timestamp: Date.now(),
      isPermission: permInfo.detected || undefined,
      permissionOptions: permInfo.options.length > 0 ? permInfo.options : undefined,
    });
  }

  proc.onData((data: string) => {
    // 1. Always write to local terminal immediately (no delay)
    process.stdout.write(data);

    // 2. Feed virtual terminal (for permission detection)
    vterm.write(data);

    // 3. Buffer for reconnecting clients
    ringBuffer.push(data);
    if (ringBuffer.length > RING_BUFFER_SIZE) ringBuffer.shift();

    // 4. Batch for relay (reduces WS message flood)
    pendingOutput += data;
    if (!batchTimer) {
      batchTimer = setTimeout(flushOutput, OUTPUT_BATCH_MS);
    }
  });

  // --- Handle Claude Code exit ---
  proc.onExit(({ exitCode }) => {
    // Flush any pending output
    flushOutput();

    relay.send({
      type: "pty_output",
      channel: SESSION_ID,
      data: `\r\n[session ended: exit ${exitCode}]\r\n`,
      timestamp: Date.now(),
    });

    relay.registerChannel(SESSION_ID, sessionName, "stopped");
    log(`Claude exited with code ${exitCode}.`);

    setTimeout(() => {
      relay.stop();
      process.exit(exitCode || 0);
    }, 500);
  });

  // --- Local terminal: raw stdin passthrough ---
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    proc?.write(chunk);
  });

  // --- Handle terminal resize ---
  process.stdout.on("resize", () => {
    const newCols = process.stdout.columns || 120;
    const newRows = process.stdout.rows || 40;
    proc?.resize(newCols, newRows);
    vterm.resize(newCols, newRows);
  });

  // --- Graceful shutdown ---
  const shutdown = () => {
    proc?.kill();
    relay.stop();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => {
    // Forward Ctrl+C to the PTY instead of killing the proxy
    proc?.write("\x03");
  });
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  process.stderr.write(`[proxy] Fatal error: ${err}\n`);
  process.exit(1);
});
