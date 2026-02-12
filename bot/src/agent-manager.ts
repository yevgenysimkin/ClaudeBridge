import { AgentSession, type PermissionResolveResult } from "./agent-session.js";
import { BridgeMatrixClient } from "./matrix-client.js";
import { AgentConfig, EnvConfig } from "./config.js";
import {
  formatPermissionRequest,
  formatUserQuestion,
  formatPermissionApproved,
  formatPermissionDenied,
  formatToolUse,
  formatAssistantText,
  formatResult,
  formatStatus,
} from "./formatter.js";

/**
 * Manages all agent sessions and routes messages between Matrix and the SDK.
 *
 * Responsibilities:
 * - Lifecycle: start/stop/restart agents
 * - Wires agent events → Matrix room messages
 * - Routes Matrix room messages → correct agent session
 * - Handles permission approval/denial flow
 */
export class AgentManager {
  private sessions = new Map<string, AgentSession>();
  private agentConfigs = new Map<string, AgentConfig>();
  private agentRoomIds = new Map<string, string>(); // agentId → roomId
  private roomToAgent = new Map<string, string>();   // roomId → agentId
  private matrix: BridgeMatrixClient;
  private envConfig: EnvConfig;
  private opsRoomId: string | undefined;

  constructor(matrix: BridgeMatrixClient, envConfig: EnvConfig) {
    this.matrix = matrix;
    this.envConfig = envConfig;
  }

  /** Initialize: create rooms, register configs, set up routing. */
  async initialize(configs: AgentConfig[]): Promise<void> {
    // Store configs
    for (const config of configs) {
      this.agentConfigs.set(config.id, config);
    }

    // Create ops room
    this.opsRoomId = await this.matrix.ensureOpsRoom();
    await this.matrix.sendNotice(this.opsRoomId, `ClaudeBridge online. ${configs.length} agent(s) configured.`);

    // Create agent rooms
    for (const config of configs) {
      const roomId = await this.matrix.ensureAgentRoom(config.id, config.name);
      this.agentRoomIds.set(config.id, roomId);
      this.roomToAgent.set(roomId, config.id);
    }

    // Auto-start agents that have autoStart enabled
    for (const config of configs) {
      if (config.autoStart) {
        await this.matrix.sendNotice(
          this.agentRoomIds.get(config.id)!,
          `Agent ${config.name} is configured for auto-start. Send a message to begin.`,
        );
      }
    }
  }

  /**
   * Handle an incoming Matrix message from any room.
   * Routes to the appropriate handler based on room.
   */
  async handleMessage(roomId: string, sender: string, body: string): Promise<void> {
    // Only respond to the admin user
    if (sender !== this.envConfig.matrixAdminUser) return;

    const agentId = this.roomToAgent.get(roomId);

    if (agentId) {
      await this.handleAgentRoomMessage(agentId, body);
    } else if (roomId === this.opsRoomId) {
      await this.handleOpsRoomMessage(body);
    }
    // Ignore messages in unknown rooms
  }

  /** Start an agent session. */
  async startAgent(agentId: string): Promise<boolean> {
    const config = this.agentConfigs.get(agentId);
    if (!config) {
      await this.notifyOps(`Unknown agent: ${agentId}`);
      return false;
    }

    if (this.sessions.has(agentId) && this.sessions.get(agentId)!.isRunning) {
      await this.notifyOps(`Agent ${config.name} is already running.`);
      return false;
    }

    const session = new AgentSession(config);
    this.sessions.set(agentId, session);
    this.wireSessionEvents(agentId, session);

    await this.notifyOps(`Agent ${config.name} started.`);
    return true;
  }

  /** Stop an agent session. */
  async stopAgent(agentId: string): Promise<boolean> {
    const session = this.sessions.get(agentId);
    if (!session) {
      await this.notifyOps(`No active session for agent: ${agentId}`);
      return false;
    }

    session.stop();
    const config = this.agentConfigs.get(agentId);
    await this.notifyOps(`Agent ${config?.name || agentId} stopped.`);
    return true;
  }

