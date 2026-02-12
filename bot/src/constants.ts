/**
 * ClaudeBridge — All magic values in one place.
 * Change it once, it changes everywhere. 🍩
 */

// --- Matrix Room Naming ---
export const ROOM_PREFIX = "claude";
export const OPS_ROOM_ALIAS = `${ROOM_PREFIX}-ops`;
export const AGENT_ROOM_ALIAS_PREFIX = `${ROOM_PREFIX}-agent-`;

// --- Matrix Room Display ---
export const OPS_ROOM_NAME = "Claude Ops";
export const AGENT_ROOM_NAME_PREFIX = "Agent: ";

// --- Message Formatting ---
export const MAX_OUTPUT_LINES = 100;
export const MAX_MESSAGE_LENGTH = 32_000;
export const TRUNCATION_NOTICE = `\n\n--- (truncated at ${MAX_OUTPUT_LINES} lines) ---`;

// --- Agent Session Defaults ---
export const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";
export const DEFAULT_MAX_TURNS = 50;
export const DEFAULT_MAX_BUDGET_USD = 5.0;

// --- Timeouts (ms) ---
export const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes to respond to a permission prompt
export const MATRIX_SYNC_INTERVAL_MS = 3_000;
export const AGENT_STARTUP_DELAY_MS = 1_000;

// --- Permission Prompt Formatting ---
export const PERMISSION_EMOJI = "🔒";
export const APPROVED_EMOJI = "✅";
export const DENIED_EMOJI = "❌";
export const TOOL_USE_EMOJI = "🔧";
export const RESULT_SUCCESS_EMOJI = "✅";
export const RESULT_ERROR_EMOJI = "💥";
export const STATUS_EMOJI = "📊";
export const COST_EMOJI = "💰";

// --- Commands ---
export const COMMAND_PREFIX = "!";
