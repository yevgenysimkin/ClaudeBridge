# ClaudeBridge

## What This Is
A bridge that lets you monitor and interact with Claude Code sessions from your phone. Send prompts, see responses, and approve permissions — all via a native Android app while away from your desk.

## Architecture

```
Terminal 1: Claude Code ──┐                         ┌─────────────┐
Terminal 2: Claude Code ──┼── hooks + bridge.sh ──→ │  Watcher     │
Terminal 3: Claude Code ──┘                         │  (Node.js)   │
                                                    └──────┬───────┘
                                                           │ WebSocket
                                                    ┌──────▼───────┐
                                                    │  Relay        │──▶ Android App
                                                    │  (Railway)    │◀── Android App
                                                    └──────────────┘
```

- **Relay** runs on Railway (`cb.pinewell.xyz`) — WebSocket server with SQLite persistence
- **Watcher** runs on your laptop — bridges Claude Code sessions to the relay
- **Claude Code sessions** use `bridge.sh` to send/receive and hooks for permissions
- **Android app** connects via WSS — foreground service for notifications

## Repository & Infrastructure Map

| Component | Location | Runs On | Purpose |
|-----------|----------|---------|---------|
| Relay Server | `relay/` | Railway | WebSocket relay + SQLite message store |
| Watcher | `bot/` | Laptop | Node.js — routes messages between sessions and relay |
| Hook scripts | `hooks/` | Laptop | Permission handling + message relay for Claude Code |
| Android App | `android/` | Phone | Kotlin/Compose — chat + permission approvals |
| Channel configs | `bot/config/agents.json` | Laptop | Maps channel IDs to project directories |

## Key Files

- `relay/src/index.ts` — WebSocket server, HTTP health endpoint, message routing
- `relay/src/protocol.ts` — Shared protocol types
- `relay/src/store.ts` — SQLite message persistence
- `bot/src/index.ts` — Watcher: relay client + local HTTP server for hooks
- `bot/src/relay-client.ts` — WebSocket client with auto-reconnect
- `bot/src/config.ts` — Config loading + validation
- `hooks/bridge.sh` — Script Claude Code calls to send messages / wait for prompts
- `hooks/bridge-hook.sh` — PreToolUse hook for remote permission approval
- `android/app/src/main/java/com/claudebridge/` — Android app source

## Remote Prompt System

### For each project that uses ClaudeBridge:

1. Set the channel env var (in project CLAUDE.md or shell):
   ```
   export CLAUDE_BRIDGE_CHANNEL="my-project"
   ```

2. Add the channel to `bot/config/agents.json`:
   ```json
   { "id": "my-project", "name": "My Project", "cwd": "/path/to/project" }
   ```

3. When Claude Code finishes a task and the user is away, it should run:
   ```bash
   /Users/yevgenysimkin/AfM/ClaudeBridge/hooks/bridge.sh send-and-wait "Done. Here's what I did: ..."
   ```
   This sends the response to the phone and blocks until the user sends a new prompt.

4. When the blocked command returns content, treat it as the next user instruction.

### How it works under the hood:
- `bridge.sh send "msg"` — POSTs to the local watcher, which forwards to relay → phone
- `bridge.sh wait` — uses `fswatch` to block until `.claude-bridge-prompt` file is written
- `bridge.sh send-and-wait "msg"` — both in one call
- Phone messages arrive at watcher via WebSocket, get written to `.claude-bridge-prompt`
- `fswatch` detects the change, `bridge.sh wait` returns the content

## Permission Hooks

The `PreToolUse` hook (`hooks/bridge-hook.sh`) intercepts permission prompts:
1. Claude Code asks to use a tool
2. Hook POSTs the request to the local watcher
3. Watcher forwards to relay → phone notification
4. User taps Approve/Deny on phone
5. Response flows back: phone → relay → watcher → hook → Claude Code continues

## Convention Notes

- **No magic values inline** — constants in companion objects (Android) or at file top (TS).
- **ESM + TypeScript strict mode** throughout bot and relay.
- File `.claude-bridge-prompt` is the prompt injection point — lives in each project's root.
- Watcher's local HTTP server runs on port 9876 (localhost only).
