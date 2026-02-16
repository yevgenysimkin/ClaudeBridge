/**
 * ANSI escape code utilities and permission prompt detection.
 */
const DEBUG = !!process.env.DEBUG_ANSI;
function debugLog(msg) {
    if (DEBUG) {
        process.stderr.write(`[ansi-debug] ${msg}\n`);
    }
}
// Matches ANSI escape sequences (CSI, OSC, etc.)
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]|\x1b[=>]|\x1b\[[\?]?[0-9;]*[hl]/g;
/** Strip ANSI escape codes from terminal output. */
export function stripAnsi(text) {
    return text.replace(ANSI_RE, "");
}
/**
 * Permission/interactive prompt patterns from Claude Code.
 * These fire when Claude Code is asking the user to approve a tool use
 * or answer an interactive question (AskUserQuestion, etc.).
 */
const PERMISSION_PATTERNS = [
    /Do you want to proceed/i,
    /Do you want to make this/i,
    /Do you want to allow/i,
    /Do you want to run/i,
    /Allow .+ to/i,
    /\[Y\/n\]/,
    /\[y\/N\]/,
    /Press Enter to continue/i,
    /Want to execute/i,
    /Run this command/i,
    /^\s*(?:approve|deny)\s*$/im, // Only match standalone approve/deny lines (not in prose)
    /Allow once/i,
    /Allow always/i,
    /❯\s*\d+\.\s/, // Multi-option prompt indicator (cursor on numbered option)
    /^\?\s+.+/m, // AskUserQuestion: line starting with "? "
];
/**
 * Per-line regex to extract numbered options from Claude Code prompts.
 * Matches lines like "❯ 1. Yes", "  2. Yes, allow all...", "  3. No"
 * The ❯ cursor indicator is optional (only present on the selected item).
 */
const LINE_OPTION_RE = /^\s*(?:❯\s*)?(\d+)\.\s+(.+)$/;
/**
 * Parse numbered options from ANSI-stripped terminal text.
 * Splits into lines and matches each independently — no cross-line regex issues.
 */
function parseOptions(clean) {
    const options = [];
    const lines = clean.split(/\r?\n/);
    for (const line of lines) {
        const m = LINE_OPTION_RE.exec(line);
        if (m) {
            const label = m[2].trim();
            if (label.length > 0) {
                options.push({ number: m[1], label });
            }
        }
        debugLog(`line: ${JSON.stringify(line)} → ${m ? `option ${m[1]}` : "no match"}`);
    }
    return options;
}
/**
 * Detect permission/interactive prompts and parse any numbered options.
 * Returns both a detection flag and structured option data.
 *
 * Detection triggers if a known pattern matches OR if 2+ numbered options
 * are found (the options themselves are evidence of an interactive prompt).
 */
export function detectPermission(data) {
    const clean = stripAnsi(data);
    const options = parseOptions(clean);
    const patternMatch = PERMISSION_PATTERNS.some((p) => p.test(clean));
    const hasOptions = options.length >= 2;
    const detected = patternMatch || hasOptions;
    if (!detected) {
        return { detected: false, options: [] };
    }
    debugLog(`Detected prompt: patternMatch=${patternMatch}, options=${JSON.stringify(options)}`);
    return { detected: true, options };
}
/** Check if terminal output contains a permission prompt (backward compat). */
export function isPermissionPrompt(data) {
    return detectPermission(data).detected;
}
//# sourceMappingURL=ansi.js.map