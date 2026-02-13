import { AgentSession } from "./agent-session.js";
import { RelayClient } from "./relay-client.js";
import { AgentConfig, EnvConfig } from "./config.js";

/**
 * Manages all agent sessions and routes messages between the relay and the SDK.
 */
export class AgentManager {
  private sessions = new Map<string, AgentSession>();
  private agentConfigs = new Map<string, AgentConfig>();
  private relay: RelayClient;
  private envConfig: EnvConfig;

  constructor(relay: RelayClient, envConfig: EnvConfig) {
    this.relay = relay;
    this.envConfig = envConfig;
  }

  /** Initialize: register channels with relay, set up routing. */
  async initialize(configs: AgentConfig[]): Promise<void> {
    for (const config of configs) {
      this.agentConfigs.set(config.id, config);
    }

    // Register channels with the relay
    this.relay.registerChannel("ops", "Ops", "idle");
    for (const config of configs) {
      this.relay.registerChannel(config.id, config.name, "idle");
    }

    this.relay.sendBotMessage("ops", `ClaudeBridge online. ${configs.length} agent(s) configured.`);
  }

  /** Handle an incoming message from the relay. */
  async handleRelayMessage(msg: Record<string, unknown>): Promise<void> {
    // Only handle messages from users (sent via the app)
    if (msg.type === "message") {
      const channel = msg.channel as string;
      const sender = msg.sender as string;
      const content = msg.content as string;

      if (sender !== "user") return;
      if (!content) return;

      if (channel === "ops") {
        await this.handleOpsMessage(content);
      } else if (this.agentConfigs.has(channel)) {
        await this.handleAgentMessage(channel, content);
      }
    }
  }

  /** Start an agent session. */
  async startAgent(agentId: string): Promise<boolean> {
    const config = this.agentConfigs.get(agentId);
    if (!config) {
      this.relay.sendBotMessage("ops", `Unknown agent: ${agentId}`);
      return false;
    }

    if (this.sessions.has(agentId) && this.sessions.get(agentId)!.isRunning) {
      this.relay.sendBotMessage("ops", `Agent ${config.name} is already running.`);
      return false;
    }

    const session = new AgentSession(config);
    this.sessions.set(agentId, session);
    this.wireSessionEvents(agentId, session);
    this.relay.registerChannel(agentId, config.name, "idle");
    this.relay.sendBotMessage("ops", `Agent ${config.name} ready. Send a message in its channel to begin.`);
    return true;
  }

  /** Stop an agent session. */
  async stopAgent(agentId: string): Promise<boolean> {
    const session = this.sessions.get(agentId);
    if (!session) {
      this.relay.sendBotMessage("ops", `No active session for agent: ${agentId}`);
      return false;
    }
    session.stop();
    this.relay.registerChannel(agentId, this.agentConfigs.get(agentId)?.name || agentId, "stopped");
    this.relay.sendBotMessage("ops", `Agent ${agentId} stopped.`);
    return true;
  }

  /** Restart an agent session. */
  async restartAgent(agentId: string): Promise<boolean> {
    const session = this.sessions.get(agentId);
    if (session) {
      session.reset();
      this.sessions.delete(agentId);
    }
    const config = this.agentConfigs.get(agentId);
    if (!config) {
      this.relay.sendBotMessage("ops", `Unknown agent: ${agentId}`);
      return false;
    }
    this.relay.registerChannel(agentId, config.name, "idle");
    this.relay.sendBotMessage("ops", `Agent ${config.name} restarted.`);
    return true;
  }

  /** List all agents. */
  listAgents(): void {
    const lines: string[] = ["Configured agents:"];
    for (const [id, config] of this.agentConfigs) {
      const session = this.sessions.get(id);
      const state = session?.isRunning ? "🟢" : "⚫";
      lines.push(`  ${state} ${config.name} (${id}) — ${config.cwd}`);
    }
    this.relay.sendBotMessage("ops", lines.join("\n"));
  }

