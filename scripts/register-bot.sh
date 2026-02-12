#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Register an additional bot user in Synapse
# Usage: ./register-bot.sh <username> [--admin]
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
    echo "Error: .env not found. Run setup.sh first."
    exit 1
fi

source "$ENV_FILE"

USERNAME="${1:?Usage: register-bot.sh <username> [--admin]}"
IS_ADMIN="false"
if [ "${2:-}" = "--admin" ]; then
    IS_ADMIN="true"
fi

HOMESERVER_URL="${MATRIX_HOMESERVER_URL:-http://localhost:8008}"
PASSWORD=$(openssl rand -base64 16)

# Get nonce
NONCE=$(curl -sf "$HOMESERVER_URL/_synapse/admin/v1/register" | jq -r '.nonce')

# Compute HMAC
if [ "$IS_ADMIN" = "true" ]; then
    ADMIN_FLAG="admin"
else
    ADMIN_FLAG="notadmin"
fi

MAC=$(printf '%s\0%s\0%s\0%s' "$NONCE" "$USERNAME" "$PASSWORD" "$ADMIN_FLAG" \
    | openssl dgst -sha1 -hmac "$SYNAPSE_REGISTRATION_SECRET" \
    | awk '{print $NF}')

# Register
RESULT=$(curl -sf -X POST "$HOMESERVER_URL/_synapse/admin/v1/register" \
    -H "Content-Type: application/json" \
    -d "{
        \"nonce\": \"$NONCE\",
        \"username\": \"$USERNAME\",
        \"password\": \"$PASSWORD\",
        \"admin\": $IS_ADMIN,
        \"mac\": \"$MAC\"
    }")

echo "$RESULT" | jq .

# Get access token
TOKEN=$(curl -sf -X POST "$HOMESERVER_URL/_matrix/client/v3/login" \
    -H "Content-Type: application/json" \
    -d "{
        \"type\": \"m.login.password\",
        \"identifier\": {
            \"type\": \"m.id.user\",
            \"user\": \"$USERNAME\"
        },
        \"password\": \"$PASSWORD\"
    }" | jq -r '.access_token')

echo ""
echo "User registered: @${USERNAME}:claudebridge"
echo "Password: $PASSWORD"
echo "Access token: $TOKEN"