  /** Restart an agent session (stop + clear + notify). */
  async restartAgent(agentId: string): Promise<boolean> {
    const session = this.sessions.get(agentId);
    if (session) {
      session.reset();
      this.sessions.delete(agentId);
    }

    const config = this.agentConfigs.get(agentId);
    if (!config) {
      await this.notifyOps(`Unknown agent: ${agentId}`);
      return false;
    }

    await this.notifyOps(`Agent ${config.name} restarted. Send a message to begin a new session.`);
    return true;
  }

  /** Get status of one or all agents. */
  async reportStatus(agentId?: string): Promise<void> {
    if (agentId) {
      const session = this.sessions.get(agentId);
      const config = this.agentConfigs.get(agentId);
      if (!config) {
        await this.notifyOps(`Unknown agent: ${agentId}`);
        return;
      }

      const status = session
        ? session.getStatus()
        : { id: agentId, name: config.name, running: false, totalCostUsd: 0, totalTurns: 0, pendingPermissions: 0 };

      const formatted = formatStatus(status);
      await this.matrix.sendHtml(this.opsRoomId!, formatted.body, formatted.html);
    } else {
      // Report all agents
      for (const [id, config] of this.agentConfigs) {
        const session = this.sessions.get(id);
        const status = session
          ? session.getStatus()
          : { id, name: config.name, running: false, totalCostUsd: 0, totalTurns: 0, pendingPermissions: 0 };

        const formatted = formatStatus(status);
        await this.matrix.sendHtml(this.opsRoomId!, formatted.body, formatted.html);
      }
    }
  }

  /** List all configured agents. */
  async listAgents(): Promise<void> {
    const lines: string[] = ["Configured agents:"];
    for (const [id, config] of this.agentConfigs) {
      const session = this.sessions.get(id);
      const state = session?.isRunning ? "🟢" : "⚫";
      lines.push(`  ${state} ${config.name} (${id}) — ${config.cwd}`);
    }
    await this.matrix.sendText(this.opsRoomId!, lines.join("\n"));
  }

  /** Report cost for one or all agents. */
  async reportCost(agentId?: string): Promise<void> {
    if (agentId) {
      const session = this.sessions.get(agentId);
      const cost = session?.cost ?? 0;
      await this.matrix.sendText(this.opsRoomId!, `💰 ${agentId}: $${cost.toFixed(4)}`);
    } else {
      let total = 0;
      const lines: string[] = ["Cost breakdown:"];
      for (const [id] of this.agentConfigs) {
        const session = this.sessions.get(id);
        const cost = session?.cost ?? 0;
        total += cost;
        lines.push(`  ${id}: $${cost.toFixed(4)}`);
      }
      lines.push(`  Total: $${total.toFixed(4)}`);
      await this.matrix.sendText(this.opsRoomId!, lines.join("\n"));
    }
  }

  /** Approve all pending permissions across all agents. */
  async approveAll(): Promise<void> {
    let count = 0;
    for (const [, session] of this.sessions) {
      while (session.hasPendingPermission) {
        session.resolveLatestPermission({ approved: true });
        count++;
      }
    }
    await this.notifyOps(`Approved ${count} pending permission(s).`);
  }

  // --- Private: Message Routing ---

