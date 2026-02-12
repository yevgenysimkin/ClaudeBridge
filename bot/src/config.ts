import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL, DEFAULT_MAX_TURNS, DEFAULT_MAX_BUDGET_USD } from "./constants.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Agent Configuration ---

export interface AgentConfig {
  id: string;
  name: string;
  cwd: string;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  systemPrompt?: string;
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  autoStart?: boolean;
}

// --- Environment Config ---

export interface EnvConfig {
  matrixHomeserverUrl: string;
  matrixBotUser: string;
  matrixBotAccessToken: string;
  matrixAdminUser: string;
  anthropicApiKey: string;
  claudeModel: string;
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export function loadEnvConfig(): EnvConfig {
  return {
    matrixHomeserverUrl: requireEnv("MATRIX_HOMESERVER_URL"),
    matrixBotUser: requireEnv("MATRIX_BOT_USER"),
    matrixBotAccessToken: requireEnv("MATRIX_BOT_ACCESS_TOKEN"),
    matrixAdminUser: requireEnv("MATRIX_ADMIN_USER"),
    anthropicApiKey: requireEnv("ANTHROPIC_API_KEY"),
    claudeModel: process.env.CLAUDE_MODEL || DEFAULT_MODEL,
  };
}

export function loadAgentConfigs(): AgentConfig[] {
  const configPath = resolve(__dirname, "../config/agents.json");
  if (!existsSync(configPath)) {
    console.warn(`[config] No agents.json found at ${configPath}, starting with no agents.`);
    return [];
  }

  const raw = readFileSync(configPath, "utf-8");
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed.agents)) {
    throw new Error("agents.json must contain an 'agents' array.");
  }

  return parsed.agents.map((a: Record<string, unknown>) => {
    if (!a.id || typeof a.id !== "string") throw new Error("Each agent must have a string 'id'.");
    if (!a.cwd || typeof a.cwd !== "string") throw new Error(`Agent '${a.id}' must have a string 'cwd'.`);

    return {
      id: a.id,
      name: (a.name as string) || a.id,
      cwd: a.cwd as string,
      model: (a.model as string) || undefined,
      maxTurns: (a.maxTurns as number) || DEFAULT_MAX_TURNS,
      maxBudgetUsd: (a.maxBudgetUsd as number) || DEFAULT_MAX_BUDGET_USD,
      systemPrompt: (a.systemPrompt as string) || undefined,
      permissionMode: (a.permissionMode as AgentConfig["permissionMode"]) || "default",
      autoStart: Boolean(a.autoStart),
    };
  });
}
