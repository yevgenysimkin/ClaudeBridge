/**
 * CLI Orchestrator — Headless Claude Code agent via `claude` subprocess.
 *
 * Spawns `claude` with --input-format stream-json / --output-format stream-json
 * to get structured JSONL over stdin/stdout. Uses the user's MAX plan auth
 * (no API key required). Both surfaces (Chromattica desktop, Android phone)
 * consume structured events — no ANSI, no PTY, no regex parsing.
 *
 * Usage:
 *   node dist/orchestrator.js [--prompt "initial prompt"] [--channel <id>] [--resume]
 */
export {};
//# sourceMappingURL=orchestrator.d.ts.map