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
