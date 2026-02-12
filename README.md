# ClaudeBridge

A bridge that connects multiple Claude Code sessions to a Matrix/Element chat server. Monitor and interact with your Claude agents — including permission approvals — from your phone or desktop.

## How It Works

```
YOUR LAPTOP                              RAILWAY (always-on)
───────────────────                      ─────────────────────────
Claude Agent SDK sessions ──┐            ┌─────────────────────┐
  (edit local files)        ├──outbound──│  Synapse (Matrix)    │──▶ Element
Bridge Bot (Node.js)  ──────┘            │  (always reachable)  │◀── Element
                                         └─────────────────────┘
```

- **Synapse** (Matrix homeserver) runs on Railway — always reachable from your phone
- **Bridge Bot** runs on your laptop, connects outbound to Railway (no VPN needed)
- **Agent SDK sessions** run locally with full filesystem access to your projects
- Messages queue in Synapse if your laptop is asleep — bot picks up on wake

## Quick Start

### Prerequisites

- Node.js 22+
- Railway CLI (`npm i -g @railway/cli && railway login`)
- `jq`, `curl`, `openssl`
- An Anthropic API key

### 1. Deploy Synapse to Railway

```bash
git clone https://github.com/yevgenysimkin/ClaudeBridge.git
cd ClaudeBridge

# Deploy Synapse to Railway
./scripts/deploy-railway.sh
```

Then in the Railway dashboard:
1. Add a **volume** mounted at `/data` (Settings → Volumes)
2. Generate a **public domain** (Settings → Networking → Generate Domain)
3. Note the domain URL

### 2. Register Users

```bash
# Point setup at your Railway Synapse — it registers users and writes .env
./scripts/setup.sh https://your-railway-domain.up.railway.app
```

### 3. Configure

```bash
# Add your Anthropic API key
vim .env  # set ANTHROPIC_API_KEY=sk-ant-...

# Configure your agents
vim bot/config/agents.json
```

Example `agents.json`:
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

### 4. Start the Bot

```bash
cd bot
npm install
npm run dev
```

### 5. Connect Element

Open Element (phone or desktop) and connect to your homeserver:
- **Homeserver URL:** your Railway domain (e.g., `https://claudebridge-production-xxxx.up.railway.app`)
- **Username / Password:** shown in setup output

You'll see rooms created automatically — one per agent plus "Claude Ops".

## Usage

### Ops Room Commands

| Command | Description |
|---------|-------------|
| `!start <agent-id>` | Start an agent session |
| `!stop <agent-id>` | Stop an agent session |
| `!restart <agent-id>` | Clear session and stop |
| `!status [agent-id]` | Show status |
| `!agents` | List all configured agents |
| `!cost [agent-id]` | Show cost breakdown |
| `!approve-all` | Approve all pending permissions |

### In Agent Rooms

Type a message to send it to Claude as a prompt. When Claude needs permission:

- Reply **y** to approve
- Reply **n** to deny
- Reply with text to deny with a reason

## Local Development

For testing without Railway, use the included Docker Compose:

```bash
./scripts/setup.sh --local
cd bot && npm run dev
```

This starts Synapse locally on `localhost:8008`.

## Architecture

```
bot/src/
├── index.ts            — Entry point
├── config.ts           — Configuration loading
├── constants.ts        — All magic values
├── matrix-client.ts    — Matrix connection + room management
├── agent-manager.ts    — Agent lifecycle + message routing
├── agent-session.ts    — Single SDK session wrapper
├── formatter.ts        — Matrix message formatting
└── commands.ts         — Ops room command parsing
```

## License

Private — all rights reserved.
