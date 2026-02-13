# ClaudeBridge

## What This Is
A bridge that connects multiple Claude Code (Agent SDK) sessions to a lightweight WebSocket relay. Monitor and interact with Claude agents — including permission approvals — from your phone via a native Android app.

## Architecture — Split Deployment

```
YOUR LAPTOP                              RAILWAY (always-on)
───────────────────                      ─────────────────────────
Claude Agent SDK sessions ──┐            ┌─────────────────────┐
  (edit local files)        ├──outbound──│  WebSocket Relay     │──▶ Android App
Bridge Bot (Node.js)  ──────┘            │  (always reachable)  │◀── Android App
                                         └─────────────────────┘
```

- **Relay** runs on Railway — lightweight WebSocket server with SQLite persistence
- **Bridge Bot** runs on your laptop — connects outbound to Railway relay
- **Agent SDK sessions** run locally with full filesystem access to your projects
- **Android app** connects to relay via WSS — foreground service keeps connection alive

## Repository & Infrastructure Map

| Component | Location | Runs On | Purpose |
|-----------|----------|---------|---------|
| Relay Server | `relay/` | Railway | WebSocket relay + SQLite message store |
| Bridge Bot | `bot/` | Laptop | Node.js — Agent SDK ↔ Relay routing |
| Android App | `android/` | Phone | Kotlin/Compose — monitoring + permission approvals |
| Agent configs | `bot/config/agents.json` | Laptop | Defines which agents to manage |

## Key Files

- `relay/src/index.ts` — WebSocket server, HTTP health endpoint, message routing
- `relay/src/protocol.ts` — Shared protocol types (relay, bot, Android all speak this)
- `relay/src/store.ts` — SQLite message persistence
- `bot/src/index.ts` — Entry point, wires RelayClient + AgentManager
- `bot/src/agent-session.ts` — Single agent: SDK query, canUseTool, event emitter
- `bot/src/agent-manager.ts` — Orchestration: lifecycle, relay↔SDK routing
- `bot/src/relay-client.ts` — WebSocket client with auto-reconnect
- `bot/src/config.ts` — Config loading + validation
- `bot/src/constants.ts` — All magic values (timeouts, limits, emoji, etc.)
- `android/app/src/main/java/com/claudebridge/` — Android app source

## Convention Notes

- **MVC**: AgentSession is the model (owns state + SDK interaction), Relay is the view (transport only), AgentManager is the controller (routes between them).
- **No magic values inline** — everything in `constants.ts` (bot) or companion objects (Android).
- **ESM + TypeScript strict mode** throughout bot and relay.
- **Agent SDK v1 API** — uses `query()` with `resume` for multi-turn, `canUseTool` callback for permissions.
- **Max plan auth** — SDK falls back to Claude Code CLI auth when no ANTHROPIC_API_KEY is set.

## In Agent Channels

- `y` / `yes` — Approve pending permission
- `n` / `no` — Deny pending permission
- Any other text — Deny with reason, answer agent question, or send message to agent
