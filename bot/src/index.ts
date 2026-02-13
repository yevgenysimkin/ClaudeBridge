import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../.env") });

import { loadEnvConfig, loadAgentConfigs } from "./config.js";
import { RelayClient } from "./relay-client.js";
import { AgentManager } from "./agent-manager.js";

async function main(): Promise<void> {
  console.log("ClaudeBridge Bot starting...");

  const envConfig = loadEnvConfig();
  const agentConfigs = loadAgentConfigs();

  console.log(`[config] Relay: ${envConfig.relayUrl}`);
  console.log(`[config] Model: ${envConfig.claudeModel}`);
  console.log(`[config] Agents: ${agentConfigs.map((a) => a.id).join(", ") || "(none)"}`);

  // Connect to relay
  const relay = new RelayClient(envConfig.relayUrl, envConfig.relayAuthToken);
  const manager = new AgentManager(relay, envConfig);

  // Route relay messages to the manager
  relay.onMessage(async (msg) => {
    await manager.handleRelayMessage(msg);
  });

  // Connect and wait for auth
  relay.connect();

  // Wait for connection before initializing
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (relay.isConnected) {
        clearInterval(check);
        resolve();
      }
    }, 200);
  });

  // Initialize agents
  await manager.initialize(agentConfigs);
  console.log("ClaudeBridge Bot is running.");

  // Graceful shutdown
  const shutdown = () => {
    console.log("\nShutting down...");
    relay.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
