// --- Environment Config ---
function requireEnv(key) {
    const value = process.env[key];
    if (!value) {
        throw new Error(`Missing required environment variable: ${key}`);
    }
    return value;
}
export function loadEnvConfig() {
    return {
        relayUrl: requireEnv("RELAY_URL"),
        relayAuthToken: requireEnv("RELAY_AUTH_TOKEN"),
    };
}
//# sourceMappingURL=config.js.map