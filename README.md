# ClaudeBridge

Monitor and interact with multiple Claude Code sessions from your phone. Approve permissions, send messages, and track agent activity — all via a native Android app.

## How It Works

```
YOUR LAPTOP                              RAILWAY (always-on)
───────────────────                      ─────────────────────────
Claude Agent SDK sessions ──┐            ┌─────────────────────┐
  (edit local files)        ├──outbound──│  WebSocket Relay     │──▶ Android App
Bridge Bot (Node.js)  ──────┘            │  (SQLite persistence)│◀── Android App
                                         └─────────────────────┘
```

- **Relay** runs on Railway — a lightweight WebSocket server (~200 lines) with SQLite message persistence
- **Bridge Bot** runs on your laptop, connects outbound to the relay (no VPN needed)
- **Agent SDK sessions** run locally with full filesystem access
- **Android app** connects via WSS — foreground service keeps the connection alive for notifications
- Messages queue in the relay if your laptop sleeps — bot picks up on wake

## Quick Start

### Prerequisites

- Node.js 22+
- Railway CLI (`npm i -g @railway/cli && railway login`)
- Android Studio (for building the APK) or a pre-built APK
- Claude Code CLI authenticated (Max plan — no API key needed)

### 1. Deploy Relay to Railway

```bash
git clone https://github.com/yevgenysimkin/ClaudeBridge.git
cd ClaudeBridge

# Generate an auth token
AUTH_TOKEN=$(openssl rand -base64 32)
echo "Your auth token: $AUTH_TOKEN"

# Deploy to Railway (set up a new project, link relay/ as the service)
cd relay && npm install && npm run build
railway link
railway variables set AUTH_TOKEN="$AUTH_TOKEN" PORT=3000
railway up
```

Add a **volume** mounted at `/data` in Railway (Settings > Volumes) for SQLite persistence.

### 2. Configure

```bash
# Back in project root
cp .env.example .env
# Edit .env with your Railway relay URL and auth token
```

Configure your agents in `bot/config/agents.json`:
```json
{
  "agents": [
    {
      "id": "frontend",
      "name": "Frontend Dev",
      "cwd": "/Users/you/projects/my-app",
      "permissionMode": "acceptEdits",
      "maxBudgetUsd": 10.0
    }
  ]
}
```

### 3. Start the Bot

```bash
cd bot
npm install
npm run dev
```

### 4. Install the Android App

Build the APK:
```bash
cd android
./gradlew assembleDebug
# APK at: app/build/outputs/apk/debug/app-debug.apk
```

Transfer to your phone and sideload. Open the app, go to Settings, enter:
- **Relay URL**: your Railway domain (e.g., `https://claudebridge-production.up.railway.app`)
- **Auth Token**: the token you generated above

Hit Connect. You'll see agent channels appear as the bot registers them.

## Usage

From the Android app:
- Tap a channel to see agent messages
- When Claude needs a tool permission, tap **Approve** or **Deny**
- Type a message to send it to the agent as input

## Architecture

```
relay/src/
├── index.ts         — WebSocket server + HTTP health endpoint
├── protocol.ts      — Shared JSON-over-WebSocket protocol types
└── store.ts         — SQLite message persistence

bot/src/
├── index.ts         — Entry point
├── config.ts        — Configuration loading
├── constants.ts     — All magic values
├── relay-client.ts  — WebSocket client with auto-reconnect
├── agent-manager.ts — Agent lifecycle + message routing
└── agent-session.ts — Single SDK session wrapper

android/app/src/main/java/com/claudebridge/
├── ClaudeBridgeApp.kt            — Application class, notification channels
├── MainActivity.kt               — Compose navigation host
├── data/
│   ├── Models.kt                 — Channel, ChatMessage data classes
│   ├── RelayClient.kt            — OkHttp WebSocket client
│   ├── BridgeState.kt            — Reactive state holder (StateFlow)
│   └── Preferences.kt            — SharedPreferences wrapper
├── service/
│   └── RelayService.kt           — Foreground service, notifications
└── ui/
    ├── theme/                    — Material 3 dark theme
    ├── viewmodel/ChatViewModel.kt — UI state management
    └── screen/                   — Compose screens (channels, chat, settings)
```

## License

Private — all rights reserved.
