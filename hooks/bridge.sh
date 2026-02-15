#!/usr/bin/env bash
#
# ClaudeBridge — send messages to phone and wait for remote prompts.
#
# Usage:
#   bridge.sh <session-id> send "message"        — send a message to the phone
#   bridge.sh <session-id> wait                   — block until a remote prompt arrives
#   bridge.sh <session-id> send-and-wait "msg"    — send, then wait for next prompt
#
# Session ID is provided by the bridge hook via additionalContext on first tool use.
# Prompt files live at ~/.claude/bridge/<session-id>/prompt

WATCHER_URL="http://127.0.0.1:9876"
BRIDGE_DIR="$HOME/.claude/bridge"

SESSION_ID="${1:-}"
if [ -z "$SESSION_ID" ]; then
  echo "Error: session ID required as first argument" >&2
  echo "Usage: bridge.sh <session-id> {send|wait|send-and-wait} [message]" >&2
  exit 1
fi
shift

PROMPT_FILE="${BRIDGE_DIR}/${SESSION_ID}/prompt"

send_message() {
  local content="$1"
  local escaped
  escaped=$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$content")
  /usr/bin/curl -s -X POST "${WATCHER_URL}/message" \
    -H "Content-Type: application/json" \
    -d "{\"sessionId\":\"${SESSION_ID}\",\"content\":${escaped}}" > /dev/null
}

wait_for_prompt() {
  # Ensure the session directory and prompt file exist
  mkdir -p "$(dirname "$PROMPT_FILE")"

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
    echo "Usage: bridge.sh <session-id> {send|wait|send-and-wait} [message]" >&2
    exit 1
    ;;
esac
