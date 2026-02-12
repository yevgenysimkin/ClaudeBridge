import { COMMAND_PREFIX } from "./constants.js";
import { AgentManager } from "./agent-manager.js";

interface ParsedCommand {
  name: string;
  args: string[];
}

/** Parse a command string. Returns undefined if not a command. */
function parseCommand(body: string): ParsedCommand | undefined {
  const trimmed = body.trim();
  if (!trimmed.startsWith(COMMAND_PREFIX)) return undefined;

  const parts = trimmed.slice(COMMAND_PREFIX.length).split(/\s+/);
  const name = parts[0]?.toLowerCase();
  if (!name) return undefined;

  return { name, args: parts.slice(1) };
}

/**
 * Execute a command from the ops room.
 * Returns true if the message was handled as a command.
 */
export async function handleOpsCommand(
  body: string,
  manager: AgentManager,
  sendReply: (text: string) => Promise<void>,
): Promise<boolean> {
  const cmd = parseCommand(body);
  if (!cmd) return false;

  switch (cmd.name) {
    case "start": {
      const agentId = cmd.args[0];
      if (!agentId) {
        await sendReply("Usage: !start <agent-id>");
        return true;
      }
      await manager.startAgent(agentId);
      return true;
    }

    case "stop": {
      const agentId = cmd.args[0];
      if (!agentId) {
        await sendReply("Usage: !stop <agent-id>");
        return true;
      }
      await manager.stopAgent(agentId);
      return true;
    }

    case "restart": {
      const agentId = cmd.args[0];
      if (!agentId) {
        await sendReply("Usage: !restart <agent-id>");
        return true;
      }
      await manager.restartAgent(agentId);
      return true;
    }

    case "status": {
      const agentId = cmd.args[0];
      await manager.reportStatus(agentId);
      return true;
    }

    case "agents": {
      await manager.listAgents();
      return true;
    }

    case "cost": {
      const agentId = cmd.args[0];
      await manager.reportCost(agentId);
      return true;
    }

    case "approve-all": {
      await manager.approveAll();
      return true;
    }

    case "help": {
      await sendReply(HELP_TEXT);
      return true;
    }

    default: {
      await sendReply(`Unknown command: !${cmd.name}. Type !help for available commands.`);
      return true;
    }
  }
}

const HELP_TEXT = `ClaudeBridge Commands:

!start <agent-id>    — Start an agent session
!stop <agent-id>     — Stop an agent session
!restart <agent-id>  — Restart (clear session + stop)
!status [agent-id]   — Show status of one or all agents
!agents              — List all configured agents
!cost [agent-id]     — Show cost for one or all agents
!approve-all         — Approve all pending permissions
!help                — Show this help

In agent rooms:
  y / yes            — Approve pending permission
  n / no             — Deny pending permission
  <any text>         — Deny with reason, or answer agent question
  <any text>         — Send message to agent (when no permission pending)`;
