#!/bin/bash
set -e

DATA_DIR="/data"
CONFIG_DEST="$DATA_DIR/homeserver.yaml"
LOG_DEST="$DATA_DIR/log.config"
TEMPLATE="/conf/homeserver.yaml.template"

# Ensure data directory exists
mkdir -p "$DATA_DIR/media_store" "$DATA_DIR/uploads"

# Substitute environment variables into the config template
# SYNAPSE_REGISTRATION_SECRET must be set as a Railway env var
if [ -z "$SYNAPSE_REGISTRATION_SECRET" ]; then
    echo "ERROR: SYNAPSE_REGISTRATION_SECRET is not set."
    echo "Generate one with: openssl rand -base64 32"
    exit 1
fi

sed "s|REPLACE_ME_ON_FIRST_RUN|${SYNAPSE_REGISTRATION_SECRET}|g" "$TEMPLATE" > "$CONFIG_DEST"

# Copy log config
cp /conf/log.config "$LOG_DEST"

# Generate signing key if it doesn't exist (first boot)
if [ ! -f "$DATA_DIR/signing.key" ]; then
    echo "First boot — generating signing key..."
    python -m synapse.app.homeserver \
        --config-path "$CONFIG_DEST" \
        --generate-keys
fi

echo "Starting Synapse..."
exec python -m synapse.app.homeserver \
    --config-path "$CONFIG_DEST"
