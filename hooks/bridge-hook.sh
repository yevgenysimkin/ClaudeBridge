#!/usr/bin/env bash
#
# ClaudeBridge PreToolUse hook — auto-registration + mode-aware permissions.
#
# Behavior depends on the global mode (phone/desktop) set from the Android app:
#   DESKTOP (default): Returns "ask" — normal terminal permission prompt.
#   PHONE: Blocks waiting for phone approval via the watcher.
#
# Escape hatch: touch ~/.claude/bridge/disabled → all hooks become no-ops.
#
# Input (stdin): JSON with session_id, tool_name, tool_input, cwd, etc.
# Output (stdout): JSON with hookSpecificOutput for allow/deny/ask + additionalContext.

WATCHER_URL="http://127.0.0.1:9876"
BRIDGE_DIR="$HOME/.claude/bridge"

# --- Escape hatch: kill switch ---
if [ -f "${BRIDGE_DIR}/disabled" ]; then
  exit 0
fi

# Read hook input from stdin
INPUT=$(cat)

# Extract fields (single python3 call for efficiency)
eval "$(echo "$INPUT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
sid = d.get('session_id', '')
tn = d.get('tool_name', 'unknown')
ti = json.dumps(d.get('tool_input', {}))
cwd = d.get('cwd', '')
cmd = d.get('tool_input', {}).get('command', '')
print(f'SESSION_ID={json.dumps(sid)}')
print(f'TOOL_NAME={json.dumps(tn)}')
print(f'TOOL_INPUT={json.dumps(ti)}')
print(f'CWD={json.dumps(cwd)}')
print(f'COMMAND={json.dumps(cmd)}')
" 2>/dev/null)"

# No session_id means we can't do anything useful
if [ -z "$SESSION_ID" ]; then
  exit 0
fi

# Skip bridge.sh / bridge-hook commands to avoid deadlock
if echo "$COMMAND" | grep -q "bridge\.sh\|bridge-hook\|claude-bridge-prompt"; then
  exit 0
fi

# --- Helper: register session with watcher (idempotent, best-effort) ---
register_session() {
  local session_dir="${BRIDGE_DIR}/${SESSION_ID}"
  if [ ! -f "${session_dir}/registered" ]; then
    mkdir -p "$session_dir"
    /usr/bin/curl -s --connect-timeout 1 --max-time 2 \
      -X POST "${WATCHER_URL}/register" \
      -H "Content-Type: application/json" \
      -d "{\"sessionId\":\"${SESSION_ID}\",\"cwd\":\"${CWD}\"}" > /dev/null 2>&1 && \
      touch "${session_dir}/registered"
    echo "true"  # first fire
  else
    echo "false"
  fi
}

# --- Helper: build additionalContext string ---
additional_context() {
  echo "ClaudeBridge active. Your session ID is: ${SESSION_ID} — When using bridge.sh, always pass this as the first argument, e.g.: bridge.sh ${SESSION_ID} send \\\"message\\\" or bridge.sh ${SESSION_ID} wait or bridge.sh ${SESSION_ID} send-and-wait \\\"message\\\""
}

# --- Read-only tools: register but never block ---
if echo "$TOOL_NAME" | grep -qE "^(Read|Glob|Grep|WebSearch|WebFetch|TaskCreate|TaskUpdate|TaskList|TaskGet|TaskOutput|AskUserQuestion|EnterPlanMode|ExitPlanMode|mcp__|Skill|NotebookEdit)"; then
  FIRST_FIRE=$(register_session)
  if [ "$FIRST_FIRE" = "true" ]; then
    CTX=$(additional_context)
    echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"additionalContext\":\"${CTX}\"}}"
  fi
  exit 0
fi

# --- Non-read-only tool: register, check mode, handle accordingly ---

FIRST_FIRE=$(register_session)

# Query mode from watcher (fast local call, 1s timeout)
MODE=$(/usr/bin/curl -s --connect-timeout 1 --max-time 1 \
  "http://127.0.0.1:9876/mode" 2>/dev/null | \
  python3 -c "import sys,json; print(json.load(sys.stdin).get('mode','desktop'))" 2>/dev/null)

# Default to desktop if watcher unreachable or response unparseable
if [ -z "$MODE" ]; then
  MODE="desktop"
fi

# --- DESKTOP mode: return "ask" (normal terminal prompt) ---
if [ "$MODE" = "desktop" ]; then
  if [ "$FIRST_FIRE" = "true" ]; then
    CTX=$(additional_context)
    echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"ask\",\"additionalContext\":\"${CTX}\"}}"
  fi
  # No output = no opinion = normal "ask" behavior
  exit 0
fi

# --- PHONE mode: block waiting for phone approval ---

# Build a human-readable summary for the permission request
SUMMARY=$(echo "$TOOL_INPUT" | python3 -c "
import sys, json
ti = json.load(sys.stdin)
tool = '$TOOL_NAME'
parts = [tool]
if tool == 'Bash' and 'command' in ti:
    cmd = ti['command']
    if len(cmd) > 200:
        cmd = cmd[:200] + '...'
    parts.append(cmd)
elif tool == 'Edit' and 'file_path' in ti:
    parts.append(ti['file_path'])
elif tool == 'Write' and 'file_path' in ti:
    parts.append(ti['file_path'])
elif tool == 'Task' and 'description' in ti:
    parts.append(ti['description'])
print(' — '.join(parts))
" 2>/dev/null)
[ -z "$SUMMARY" ] && SUMMARY="$TOOL_NAME"

REQUEST_ID="perm-$(date +%s)-$$"

ESCAPED_SUMMARY=$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$SUMMARY")

RESPONSE=$(/usr/bin/curl -s --connect-timeout 1 --max-time 300 \
  -X POST "${WATCHER_URL}/permission" \
  -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"${SESSION_ID}\",\"requestId\":\"${REQUEST_ID}\",\"toolName\":\"${TOOL_NAME}\",\"toolInput\":${TOOL_INPUT},\"summary\":${ESCAPED_SUMMARY}}" 2>/dev/null)

if [ $? -ne 0 ] || [ -z "$RESPONSE" ]; then
  # Watcher unreachable — fall through to normal terminal permissions
  if [ "$FIRST_FIRE" = "true" ]; then
    CTX=$(additional_context)
    echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"ask\",\"permissionDecisionReason\":\"Bridge watcher unreachable\",\"additionalContext\":\"${CTX}\"}}"
  else
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"Bridge watcher unreachable"}}'
  fi
  exit 0
fi

# Parse response
APPROVED=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('approved', False))" 2>/dev/null)
REASON=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('message','') if 'message' in d else '')" 2>/dev/null)

if [ "$APPROVED" = "True" ]; then
  DECISION="allow"
  DECISION_REASON="Approved from phone"
else
  DECISION="deny"
  DECISION_REASON="${REASON:-Denied from phone}"
fi

# Build response
ESCAPED_REASON=$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$DECISION_REASON")
if [ "$FIRST_FIRE" = "true" ]; then
  CTX=$(additional_context)
  echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"${DECISION}\",\"permissionDecisionReason\":${ESCAPED_REASON},\"additionalContext\":\"${CTX}\"}}"
else
  echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"${DECISION}\",\"permissionDecisionReason\":${ESCAPED_REASON}}}"
fi
exit 0