  /** Report status. */
  reportStatus(agentId?: string): void {
    if (agentId) {
      const session = this.sessions.get(agentId);
      const config = this.agentConfigs.get(agentId);
      if (!config) {
        this.relay.sendBotMessage("ops", `Unknown agent: ${agentId}`);
        return;
      }
      const status = session?.getStatus() || {
        id: agentId, name: config.name, running: false,
        totalCostUsd: 0, totalTurns: 0, pendingPermissions: 0,
      };
      this.relay.sendBotMessage("ops", formatStatus(status));
    } else {
      for (const [id, config] of this.agentConfigs) {
        const session = this.sessions.get(id);
        const status = session?.getStatus() || {
          id, name: config.name, running: false,
          totalCostUsd: 0, totalTurns: 0, pendingPermissions: 0,
        };
        this.relay.sendBotMessage("ops", formatStatus(status));
      }
    }
  }

  /** Report cost. */
  reportCost(agentId?: string): void {
    if (agentId) {
      const cost = this.sessions.get(agentId)?.cost ?? 0;
      this.relay.sendBotMessage("ops", `💰 ${agentId}: $${cost.toFixed(4)}`);
    } else {
      let total = 0;
      const lines: string[] = ["Cost breakdown:"];
      for (const [id] of this.agentConfigs) {
        const cost = this.sessions.get(id)?.cost ?? 0;
        total += cost;
        lines.push(`  ${id}: $${cost.toFixed(4)}`);
      }
      lines.push(`  Total: $${total.toFixed(4)}`);
      this.relay.sendBotMessage("ops", lines.join("\n"));
    }
  }

  /** Approve all pending permissions. */
  approveAll(): void {
    let count = 0;
    for (const [, session] of this.sessions) {
      while (session.hasPendingPermission) {
        session.resolveLatestPermission({ approved: true });
        count++;
      }
    }
    this.relay.sendBotMessage("ops", `Approved ${count} pending permission(s).`);
  }

  // --- Private ---

  private async handleAgentMessage(agentId: string, body: string): Promise<void> {
    const session = this.sessions.get(agentId);

    // Check if this is a permission response
    if (session?.hasPendingPermission) {
      const lower = body.trim().toLowerCase();
      if (lower === "y" || lower === "yes") {
        session.resolveLatestPermission({ approved: true });
        return;
      }
      if (lower === "n" || lower === "no") {
        session.resolveLatestPermission({ approved: false });
        return;
      }
      // Could be an answer to AskUserQuestion
      if (session.latestPendingToolName === "AskUserQuestion") {
        session.resolveLatestPermission({ approved: true, answer: body.trim() });
        return;
      }
      // Treat as denial with reason
      session.resolveLatestPermission({ approved: false, message: body.trim() });
      return;
    }

    // New message for the agent
    if (!session) {
      await this.startAgent(agentId);
    }

    const activeSession = this.sessions.get(agentId)!;
    if (activeSession.isRunning) {
      this.relay.sendBotMessage(agentId, "⏳ Agent is busy. Message will be sent when current task completes.");
      return;
    }

    this.relay.registerChannel(agentId, this.agentConfigs.get(agentId)?.name || agentId, "running");
    activeSession.sendMessage(body, this.envConfig.claudeModel);
  }

  private async handleOpsMessage(body: string): Promise<void> {
    if (!body.startsWith("!")) {
      this.relay.sendBotMessage("ops", "Use !help for available commands.");
      return;
    }

    const parts = body.slice(1).split(/\s+/);
    const cmd = parts[0]?.toLowerCase();
    const arg = parts[1];

    switch (cmd) {
      case "start": arg ? this.startAgent(arg) : this.relay.sendBotMessage("ops", "Usage: !start <agent-id>"); break;
      case "stop": arg ? this.stopAgent(arg) : this.relay.sendBotMessage("ops", "Usage: !stop <agent-id>"); break;
      case "restart": arg ? this.restartAgent(arg) : this.relay.sendBotMessage("ops", "Usage: !restart <agent-id>"); break;
      case "status": this.reportStatus(arg); break;
      case "agents": this.listAgents(); break;
      case "cost": this.reportCost(arg); break;
      case "approve-all": this.approveAll(); break;
      case "help": this.relay.sendBotMessage("ops", HELP_TEXT); break;
      default: this.relay.sendBotMessage("ops", `Unknown command: !${cmd}`); break;
    }
  }

