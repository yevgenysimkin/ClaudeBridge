# ClaudeBridge

Monitor and drive your Claude Code sessions from your phone. ClaudeBridge pipes a **real interactive `claude` PTY** between a host machine and an Android app over a WebSocket relay — so you see the actual `claude` TUI (colors, cursor, permission prompts and all), rendered with xterm.js, and you can type back into it from anywhere.

This is the **v2 PTY architecture**. The earlier headless stream-JSON / Agent-SDK approach has been retired — it loses Claude MAX coverage after Anthropic's 2026-06-15 cutover, whereas an interactive PTY session stays MAX-covered. (A legacy Node stream-JSON orchestrator still lives in `proxy/`; see [Components](#components).)

## Security note before you deploy

The relay supports two auth modes:

- **Locked** (recommended) — set `RELAY_AUTH_TOKEN` to a shared secret. Only clients with the exact token authenticate.
- **Pairing** — leave `RELAY_AUTH_TOKEN` unset and explicitly set `RELAY_ALLOW_PAIRING=1`. The relay then accepts any non-empty token and scopes channels by whichever token a client picks. Two strangers who happen to pick the same string see each other's PTY streams. **Only use pairing mode on a single-user / private host.** Without either env var, the relay refuses to start.

## Supported topology

One bot (host) per auth token. The relay forwards control-protocol messages (`list_directory`, `remote_start_session`) to *all* connected bots that share a token, and trusts whichever bot replies first. If you run two hosts on the same token, a buggy or malicious one can forge filesystem listings to the phone. Stick to one host per token until this is hardened.

## How It Works

```
YOUR MACHINE                            RAILWAY (always-on)
─────────────────────────               ─────────────────────
real `claude` PTY (forkpty)             ┌──────────────────┐
  │  raw bytes ↕                        │  WebSocket Relay  │
  ▼                                     │  (in-memory       │
Host orchestrator ──────outbound WSS───▶│   per-channel     │──▶ Android app
  (Chromattica desktop,                 │   buffers)        │◀── (xterm.js)
   or Node `proxy/`)        ◀───────────│                  │
                                        └──────────────────┘
```

- **Relay** runs on Railway — a stateless WebSocket broker. It keeps small in-memory per-channel buffers for non-terminal events; **terminal (`term_data`) traffic is live, not buffered** — the next PTY redraw covers a reconnecting client. There is no database.
- **Host orchestrator** spawns `claude` inside a real PTY and connects **outbound** to the relay (no inbound ports, no VPN). The primary host is the **Chromattica desktop app** (built-in C++/forkpty orchestrator). A standalone Node orchestrator also ships in `proxy/`.
- **Android app** opens a WebSocket straight to the relay and renders the PTY stream in an xterm.js WebView. A foreground service keeps the connection alive for notifications.
- **PTY protocol:** host → `term_data` (base64 raw bytes) → relay → app; app keystrokes → `term_input` (base64) → host's PTY master fd; viewport changes → `term_resize` (cols/rows) → `TIOCSWINSZ`.

## Components

| Component | Location | Runs on | Purpose |
|-----------|----------|---------|---------|
| **Relay** | `relay/` | Railway | WebSocket broker; auth, channel registry, control + PTY message routing |
| **Chromattica desktop** | (Chromattica repo, `native/src/services/CbOrchestrator*.cpp`) | Your Mac/PC | Primary host — forkpty `claude`, renders sessions in CEF + xterm.js |
| **Node proxy** | `proxy/` | Your machine | Standalone orchestrator. **Legacy headless stream-JSON path** — superseded by the desktop PTY host and not MAX-covered after 2026-06-15 |
| **Android app** | `android/` | Phone | Kotlin/Compose shell + xterm.js WebView session view |

**Default relay:** `https://cb.pinewell.xyz` (also reachable at `https://claudebridge-production.up.railway.app`).

## Auth and phone provisioning

**End users never paste auth tokens into the phone.** The relay auth token is **provisioned automatically**, not typed into the app:

1. The **Chromattica desktop** mints the relay auth token (a UUID) on first launch if one isn't set, and syncs it up to chromattica-api.
2. You sign into Chromattica on **both** desktop and phone with the **same email** (OTP login).
3. The **Android app pulls the token (and relay URL) at OTP login** — it never generates one. The token field has been removed from the app's settings UI.

