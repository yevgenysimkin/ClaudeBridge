#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# ClaudeBridge — Setup Script
# =============================================================================
# Registers users on Synapse, obtains access tokens, writes .env.
#
# Usage:
#   ./setup.sh <homeserver-url>                      — Railway/remote Synapse
#   ./setup.sh --local                               — Local Docker dev
#
# The Synapse instance must already be running and reachable.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_DIR/.env"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# --- Pre-flight ---
command -v curl >/dev/null 2>&1 || error "curl is required."
command -v jq   >/dev/null 2>&1 || error "jq is required."

# --- Parse arguments ---
if [ "${1:-}" = "--local" ]; then
    MODE="local"
    HOMESERVER_URL="http://localhost:8008"

    # Start local Synapse if not running
    command -v docker >/dev/null 2>&1 || error "Docker is required for local mode."

    # Generate secret if not set
    if [ -z "${SYNAPSE_REGISTRATION_SECRET:-}" ]; then
        SYNAPSE_REGISTRATION_SECRET=$(openssl rand -base64 32)
        export SYNAPSE_REGISTRATION_SECRET
    fi

    info "Starting local Synapse..."
    cd "$PROJECT_DIR"
    docker compose up -d synapse

    info "Waiting for Synapse to become healthy..."
    MAX_WAIT=90
    WAITED=0
    while [ $WAITED -lt $MAX_WAIT ]; do
        if curl -sf "$HOMESERVER_URL/health" >/dev/null 2>&1; then
            info "Synapse is healthy!"
            break
        fi
        sleep 2
        WAITED=$((WAITED + 2))
        echo -n "."
    done
    echo ""

    if [ $WAITED -ge $MAX_WAIT ]; then
        error "Synapse did not become healthy within ${MAX_WAIT}s. Check: docker compose logs synapse"
    fi

elif [ -n "${1:-}" ]; then
    MODE="remote"
    HOMESERVER_URL="${1}"

    # For remote mode, we need the registration secret
    if [ -z "${SYNAPSE_REGISTRATION_SECRET:-}" ]; then
        echo -n "Enter Synapse registration secret: "
        read -r SYNAPSE_REGISTRATION_SECRET
    fi

    # Verify Synapse is reachable
    info "Checking Synapse at ${HOMESERVER_URL}..."
    if ! curl -sf "${HOMESERVER_URL}/health" >/dev/null 2>&1; then
        error "Cannot reach Synapse at ${HOMESERVER_URL}/health"
    fi
    info "Synapse is reachable!"

else
    echo "Usage:"
    echo "  ./setup.sh <homeserver-url>   — Remote Synapse (Railway)"
    echo "  ./setup.sh --local            — Local Docker Synapse"
    echo ""
    echo "Examples:"
    echo "  ./setup.sh https://claudebridge-production-xxxx.up.railway.app"
    echo "  ./setup.sh --local"
    echo ""
    echo "For remote mode, set SYNAPSE_REGISTRATION_SECRET env var or you'll be prompted."
    exit 1
fi

# --- Check for existing .env ---
if [ -f "$ENV_FILE" ]; then
    warn ".env already exists. To re-run setup, delete or rename it first."
    exit 1
fi

# --- Register users ---
register_user() {
    local username="$1"
    local password="$2"
    local admin="$3"

    info "Registering user: $username (admin=$admin)..."

    local NONCE
    NONCE=$(curl -sf "$HOMESERVER_URL/_synapse/admin/v1/register" | jq -r '.nonce')

    local ADMIN_FLAG
    if [ "$admin" = "true" ]; then
        ADMIN_FLAG="admin"
    else
        ADMIN_FLAG="notadmin"
    fi

    local MAC
    MAC=$(printf '%s\0%s\0%s\0%s' "$NONCE" "$username" "$password" "$ADMIN_FLAG" \
        | openssl dgst -sha1 -hmac "$SYNAPSE_REGISTRATION_SECRET" \
        | awk '{print $NF}')

    local RESULT
    RESULT=$(curl -sf -X POST "$HOMESERVER_URL/_synapse/admin/v1/register" \
        -H "Content-Type: application/json" \
        -d "{
            \"nonce\": \"$NONCE\",
            \"username\": \"$username\",
            \"password\": \"$password\",
            \"admin\": $admin,
            \"mac\": \"$MAC\"
        }" 2>&1) || {
            if echo "$RESULT" | grep -q "User ID already taken"; then
                warn "User $username already exists, skipping registration."
                return 0
            fi
            warn "Registration failed: $RESULT"
            return 1
        }

    info "Registered $username."
}

get_access_token() {
    local username="$1"
    local password="$2"

    curl -sf -X POST "$HOMESERVER_URL/_matrix/client/v3/login" \
        -H "Content-Type: application/json" \
        -d "{
            \"type\": \"m.login.password\",
            \"identifier\": {
                \"type\": \"m.id.user\",
                \"user\": \"$username\"
            },
            \"password\": \"$password\"
        }" | jq -r '.access_token'
}

# Generate passwords
ADMIN_PASSWORD=$(openssl rand -base64 16)
BOT_PASSWORD=$(openssl rand -base64 16)

register_user "ysimkin" "$ADMIN_PASSWORD" "true" || true
register_user "bridge-bot" "$BOT_PASSWORD" "false" || true

# --- Get access tokens ---
info "Obtaining access tokens..."
BOT_TOKEN=$(get_access_token "bridge-bot" "$BOT_PASSWORD")
ADMIN_TOKEN=$(get_access_token "ysimkin" "$ADMIN_PASSWORD")

if [ -z "$BOT_TOKEN" ] || [ "$BOT_TOKEN" = "null" ]; then
    error "Failed to get bot access token."
fi

# --- Write .env ---
info "Writing .env..."
cat > "$ENV_FILE" << EOF
# ClaudeBridge Environment — generated by setup.sh on $(date -Iseconds)

# --- Matrix / Synapse (${MODE}) ---
SYNAPSE_REGISTRATION_SECRET=${SYNAPSE_REGISTRATION_SECRET}
MATRIX_HOMESERVER_URL=${HOMESERVER_URL}
MATRIX_BOT_USER=@bridge-bot:claudebridge
MATRIX_BOT_ACCESS_TOKEN=${BOT_TOKEN}
MATRIX_ADMIN_USER=@ysimkin:claudebridge
MATRIX_ADMIN_ACCESS_TOKEN=${ADMIN_TOKEN}

# Admin credentials (save somewhere safe, then remove from .env if desired)
ADMIN_PASSWORD=${ADMIN_PASSWORD}
BOT_PASSWORD=${BOT_PASSWORD}

# --- Anthropic ---
ANTHROPIC_API_KEY=
CLAUDE_MODEL=claude-sonnet-4-5-20250929
EOF

info "Setup complete!"
echo ""
echo "========================================="
echo "  Homeserver: $HOMESERVER_URL"
echo "  Admin user: ysimkin"
echo "  Admin pass: $ADMIN_PASSWORD"
echo "  Bot token:  ${BOT_TOKEN:0:20}..."
echo "========================================="
echo ""
info "Next steps:"
info "  1. Add your ANTHROPIC_API_KEY to .env"
info "  2. Edit bot/config/agents.json"
info "  3. cd bot && npm install && npm run dev"
echo ""
info "To connect Element to this server:"
info "  Homeserver URL: $HOMESERVER_URL"
info "  Username: ysimkin"
info "  Password: $ADMIN_PASSWORD"
