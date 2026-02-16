# ClaudeBridge

## What This Is
A bridge that lets you monitor and interact with Claude Code sessions from your phone. Send prompts, see responses, and approve permissions — all via a native Android app while away from your desk.

## Architecture

```
┌─────────────┐
│ Claude Code  │  ← thinks it's a normal TTY (isatty()=true)
└──────┬──────┘
       │ PTY (stdin/stdout)
┌──────┴──────┐
│  PTY Proxy   │  ← spawns Claude, multiplexes I/O
└──┬───────┬──┘
   │       │
   ▼       ▼
 Local    Relay (Railway)  ←→  Phone App
Terminal   claudebridge-production.up.railway.app
   │       │
   └───┬───┘
       │ input from either side
       ▼
  PTY stdin → Claude Code
```

- **PTY Proxy** wraps Claude Code in a pseudo-terminal — output goes to both local terminal and phone
- **Relay** runs on Railway — WebSocket server with in-memory ring buffers per channel
- **Android app** shows a terminal mirror — scrolling output, text input, approve/deny permissions
- Input from **either surface** (local keyboard or phone) goes to the same PTY stdin

## Repository & Infrastructure Map

| Component | Location | Runs On | Purpose |
|-----------|----------|---------|---------|
| Relay Server | `relay/` | Railway | WebSocket relay + per-channel ring buffers |
| PTY Proxy | `proxy/` | Laptop | Spawns Claude via node-pty, multiplexes I/O |
| Android App | `android/` | Phone | Kotlin/Compose — terminal mirror + permissions |

**Relay URL:** `claudebridge-production.up.railway.app`

## Key Files

- `relay/src/index.ts` — WebSocket server, HTTP health endpoint, pty_output/pty_input routing
- `relay/src/protocol.ts` — Shared protocol types (PtyOutput, PtyInput, BufferSync, etc.)
- `proxy/src/pty-proxy.ts` — Core PTY proxy: spawns Claude, mirrors I/O, sends to relay
- `proxy/src/relay-client.ts` — WebSocket client with auto-reconnect (logs to stderr)
- `proxy/src/ansi.ts` — ANSI stripping + permission prompt detection
- `proxy/src/config.ts` — Config loading from .env
- `android/app/src/main/java/com/claudebridge/` — Android app source

## How It Works

### Starting a session:
```bash
node /Users/yevgenysimkin/AfM/ClaudeBridge/proxy/dist/pty-proxy.js
```
This spawns `claude` (or `$CLAUDE_CMD`) inside a PTY and connects to the relay.

### I/O flow:
- **Claude output** → written to local stdout AND sent as `pty_output` to relay → phone
- **Local keyboard input** → written to PTY stdin (Claude sees it normally)
- **Phone text input** → sent as `pty_input` via relay → written to PTY stdin
- **Permission prompts** → detected via regex, phone shows Approve/Deny buttons
- **Phone approve** → sends `y\n` as `pty_input` → PTY stdin → Claude continues
- **Phone deny** → sends `n\n` as `pty_input`

### Reconnection:
- Relay keeps a 500-chunk ring buffer per channel
- When the phone app connects, relay sends `buffer_sync` with accumulated output
- Phone immediately has context of the current session

## Protocol Messages

| Type | Direction | Purpose |
|------|-----------|---------|
| `pty_output` | proxy → relay → app | Terminal output chunk |
| `pty_input` | app → relay → proxy | Keystrokes/text from phone |
| `buffer_sync` | relay → app | Full buffer on reconnect |
| `ping`/`pong` | relay ↔ clients | Connectivity verification |
| `auth` | client → relay | Authentication |
| `register_channel` | proxy → relay | Register a session |
| `channel_list` | relay → app | Active sessions |
| `channel_update` | relay → app | Status changes |

## Convention Notes

- **No magic values inline** — constants in companion objects (Android) or at file top (TS)
- **ESM + TypeScript strict mode** throughout proxy and relay
- PTY proxy logs to **stderr** (stdout is reserved for the PTY passthrough)
- Ring buffer size: 500 chunks (relay), 100K chars (Android BridgeState)