So end-user setup is: install the Claude CLI on the host, point the host at your relay's `wss://` URL, and sign in with the same account on desktop and phone. The phone is purely downstream of whatever the desktop wrote to chromattica-api — if the phone "sees nothing," confirm the desktop has logged in at least once since install.

(Operators deploying their own relay still set `RELAY_AUTH_TOKEN` on the Railway service as the shared secret — that's the server side. The "no pasting" rule is about end users on the phone.)

## Quick Start

### Prerequisites

- Node.js 22+
- Railway CLI (`npm i -g @railway/cli && railway login`)
- Claude Code CLI authenticated (MAX plan — no API key needed)
- Android Studio (to build the APK) or a pre-built APK

### 1. Deploy the relay to Railway

```bash
git clone https://github.com/yevgenysimkin/ClaudeBridge.git
cd ClaudeBridge

# Generate the shared auth token
RELAY_AUTH_TOKEN=$(openssl rand -base64 32)
echo "Your relay auth token: $RELAY_AUTH_TOKEN"

cd relay && npm install && npm run build
railway link
railway variables set RELAY_AUTH_TOKEN="$RELAY_AUTH_TOKEN" PORT=3000
railway up
```

No volume needed — the relay keeps state in memory only.

### 2. Run a host

**Preferred:** use the Chromattica desktop app — it spawns the PTY and registers the channel for you (`ClaudeBridgeManager::startSession(projectDir)`), and handles the auth token automatically (see [Auth and phone provisioning](#auth-and-phone-provisioning)).

**Standalone Node proxy** (legacy stream-JSON path):

```bash
cp .env.example .env          # set RELAY_URL and RELAY_AUTH_TOKEN
cd proxy && npm install
npm run dev                    # or: npm run build && npm start
```

### 3. Install the Android app

Build the release APK:

```bash
cd android
./gradlew assembleRelease
# APK at: app/build/outputs/apk/release/app-release.apk
# (debug build: ./gradlew assembleDebug → app/build/outputs/apk/debug/app-debug.apk)
```

App identity: name **ClaudeBridge**, package `com.claudebridge`. Sideload it, then **sign in with the same Chromattica account** you use on the desktop. Channels appear as the host registers them; tap one to open the live terminal.

## Usage

From the Android app:

- Tap a channel to open its **xterm.js terminal** — the live `claude` TUI.
- Type to send keystrokes straight into the PTY (arrow keys, Ctrl-C, etc. all pass through).
- **Permission prompts appear inline in the terminal** — answer them the same way you would in a normal `claude` session. (There's no separate Approve/Deny card flow anymore; that was the SDK era.)
- "Start new session" lets the phone browse the desktop's configured allowed-root and provoke a new session remotely.

## Architecture

```
relay/src/
├── index.ts      — WebSocket server, HTTP health endpoint, auth + routing
└── protocol.ts   — Shared JSON-over-WebSocket message types

proxy/src/                 (legacy standalone Node orchestrator)
├── orchestrator.ts        — stream-JSON claude session + relay wiring
├── relay-client.ts        — WebSocket client with auto-reconnect
├── permission-router.ts   — SDK-era permission routing
├── prompt-queue.ts        — AsyncIterable prompt delivery
└── config.ts              — .env config loading

android/app/src/main/
├── assets/
│   ├── session.html        — xterm.js terminal page (loaded by WebView)
│   └── vendor/xterm/       — vendored xterm.js + addon-fit + xterm.css
└── java/com/claudebridge/
    ├── ClaudeBridgeApp.kt          — Application class, notification channels
    ├── MainActivity.kt             — Compose navigation host
    ├── data/
    │   ├── Models.kt               — Channel / message data classes
    │   ├── RelayClient.kt          — OkHttp WebSocket client
    │   ├── ChromatticaApi.kt       — OTP login + config fetch (auth token, relay URL)
    │   ├── BridgeState.kt          — Reactive state holder (StateFlow)
    │   └── Preferences.kt          — SharedPreferences wrapper
    ├── service/RelayService.kt     — Foreground service, notifications
    └── ui/
        ├── theme/                  — Material 3 dark theme
        ├── viewmodel/ChatViewModel.kt
        └── screen/                 — ChannelList, Message, Settings,
                                       NewSessionSheet, WebViewSession (xterm.js)
```

## License

Private — all rights reserved.
