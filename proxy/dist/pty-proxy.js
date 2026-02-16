import { config } from "dotenv";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { appendFileSync } from "node:fs";
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../.env") });
import * as pty from "node-pty";
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
function log(msg) {
    const ts = new Date().toISOString().slice(11, 19);
    appendFileSync(LOG_FILE, `${ts} [proxy] ${msg}\n`);
}
// --- Helpers ---
function resolveCommand(cmd) {
    if (cmd.startsWith("/"))
        return cmd;
    try {
        return execSync(`which ${cmd}`, { encoding: "utf8" }).trim();
    }
    catch {
        return cmd;
    }
}
// --- State ---
const ringBuffer = [];
const GENERIC_DIRS = new Set([
    "src", "bot", "app", "lib", "dist", "build", "test", "tests",
    "scripts", "config", "res", "main", "proxy",
]);
function deriveSessionName(cwd) {
    let dir = basename(cwd);
    if (GENERIC_DIRS.has(dir)) {
        dir = basename(dirname(cwd));
    }
    return dir || SESSION_ID.slice(0, 8);
}
// --- Main ---
async function main() {
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
    let proc = null;
    relay.onMessage((msg) => {
        if (msg.type === "pty_input" && msg.channel === SESSION_ID && proc) {
            const raw = msg.data;
            log(`Phone input: ${JSON.stringify(raw)}`);
            // Claude Code's TUI needs text and Enter as separate writes.
            const body = raw.replace(/\n$/, "");
            const hasNewline = raw.endsWith("\n");
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
    const authOk = await new Promise((resolveAuth) => {
        let elapsed = 0;
        const check = setInterval(() => {
            elapsed += 200;
            if (relay.isConnected) {
                clearInterval(check);
                resolveAuth(true);
            }
            else if (elapsed > 15_000) {
                clearInterval(check);
                resolveAuth(false);
            }
        }, 200);
    });
    if (authOk) {
        relay.registerChannel(SESSION_ID, sessionName, "running");
        log("Relay connected, channel registered.");
    }
    else {
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
        },
    });
    // --- Batched output relay ---
    // Claude Code outputs many small chunks rapidly (escape sequences, partial lines).
    // Batching reduces WebSocket message count from hundreds/sec to ~12/sec.
    let pendingOutput = "";
    let batchTimer = null;
    const RECENT_CHUNKS_FOR_DETECTION = 5;
    function flushOutput() {
        batchTimer = null;
        if (pendingOutput.length === 0)
            return;
        const data = pendingOutput;
        pendingOutput = "";
        // Check recent ring buffer for permission prompts
        const recentOutput = ringBuffer.slice(-RECENT_CHUNKS_FOR_DETECTION).join("");
        const permInfo = detectPermission(recentOutput);
        if (permInfo.detected) {
            log(`Interactive prompt detected: ${permInfo.options.length} options: ${permInfo.options.map(o => `${o.number}. ${o.label}`).join(", ") || "(binary)"}`);
        }
        relay.send({
            type: "pty_output",
            channel: SESSION_ID,
            data,
            timestamp: Date.now(),
            isPermission: permInfo.detected || undefined,
            permissionOptions: permInfo.options.length > 0 ? permInfo.options : undefined,
        });
    }
    proc.onData((data) => {
        // 1. Always write to local terminal immediately (no delay)
        process.stdout.write(data);
        // 2. Buffer for reconnecting clients
        ringBuffer.push(data);
        if (ringBuffer.length > RING_BUFFER_SIZE)
            ringBuffer.shift();
        // 3. Batch for relay (reduces WS message flood)
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
    process.stdin.on("data", (chunk) => {
        proc?.write(chunk);
    });
    // --- Handle terminal resize ---
    process.stdout.on("resize", () => {
        const newCols = process.stdout.columns || 120;
        const newRows = process.stdout.rows || 40;
        proc?.resize(newCols, newRows);
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
//# sourceMappingURL=pty-proxy.js.map