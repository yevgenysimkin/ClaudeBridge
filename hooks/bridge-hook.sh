#!/usr/bin/env bash
#
# ClaudeBridge PreToolUse hook.
# Receives tool use info on stdin, forwards to the watcher's local HTTP server,
# blocks until the user responds from their phone, returns the decision.
#
# Install: add to ~/.claude/hooks.json or .claude/hooks.json:
# {
#   "hooks": {
#     "PreToolUse": [{
#       "type": "command",
#       "command": "/path/to/ClaudeBridge/hooks/bridge-hook.sh"
#     }]
#   }
# }

WATCHER_URL="http://127.0.0.1:9876"

# Read the hook input from stdin
INPUT=$(cat)

# Extract tool name and input from the hook payload
TOOL_NAME=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_name','unknown'))" 2>/dev/null)
TOOL_INPUT=$(echo "$INPUT" | python3 -c "import sys,json; print(json.dumps(d.get('tool_input',{})) if (d:=json.load(sys.stdin)) else '{}')" 2>/dev/null)

# Generate a unique request ID
REQUEST_ID="perm-$(date +%s)-$$"

# Determine channel from CLAUDE_BRIDGE_CHANNEL env var (set per-project)
CHANNEL="${CLAUDE_BRIDGE_CHANNEL:-default}"

# Send to watcher and wait for response (blocking curl, 5 min timeout)
RESPONSE=$(/usr/bin/curl -s --max-time 300 \
  -X POST "${WATCHER_URL}/permission" \
  -H "Content-Type: application/json" \
  -d "{\"channel\":\"${CHANNEL}\",\"requestId\":\"${REQUEST_ID}\",\"toolName\":\"${TOOL_NAME}\",\"toolInput\":${TOOL_INPUT}}")

# Parse the response
APPROVED=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('approved', False))" 2>/dev/null)
MESSAGE=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('message','') if 'message' in d else '')" 2>/dev/null)

if [ "$APPROVED" = "True" ]; then
  echo '{"decision":"approve"}'
else
  if [ -n "$MESSAGE" ]; then
    echo "{\"decision\":\"deny\",\"reason\":\"${MESSAGE}\"}"
  else
    echo '{"decision":"deny","reason":"Denied from phone"}'
  fi
fi
