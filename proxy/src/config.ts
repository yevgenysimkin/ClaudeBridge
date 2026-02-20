// --- Environment Config ---

export interface EnvConfig {
  relayUrl: string;
  relayAuthToken: string;
  model: string;
  permissionMode: string;
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
    model: process.env.CLAUDE_MODEL || "sonnet",
    permissionMode: process.env.PERMISSION_MODE || "default",
  };
}
