import "dotenv/config";
import { loadEnvConfig, loadAgentConfigs } from "./config.js";
import { BridgeMatrixClient } from "./matrix-client.js";
import { AgentManager } from "./agent-manager.js";
import { handleOpsCommand } from "./commands.js";

async function main(): Promise<void> {
  console.log("ClaudeBridge starting...");

  // --- Load configuration ---
  const envConfig = loadEnvConfig();
  const agentConfigs = loadAgentConfigs();

  console.log(`[config] Homeserver: ${envConfig.matrixHomeserverUrl}`);
  console.log(`[config] Bot user: ${envConfig.matrixBotUser}`);
  console.log(`[config] Admin user: ${envConfig.matrixAdminUser}`);
  console.log(`[config] Model: ${envConfig.claudeModel}`);
  console.log(`[config] Agents: ${agentConfigs.map((a) => a.id).join(", ") || "(none)"}`);

  // --- Initialize Matrix client ---
  const matrix = new BridgeMatrixClient(envConfig);

  // --- Initialize Agent Manager ---
  const manager = new AgentManager(matrix, envConfig);

  // --- Wire Matrix messages to manager + command handler ---
  matrix.onMessage(async (roomId, sender, body) => {
    // Only respond to admin
    if (sender !== envConfig.matrixAdminUser) return;

    const opsRoomId = matrix.getOpsRoomId();

    // Ops room: try command first, then fall through to manager
    if (roomId === opsRoomId) {
      const handled = await handleOpsCommand(
        body,
        manager,
        (text) => matrix.sendText(roomId, text),
      );
      if (handled) return;
    }

    // Route to manager (handles agent room messages + ops room fallback)
    await manager.handleMessage(roomId, sender, body);
  });

  // --- Start Matrix sync ---
  await matrix.start();

  // --- Initialize rooms and agents ---
  await manager.initialize(agentConfigs);

  console.log("ClaudeBridge is running.");

  // --- Graceful shutdown ---
  const shutdown = () => {
    console.log("\nShutting down...");
    matrix.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
