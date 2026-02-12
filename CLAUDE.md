# ClaudeBridge

## What This Is
A bridge that connects multiple Claude Code (Agent SDK) sessions to a Matrix/Element chat server. Monitor and interact with Claude agents — including permission approvals — from your phone or desktop via Element.

## Architecture — Split Deployment

```
YOUR LAPTOP                              RAILWAY (always-on)
───────────────────                      ─────────────────────────
Claude Agent SDK sessions ──┐            ┌─────────────────────┐
  (edit local files)        ├──outbound──│  Synapse (Matrix)    │──▶ Element (phone)
Bridge Bot (Node.js)  ──────┘            │  (always reachable)  │◀── Element (desktop)
                                         └─────────────────────┘
```

- **Synapse** runs on Railway — always reachable from phone/desktop via Element
- **Bridge Bot** runs on your laptop — connects *outbound* to Railway (no VPN, no port forwarding)
- **Agent SDK sessions** run on your laptop with local filesystem access
- If laptop sleeps, messages queue in Synapse. Bot reconnects and picks up on wake.

## Repository & Infrastructure Map

| Component | Location | Runs On | Purpose |
|-----------|----------|---------|---------|
| Synapse | `synapse/` (Dockerfile) | Railway | Matrix homeserver — always-on message relay |
| Bridge Bot | `bot/` | Laptop | Node.js — Agent SDK ↔ Matrix routing |
| Agent configs | `bot/config/agents.json` | Laptop | Defines which agents to manage |
| Local Docker | `docker-compose.yml` | Laptop | Local dev/testing only |

## Key Files

- `bot/src/index.ts` — Entry point, wires Matrix + AgentManager + commands
- `bot/src/agent-session.ts` — Single agent: SDK query, canUseTool, event emitter
- `bot/src/agent-manager.ts` — Orchestration: lifecycle, Matrix↔SDK routing
- `bot/src/matrix-client.ts` — Matrix client wrapper, room management
- `bot/src/commands.ts` — Ops room command parsing (!start, !stop, etc.)
- `bot/src/formatter.ts` — Matrix HTML formatting for all message types
- `bot/src/config.ts` — Config loading + validation
- `bot/src/constants.ts` — All magic values (timeouts, limits, emoji, etc.)

## Convention Notes

- **MVC**: AgentSession is the model (owns state + SDK interaction), Matrix is the view (display only), AgentManager is the controller (routes between them).
- **No magic values inline** — everything in `constants.ts`.
- **ESM + TypeScript strict mode** throughout.
- **Agent SDK v1 API** — uses `query()` with `resume` for multi-turn, `canUseTool` callback for permissions.

## Commands (in ops room)

```
!start <agent-id>    — Start an agent session
!stop <agent-id>     — Stop an agent session
!restart <agent-id>  — Restart (clear session + stop)
!status [agent-id]   — Show status of one or all agents
!agents              — List all configured agents
!cost [agent-id]     — Show cost for one or all agents
!approve-all         — Approve all pending permissions
!help                — Show this help
```

## In Agent Rooms

- `y` / `yes` — Approve pending permission
- `n` / `no` — Deny pending permission
- Any other text — Deny with reason, answer agent question, or send message to agent
