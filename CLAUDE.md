# ClaudeBridge

## What This Is
A bridge that lets you monitor and drive Claude Code sessions from your phone or the Chromattica desktop app. It pipes a **real interactive `claude` PTY** over a WebSocket relay, so clients render the actual `claude` TUI (colors, cursor, inline permission prompts) with xterm.js and type straight back into it.

This is the **v2 PTY architecture**. The earlier headless Agent-SDK / stream-JSON design is retired (it loses Claude MAX coverage after Anthropic's 2026-06-15 cutover; an interactive PTY stays covered). A legacy stream-JSON orchestrator still lives in `proxy/` but is superseded by the desktop PTY host.

## Architecture

```
┌──────────────────────────┐
│  real `claude` PTY        │  ← interactive TUI, spawned via forkpty
└────────────┬─────────────┘
             │ raw PTY bytes ↕
┌────────────┴─────────────┐
│   Host orchestrator       │  ← reads PTY master fd, frames term_data/_input/_resize
│   (Chromattica desktop,   │
│    or legacy Node proxy/) │
└──┬────────────────────┬──┘
   │   outbound WSS      │
   ▼                     ▼
 Relay (your own host) ←→ Android app (xterm.js WebView)
   │                     ↑
   └─── term_data ───────┘  Chromattica desktop also renders in CEF + xterm.js
```

- **Host orchestrator** spawns `claude` inside a real PTY (`forkpty`), reads the master fd, and frames bytes as `term_data`. Keystrokes arrive as `term_input` and are written to the fd; viewport changes arrive as `term_resize` → `TIOCSWINSZ`.
- **Relay** is a stateless WebSocket broker. In-memory only, no database. Connects clients by token-scoped channels.
- **Both clients** (Chromattica desktop CEF, Android WebView) render the same PTY byte stream with xterm.js.
- Permissions are answered **inline in the PTY** (the user sees and answers the `claude` TUI prompt directly) — there is no separate Approve/Deny card flow anymore.

## Repository & Infrastructure Map

| Component | Location | Runs On | Purpose |
|-----------|----------|---------|---------|
| Relay Server | `relay/` | Your own self-hosted box (anywhere) | WebSocket broker; auth, channel registry, control + PTY message routing |
| Node proxy | `proxy/` | Laptop | **Legacy** standalone stream-JSON orchestrator — superseded by the desktop PTY host |
| Android App | `android/` | Phone | Kotlin/Compose shell + xterm.js WebView session view |

The **primary host** is the Chromattica desktop app's built-in C++/forkpty orchestrator (lives in the Chromattica repo: `native/src/services/CbOrchestrator*.cpp`, `CbRelayClient.*`, `ClaudeBridgeManager*.cpp`), not the Node proxy.

**Relay:** bring-your-own — there is no shared or official relay. Host it on any always-on platform; it just needs to be reachable over `wss://`.

## Relay auth — pairing mode
The connection token is **auto-provisioned, never user-set**: the Chromattica desktop mints a random UUID, syncs it to chromattica-api, and the Android app pulls it at OTP login (no token input field in the app). Because the token is a per-install UUID, the relay must run in **pairing mode** (`RELAY_ALLOW_PAIRING=1`, `RELAY_AUTH_TOKEN` unset) — it accepts any non-empty token and scopes channels by it. Exact-match "locked" mode (`RELAY_AUTH_TOKEN` set) cannot work, since no UI feeds that shared secret to the clients.

## Key Files

- `relay/src/index.ts` — WebSocket server, HTTP health endpoint, auth, channel registry, message routing. Holds the per-channel structured-event ring buffer AND the rolling PTY byte buffer (both replayed to reconnecting clients).
- `relay/src/protocol.ts` — Shared protocol types (PTY: `term_data`/`term_input`/`term_resize`; control: `list_directory`/`remote_start_session`; legacy SDK: `agent_event`/`user_prompt`/`permission_response`/`history_sync`).
- `proxy/src/orchestrator.ts` — **Legacy** stream-JSON orchestrator (`--input-format stream-json`).
- `proxy/src/relay-client.ts` — WebSocket client with auto-reconnect.
- `proxy/src/config.ts` — Config from `.env` (`RELAY_URL`, `RELAY_AUTH_TOKEN`, `CLAUDE_MODEL`, `PERMISSION_MODE`).
- `android/app/src/main/assets/session.html` + `assets/vendor/xterm/` — the xterm.js session page and vendored xterm.js / addon-fit / xterm.css.
- `android/app/src/main/java/com/claudebridge/` — Android app source (Compose shell + `ui/screen/WebViewSessionScreen.kt` for the terminal).

## Buffering & reconnect
- Relay keeps a **500-event ring buffer** per channel for structured `agent_event`s (legacy/proxy path).
- Relay keeps a **rolling ~64 KB buffer** of recent raw PTY bytes per channel; on (re)connect it replays this so the client gets an immediate redraw rather than a blank xterm.
- Nothing is persisted — a relay restart drops all buffers.

## Protocol Messages

| Type | Direction | Purpose |
|------|-----------|---------|
| `auth` | client → relay | Authenticate on connect (token + clientType) |
| `register_channel` / `remove_channel` / `rename_channel` | host → relay | Channel registry management |
| `channel_list` / `channel_update` | relay → app | Active sessions + status changes |
| `term_data` | host → relay → apps | Base64 raw PTY output bytes (rolling-buffered + replayed) |
| `term_input` | app → relay → host | Base64 keystrokes written to the PTY master fd |
| `term_resize` | app → relay → host | `{cols, rows}` → `TIOCSWINSZ` |
| `list_directory` / `directory_listing` | app ↔ host | Phone browses the desktop's allowed-root for "Start new session" |
| `remote_start_session` / `remote_session_started` | app ↔ host | Phone provokes a new session under the allowed-root |
| `ping` / `pong` | relay ↔ clients | Connectivity verification |
| `agent_event` / `user_prompt` / `permission_response` / `history_sync` | (legacy) | Structured SDK events — used only by the legacy `proxy/` path |

## Convention Notes

- **No magic values inline** — constants in companion objects (Android) or at file top (TS).
- **ESM + TypeScript strict mode** throughout `proxy/` and `relay/`.
- Legacy proxy orchestrator logs to file (`/tmp/claudebridge-orchestrator.log`), not stdout/stderr.
- **CLAUDECODE env var** must be cleared when spawning the PTY child to avoid a nested-session error; you cannot spawn `claude` from within a `claude` session.
