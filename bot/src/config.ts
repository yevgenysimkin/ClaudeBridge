import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Agent / Channel Configuration ---

export interface AgentConfig {
  id: string;
  name: string;
  cwd: string;
}

// --- Environment Config ---

export interface EnvConfig {
  relayUrl: string;
  relayAuthToken: string;
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
    relayUrl: requireEnv("RELAY_URL"),
    relayAuthToken: requireEnv("RELAY_AUTH_TOKEN"),
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
    };
  });
}
