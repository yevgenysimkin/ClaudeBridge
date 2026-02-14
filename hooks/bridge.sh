#!/usr/bin/env bash
#
# ClaudeBridge — send messages to phone and wait for remote prompts.
#
# Usage:
#   bridge.sh send "message"        — send a message to the phone
#   bridge.sh wait                  — block until a remote prompt arrives, print it
#   bridge.sh send-and-wait "msg"   — send, then wait for next prompt
#
# Requires: CLAUDE_BRIDGE_CHANNEL env var (set per-project in CLAUDE.md or .env)

WATCHER_URL="http://127.0.0.1:9876"
PROMPT_FILE=".claude-bridge-prompt"
CHANNEL="${CLAUDE_BRIDGE_CHANNEL:-default}"

send_message() {
  local content="$1"
  # Escape for JSON
  local escaped
  escaped=$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$content")
  /usr/bin/curl -s -X POST "${WATCHER_URL}/message" \
    -H "Content-Type: application/json" \
    -d "{\"channel\":\"${CHANNEL}\",\"content\":${escaped}}" > /dev/null
}

wait_for_prompt() {
  # If prompt file already has content, consume it immediately
  if [ -s "$PROMPT_FILE" ] 2>/dev/null; then
    cat "$PROMPT_FILE"
    > "$PROMPT_FILE"
    return
  fi

  # Ensure the file exists (fswatch needs it)
  touch "$PROMPT_FILE" 2>/dev/null || true

  # Block until the file changes and has content
  while true; do
    fswatch -1 "$PROMPT_FILE" > /dev/null 2>&1
    if [ -s "$PROMPT_FILE" ]; then
      cat "$PROMPT_FILE"
      > "$PROMPT_FILE"
      return
    fi
  done
}

case "${1:-}" in
  send)
    shift
    send_message "$*"
    ;;
  wait)
    wait_for_prompt
    ;;
  send-and-wait)
    shift
    send_message "$*"
    wait_for_prompt
    ;;
  *)
    echo "Usage: bridge.sh {send|wait|send-and-wait} [message]" >&2
    exit 1
    ;;
esac