  private wireSessionEvents(agentId: string, session: AgentSession): void {
    session.on("started", ({ sessionId }) => {
      this.relay.sendBotMessage(agentId, `Session started: ${sessionId}`);
    });

    session.on("text", ({ text }) => {
      this.relay.sendBotMessage(agentId, text);
    });

    session.on("tool-use", ({ toolName, input }) => {
      const summary = summarizeToolInput(toolName, input);
      this.relay.sendBotMessage(agentId, `🔧 ${toolName}\n${summary}`, {
        toolUse: { toolName, summary },
      });
    });

    session.on("permission-request", ({ toolName, input }) => {
      const summary = summarizeToolInput(toolName, input);
      this.relay.sendBotMessage(agentId,
        `🔒 PERMISSION REQUEST\nTool: ${toolName}\n${summary}\n\nReply: y to approve, n to deny`,
        {
          permissionRequest: { requestId: "", toolName, toolInput: input },
          needsAttention: true,
        },
      );
    });

    session.on("user-question", ({ questions }) => {
      let text = "❓ AGENT QUESTION\n";
      for (const q of questions) {
        text += `\n${q.question}\n`;
        for (let i = 0; i < q.options.length; i++) {
          const opt = q.options[i];
          text += `  ${i + 1}. ${opt.label}${opt.description ? ` — ${opt.description}` : ""}\n`;
        }
      }
      text += "\nReply with your choice.";
      this.relay.sendBotMessage(agentId, text, {
        userQuestion: { requestId: "", questions },
        needsAttention: true,
      });
    });

    session.on("result", (result) => {
      const status = result.success ? "✅ Completed" : "💥 Failed";
      let text = status;
      if (result.costUsd !== undefined) text += ` | 💰 $${result.costUsd.toFixed(4)}`;
      if (result.numTurns !== undefined) text += ` | ${result.numTurns} turns`;
      if (result.durationMs !== undefined) text += ` | ${(result.durationMs / 1000).toFixed(1)}s`;
      if (result.text) text += `\n\n${result.text}`;
      if (result.errors?.length) text += `\n\nErrors:\n${result.errors.join("\n")}`;

      this.relay.sendBotMessage(agentId, text, {
        result: {
          success: result.success,
          costUsd: result.costUsd,
          durationMs: result.durationMs,
          numTurns: result.numTurns,
        },
      });
      this.relay.registerChannel(agentId, this.agentConfigs.get(agentId)?.name || agentId, "idle");
    });

    session.on("error", (err) => {
      this.relay.sendBotMessage(agentId, `💥 Error: ${err.message}`);
      this.relay.registerChannel(agentId, this.agentConfigs.get(agentId)?.name || agentId, "idle");
    });

    session.on("stopped", () => {
      this.relay.sendBotMessage(agentId, "Session stopped.");
      this.relay.registerChannel(agentId, this.agentConfigs.get(agentId)?.name || agentId, "stopped");
    });
  }
}

// --- Helpers ---

function formatStatus(s: { id: string; name: string; running: boolean; totalCostUsd: number; totalTurns: number }): string {
  const state = s.running ? "🟢 Running" : "⚫ Stopped";
  return `📊 ${s.name} (${s.id})\nStatus: ${state}\n💰 Cost: $${s.totalCostUsd.toFixed(4)} | Turns: ${s.totalTurns}`;
}

function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  const lower = toolName.toLowerCase();
  if (lower.includes("bash") && input.command) return `$ ${input.command}`;
  if ((lower.includes("edit") || lower.includes("write") || lower.includes("read")) && input.file_path) return `File: ${input.file_path}`;
  if (lower.includes("glob") && input.pattern) return `Pattern: ${input.pattern}`;
  if (lower.includes("grep") && input.pattern) return `Pattern: ${input.pattern}${input.path ? ` in ${input.path}` : ""}`;
  const entries = Object.entries(input).slice(0, 3);
  return entries.map(([k, v]) => {
    const val = typeof v === "string" ? v : JSON.stringify(v);
    return `${k}: ${val.length > 200 ? val.slice(0, 200) + "..." : val}`;
  }).join("\n");
}

const HELP_TEXT = `ClaudeBridge Commands:
!start <agent-id>    — Start an agent session
!stop <agent-id>     — Stop an agent session
!restart <agent-id>  — Restart (clear session + stop)
!status [agent-id]   — Show status
!agents              — List all configured agents
!cost [agent-id]     — Show cost breakdown
!approve-all         — Approve all pending permissions
!help                — Show this help`;
