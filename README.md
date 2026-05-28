# ClaudeBridge

Monitor and drive your Claude Code sessions from your phone. ClaudeBridge pipes a **real interactive `claude` PTY** between a host machine and an Android app over a WebSocket relay — so you see the actual `claude` TUI (colors, cursor, permission prompts and all), rendered with xterm.js, and you can type back into it from anywhere.

This is the **v2 PTY architecture**. The earlier headless stream-JSON / Agent-SDK approach has been retired — it loses Claude MAX coverage after Anthropic's 2026-06-15 cutover, whereas an interactive PTY session stays MAX-covered. (A legacy Node stream-JSON orchestrator still lives in `proxy/`; see [Components](#components).)

## Bring your own relay

There is **no shared or official relay** — you host your own, on whatever always-on platform you like (e.g. Fly, Render, Railway, a VPS, or a box on your LAN — your call). It only needs to be reachable over `wss://` and stay running. The relay is a stateless WebSocket broker; nothing about it is tied to any one provider.

### Relay auth: pairing mode

The connection token is **auto-provisioned by the client, never set or pasted by you** (see [Auth and phone provisioning](#auth-and-phone-provisioning)). Because the desktop mints its own random token, your relay must run in **pairing mode** so it accepts that token and scopes channels to it:

```
RELAY_ALLOW_PAIRING=1     # and leave RELAY_AUTH_TOKEN unset
```

In pairing mode the relay accepts any non-empty token and isolates channels per token. Each install's token is a random UUID, so that UUID is effectively the access key to your channels — keep your relay private to you.

Do **not** set `RELAY_AUTH_TOKEN` to a shared secret: there is no UI to feed such a secret to the desktop or phone, so the clients' auto-minted tokens would never match it and every connection would be rejected. (`RELAY_AUTH_TOKEN` / exact-match "locked" mode exists in the relay code, but it is incompatible with the auto-provisioned client token this product uses.)

## Supported topology

One host per token. The relay forwards control-protocol messages (`list_directory`, `remote_start_session`) to *all* connected hosts that share a token, and trusts whichever replies first. If you run two hosts on the same token, a buggy or malicious one can forge filesystem listings to the phone. Stick to one host per token until this is hardened.

## How It Works

```
YOUR MACHINE                            YOUR RELAY HOST (always-on)
─────────────────────────               ───────────────────────────
real `claude` PTY (forkpty)             ┌──────────────────┐
  │  raw bytes ↕                        │  WebSocket Relay  │
  ▼                                     │  (in-memory       │
Host orchestrator ──────outbound WSS───▶│   per-channel     │──▶ Android app
  (Chromattica desktop,                 │   buffers)        │◀── (xterm.js)
   or Node `proxy/`)        ◀───────────│                  │
                                        └──────────────────┘
```

- **Relay** is a stateless WebSocket broker. State lives in memory only — there is no database, nothing survives a relay restart. It keeps small per-channel buffers: a 500-event ring for structured events, plus a rolling ~64 KB buffer of recent raw PTY bytes per channel, replayed to a reconnecting client so it gets an immediate redraw.
- **Host orchestrator** spawns `claude` inside a real PTY and connects **outbound** to the relay (no inbound ports, no VPN). The primary host is the **Chromattica desktop app** (built-in C++/forkpty orchestrator). A standalone Node orchestrator also ships in `proxy/`.
- **Android app** opens a WebSocket straight to the relay and renders the PTY stream in an xterm.js WebView. A foreground service keeps the connection alive for notifications.
- **PTY protocol:** host → `term_data` (base64 raw bytes) → relay → app; app keystrokes → `term_input` (base64) → host's PTY master fd; viewport changes → `term_resize` (cols/rows) → `TIOCSWINSZ`.

## Components

| Component | Location | Runs on | Purpose |
|-----------|----------|---------|---------|
| **Relay** | `relay/` | your relay host (anywhere) | WebSocket broker; auth, channel registry, control + PTY message routing |
| **Chromattica desktop** | (Chromattica repo, `native/src/services/CbOrchestrator*.cpp`) | Your Mac/PC | Primary host — forkpty `claude`, renders sessions in CEF + xterm.js |
| **Node proxy** | `proxy/` | Your machine | Standalone orchestrator. **Legacy headless stream-JSON path** — superseded by the desktop PTY host and not MAX-covered after 2026-06-15 |
| **Android app** | `android/` | Phone | Kotlin/Compose shell + xterm.js WebView session view |

## Auth and phone provisioning

**End users never paste auth tokens into either client.** The relay connection token is **provisioned automatically**:

1. The **Chromattica desktop** mints the token (a random UUID) on first launch if one isn't set, and syncs it up to chromattica-api.
2. You sign into Chromattica on **both** desktop and phone with the **same email** (OTP login).
3. The **Android app pulls the token (and relay URL) at OTP login** — it never generates one, and there is no token input field in its settings (just a read-only "Auth token synced" indicator).

So end-user setup is: install the Claude CLI on the host, point the host at your relay's `wss://` URL, and sign in with the same account on desktop and phone. The phone is purely downstream of whatever the desktop wrote to chromattica-api — if the phone "sees nothing," confirm the desktop has logged in at least once since install.

## Quick Start

### Prerequisites

- Node.js 22+
- Claude Code CLI authenticated (MAX plan — no API key needed)
- Android Studio (to build the APK) or a pre-built APK
- An always-on host for the relay, reachable over `wss://` (your choice of platform)

### 1. Deploy the relay

```bash
git clone https://github.com/yevgenysimkin/ClaudeBridge.git
cd ClaudeBridge/relay
npm install && npm run build
RELAY_ALLOW_PAIRING=1 PORT=3000 npm start
```

Run that on whatever always-on host you picked, behind TLS so clients reach it over `wss://`. No volume or database needed — the relay keeps all state in memory. (`RELAY_ALLOW_PAIRING=1` is required; see [Relay auth](#relay-auth-pairing-mode).)

### 2. Run a host

**Preferred:** use the Chromattica desktop app — it spawns the PTY and registers the channel for you (`ClaudeBridgeManager::startSession(projectDir)`), and handles the auth token automatically (see [Auth and phone provisioning](#auth-and-phone-provisioning)).

**Standalone Node proxy** (legacy stream-JSON path):

```bash
cp .env.example .env          # set RELAY_URL to your relay's wss:// URL
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
        └── screen/                 — ChannelListScreen, MessageScreen, SettingsScreen,
                                       NewSessionSheet, WebViewSessionScreen (xterm.js)
```

## License

Private — all rights reserved.
