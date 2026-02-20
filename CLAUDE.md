# ClaudeBridge

## What This Is
A bridge that lets you monitor and interact with Claude Code sessions from your phone or Chromattica desktop app. Send prompts, see responses, and approve permissions — all via structured SDK events relayed over WebSocket.

## Architecture

```
┌─────────────────────┐
│  Claude Agent SDK    │  ← headless, no terminal
└──────────┬──────────┘
           │ AsyncIterable<SDKMessage>
┌──────────┴──────────┐
│    Orchestrator      │  ← maps SDK events → agent_event, routes permissions
└──┬───────────────┬──┘
   │               │
   ▼               ▼
Chromattica      Relay (Railway)  ←→  Phone App
Desktop           claudebridge-production.up.railway.app
(CEF tabs)        │
   │              │
   └──────┬───────┘
          │ user_prompt / permission_response from either surface
          ▼
   PromptQueue → SDK query()
```

- **Orchestrator** uses `query()` from `@anthropic-ai/claude-agent-sdk` with an `AsyncIterable` prompt queue
- **Relay** runs on Railway — WebSocket server with in-memory ring buffers of structured events per channel
- **Chromattica desktop** renders sessions in CEF browser tabs with HTML pages consuming `agent_event` messages
- **Android app** shows structured message cards (text, tool use, thinking, permissions)
- Input from **either surface** (Chromattica or phone) feeds the same prompt queue via relay

## Repository & Infrastructure Map

| Component | Location | Runs On | Purpose |
|-----------|----------|---------|---------|
| Relay Server | `relay/` | Railway | WebSocket relay + per-channel event ring buffers |
| Orchestrator | `proxy/` | Laptop | Headless Claude agent via SDK, structured events to relay |
| Android App | `android/` | Phone | Kotlin/Compose — structured message cards + permissions |

**Relay URL:** `claudebridge-production.up.railway.app`

## Key Files

- `relay/src/index.ts` — WebSocket server, HTTP health endpoint, agent_event/user_prompt/permission_response routing
- `relay/src/protocol.ts` — Shared protocol types (AgentEvent, UserPrompt, PermissionResponse, HistorySync, etc.)
- `proxy/src/orchestrator.ts` — SDK orchestrator: query loop, event mapping, streaming batcher
- `proxy/src/permission-router.ts` — Routes canUseTool callbacks through relay, waits for responses
- `proxy/src/prompt-queue.ts` — AsyncIterable prompt delivery for SDK query()
- `proxy/src/relay-client.ts` — WebSocket client with auto-reconnect
- `proxy/src/config.ts` — Config loading from .env
- `android/app/src/main/java/com/claudebridge/` — Android app source

## How It Works

### Starting a session:
```bash
node /Users/yevgenysimkin/AfM/ClaudeBridge/proxy/dist/orchestrator.js --prompt "initial prompt"
```
Or launched from Chromattica via `ClaudeBridgeManager::startSession(projectDir)`.

### Event flow:
- **SDK messages** → mapped to `agent_event` envelopes → sent to relay → broadcast to all app clients
- **User prompts** → `user_prompt` from phone or Chromattica → relay → orchestrator's PromptQueue → SDK
- **Permission requests** → `permission_request` event → phone/desktop shows Allow/Deny → `permission_response` → relay → PermissionRouter resolves Promise
- **Streaming text** → batched at ~80ms intervals to avoid per-token WebSocket spam

### Reconnection:
- Relay keeps a 500-event ring buffer per channel
- When a client connects, relay sends `history_sync` with accumulated structured events
- Client immediately has full conversation context

## Protocol Messages

| Type | Direction | Purpose |
|------|-----------|---------|
| `agent_event` | orchestrator → relay → apps | Structured SDK event (text, tool_use, thinking, etc.) |
| `user_prompt` | app → relay → orchestrator | User sends a new message |
| `permission_response` | app → relay → orchestrator | User approves/denies a tool or answers a question |
| `history_sync` | relay → app | Full event history on reconnect |
| `ping`/`pong` | relay ↔ clients | Connectivity verification |
| `auth` | client → relay | Authentication |
| `register_channel` | orchestrator → relay | Register a session |
| `channel_list` | relay → app | Active sessions |
| `channel_update` | relay → app | Status changes |

## Convention Notes

- **No magic values inline** — constants in companion objects (Android) or at file top (TS)
- **ESM + TypeScript strict mode** throughout proxy and relay
- Orchestrator logs to file (`/tmp/claudebridge-orchestrator.log`), not stdout/stderr
- Ring buffer size: 500 events (relay), 500 messages per channel (Android BridgeState)
