/**
 * ANSI escape code utilities and permission prompt detection.
 */
/** Strip ANSI escape codes from terminal output. */
export declare function stripAnsi(text: string): string;
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
export declare function detectPermission(data: string, preStripped?: boolean): PermissionInfo;
/** Check if terminal output contains a permission prompt (backward compat). */
export declare function isPermissionPrompt(data: string): boolean;
//# sourceMappingURL=ansi.d.ts.map