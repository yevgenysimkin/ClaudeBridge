/**
 * ANSI escape code utilities and permission prompt detection.
 */

const DEBUG = !!process.env.DEBUG_ANSI;

/** Only scan the bottom N lines for permission patterns (prevents stale content false positives). */
const PERMISSION_SCAN_LINES = 15;

/**
 * Debug logging for ANSI/permission detection.
 * Gated by DEBUG_ANSI=1 env var for verbose line-by-line output.
 * Option parsing always logs to the proxy log file (not stderr) regardless of DEBUG_ANSI,
 * because the builtin-filter bug (2026-02-16) needs visibility without noise on the terminal.
 */
function debugLog(msg: string): void {
  if (DEBUG) {
    process.stderr.write(`[ansi-debug] ${msg}\n`);
  }
}

/** Always-on logging for option parsing — writes to proxy log file via pty-proxy's log(). */
function optionLog(msg: string): void {
  // This gets picked up by the log() function in pty-proxy.ts via the flushOutput caller.
  // Since we can't import log() here (circular), we write to stderr with a tag that
  // pty-proxy can grep for, OR we just use process.stderr for now.
  process.stderr.write(`[ansi-options] ${msg}\n`);
}

// Matches ANSI escape sequences (CSI, OSC, etc.)
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]|\x1b[=>]|\x1b\[[\?]?[0-9;]*[hl]/g;

/** Strip ANSI escape codes from terminal output. */
export function stripAnsi(text: string): string {
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
  /^\s*(?:approve|deny)\s*$/im,  // Only match standalone approve/deny lines (not in prose)
  /Allow once/i,
  /Allow always/i,
  /❯\s*\d+\.\s/,          // Multi-option prompt indicator (cursor on numbered option)
  /^\?\s+.+/m,             // AskUserQuestion: line starting with "? "
];

/** Parsed permission option from Claude Code's numbered prompt. */
export interface PermissionOption {
  number: string;
  label: string;
}

/** Result of permission prompt detection. */
export interface PermissionInfo {
  detected: boolean;
  options: PermissionOption[];
}

/**
 * Per-line regex to extract numbered options from Claude Code prompts.
 * Matches lines like "❯ 1. Yes", "  2. Yes, allow all...", "  3. No"
 * The ❯ cursor indicator is optional (only present on the selected item).
 */
const LINE_OPTION_RE = /^\s*(?:❯\s*)?(\d+)\.\s+(.+)$/;

/**
 * Claude Code's built-in UI options that appear in every AskUserQuestion prompt.
 * These are navigation chrome, not actual choices — filter them out so the phone
 * only shows real options.
 *
 * IMPORTANT (2026-02-16): Exact-match was failing — the vterm may render labels
 * with trailing whitespace, zero-width chars, or Unicode punctuation that survives
 * trim(). Using substring matching instead of exact set lookup.
 * Previous approach (BUILTIN_OPTION_LABELS Set with .has()) did NOT work.
 */
const BUILTIN_OPTION_PATTERNS = [
  /^type\s+something\.?$/,
  /^chat\s+about\s+this\.?$/,
];

/**
 * Parse numbered options from ANSI-stripped terminal text.
 * Splits into lines and matches each independently — no cross-line regex issues.
 * Filters out Claude Code's built-in UI options (e.g. "Type something", "Chat about this").
 *
 * DEBUG BREADCRUMB (2026-02-16): Phone was showing 6 buttons for 4-option AskUserQuestion
 * prompts — options 5 ("Type something.") and 6 ("Chat about this") were NOT being filtered.
 * Added hex-dump logging to diagnose whether the vterm renders labels with unexpected
 * characters (Unicode, trailing whitespace, etc.) that prevent exact-match filtering.
 * Enable with DEBUG_ANSI=1. Check /tmp/claudebridge-proxy.log for output.
 */
function parseOptions(clean: string): PermissionOption[] {
  const options: PermissionOption[] = [];
  const lines = clean.split(/\r?\n/);
  for (const line of lines) {
    const m = LINE_OPTION_RE.exec(line);
    if (m) {
      // Strip any non-printable / zero-width chars the vterm might leave behind
      const label = m[2].trim().replace(/[\x00-\x1f\u200b\u200c\u200d\ufeff]/g, "");
      const lowerLabel = label.toLowerCase();
      const isBuiltin = BUILTIN_OPTION_PATTERNS.some(p => p.test(lowerLabel));

      // Always log option parsing (not just debug) — this is the #1 pain point.
      // Shows exact bytes so we can catch Unicode/whitespace mismatches.
      const hexDump = [...label].map(c => `${c}(0x${c.charCodeAt(0).toString(16)})`).join("");
      optionLog(`option ${m[1]}: label=${JSON.stringify(label)} lower=${JSON.stringify(lowerLabel)} isBuiltin=${isBuiltin} hex=[${hexDump}]`);

      if (label.length > 0 && !isBuiltin) {
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
 *
 * @param data - Terminal text to scan
 * @param preStripped - If true, skip ANSI stripping (caller already provided clean text,
 *                      e.g. from a virtual terminal's rendered screen buffer)
 */
export function detectPermission(data: string, preStripped = false): PermissionInfo {
  const clean = preStripped ? data : stripAnsi(data);

  // Only scan the bottom portion of the screen to avoid stale permission patterns
  const allLines = clean.split("\n");
  const scanRegion = allLines.slice(-PERMISSION_SCAN_LINES).join("\n");

  const patternMatch = PERMISSION_PATTERNS.some((p) => p.test(scanRegion));

  if (!patternMatch) {
    return { detected: false, options: [] };
  }

  // Only parse numbered options when a known permission pattern matched —
  // otherwise regular numbered lists in Claude's prose trigger false positives.
  // Scope to the same bottom region to avoid picking up stale options.
  const options = parseOptions(scanRegion);

  debugLog(`Detected prompt: patternMatch=${patternMatch}, options=${JSON.stringify(options)}`);
  return { detected: true, options };
}

/** Check if terminal output contains a permission prompt (backward compat). */
export function isPermissionPrompt(data: string): boolean {
  return detectPermission(data).detected;
}