  /** Handle a message in an agent's room. */
  private async handleAgentRoomMessage(agentId: string, body: string): Promise<void> {
    const session = this.sessions.get(agentId);

    // Check if this is a permission response
    if (session?.hasPendingPermission) {
      const lowerBody = body.trim().toLowerCase();

      if (lowerBody === "y" || lowerBody === "yes") {
        const toolName = session.latestPendingToolName || "unknown";
        session.resolveLatestPermission({ approved: true });
        const formatted = formatPermissionApproved(toolName);
        await this.sendToAgentRoom(agentId, formatted.body, formatted.html);
        return;
      }

      if (lowerBody === "n" || lowerBody === "no") {
        const toolName = session.latestPendingToolName || "unknown";
        session.resolveLatestPermission({ approved: false });
        const formatted = formatPermissionDenied(toolName);
        await this.sendToAgentRoom(agentId, formatted.body, formatted.html);
        return;
      }

      // Any other text: could be an answer to AskUserQuestion, or a denial with reason
      if (session.latestPendingToolName === "AskUserQuestion") {
        session.resolveLatestPermission({ approved: true, answer: body.trim() });
        return;
      }

      // Treat as denial with reason
      const toolName = session.latestPendingToolName || "unknown";
      session.resolveLatestPermission({ approved: false, message: body.trim() });
      const formatted = formatPermissionDenied(toolName, body.trim());
      await this.sendToAgentRoom(agentId, formatted.body, formatted.html);
      return;
    }

    // Not a permission response — it's a new message for the agent
    const config = this.agentConfigs.get(agentId);
    if (!config) return;

    // Ensure session exists
    if (!session) {
      await this.startAgent(agentId);
    }

    const activeSession = this.sessions.get(agentId)!;

    // If session is already running (processing a previous query), queue this
    if (activeSession.isRunning) {
      await this.sendToAgentRoom(agentId,
        "⏳ Agent is busy processing. Message queued — it will be sent when the current task completes.",
        "<i>⏳ Agent is busy processing. Message queued — it will be sent when the current task completes.</i>",
      );
      // TODO: implement proper message queuing
      return;
    }

    // Send the message to the agent
    activeSession.sendMessage(body, this.envConfig.claudeModel);
  }

  /** Handle a message in the ops room. */
  private async handleOpsRoomMessage(body: string): Promise<void> {
    // Ops room messages are handled by the command parser in index.ts
    // This is a fallback for non-command messages
    if (!body.startsWith("!")) {
      await this.matrix.sendText(this.opsRoomId!, "Use !help for available commands.");
    }
  }

  // --- Private: Event Wiring ---

  /** Wire an agent session's events to Matrix rooms. */
  private wireSessionEvents(agentId: string, session: AgentSession): void {
    session.on("started", ({ sessionId }) => {
      this.sendToAgentRoom(agentId,
        `Session started: ${sessionId}`,
        `<i>Session started: <code>${sessionId}</code></i>`,
      );
    });

    session.on("text", ({ text }) => {
      const formatted = formatAssistantText(text);
      this.sendToAgentRoom(agentId, formatted.body, formatted.html);
    });

    session.on("tool-use", ({ toolName, input }) => {
      const formatted = formatToolUse(toolName, input);
      this.sendToAgentRoomNotice(agentId, formatted.body, formatted.html);
    });

    session.on("permission-request", ({ toolName, input }) => {
      const formatted = formatPermissionRequest(toolName, input);
      this.sendToAgentRoom(agentId, formatted.body, formatted.html);
    });

    session.on("user-question", ({ questions }) => {
      const formatted = formatUserQuestion(questions);
      this.sendToAgentRoom(agentId, formatted.body, formatted.html);
    });

    session.on("result", (result) => {
      const formatted = formatResult(result);
      this.sendToAgentRoom(agentId, formatted.body, formatted.html);
    });

    session.on("error", (err) => {
      this.sendToAgentRoom(agentId,
        `💥 Error: ${err.message}`,
        `<b>💥 Error:</b> <pre>${err.message}</pre>`,
      );
    });

    session.on("stopped", () => {
      this.sendToAgentRoomNotice(agentId,
        "Session stopped.",
        "<i>Session stopped.</i>",
      );
    });
  }

  // --- Private: Helpers ---

  private async sendToAgentRoom(agentId: string, body: string, html: string): Promise<void> {
    const roomId = this.agentRoomIds.get(agentId);
    if (roomId) {
      await this.matrix.sendHtml(roomId, body, html);
    }
  }

  private async sendToAgentRoomNotice(agentId: string, body: string, html: string): Promise<void> {
    const roomId = this.agentRoomIds.get(agentId);
    if (roomId) {
      await this.matrix.sendHtmlNotice(roomId, body, html);
    }
  }

  private async notifyOps(text: string): Promise<void> {
    if (this.opsRoomId) {
      await this.matrix.sendText(this.opsRoomId, text);
    }
  }
}
