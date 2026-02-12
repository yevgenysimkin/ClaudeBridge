import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage, Options } from "@anthropic-ai/claude-agent-sdk";
import { EventEmitter } from "node:events";
import { AgentConfig } from "./config.js";
import { DEFAULT_MODEL, PERMISSION_TIMEOUT_MS } from "./constants.js";

// --- Event types emitted by AgentSession ---

export interface PermissionRequestEvent {
  toolName: string;
  input: Record<string, unknown>;
}

export interface UserQuestionEvent {
  questions: Array<{
    question: string;
    options: Array<{ label: string; description?: string }>;
  }>;
}

export interface TextOutputEvent {
  text: string;
}

export interface ToolUseEvent {
  toolName: string;
  input: Record<string, unknown>;
}

export interface ResultEvent {
  success: boolean;
  text?: string;
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
  errors?: string[];
}

export interface SessionEvents {
  "permission-request": [PermissionRequestEvent];
  "user-question": [UserQuestionEvent];
  "text": [TextOutputEvent];
  "tool-use": [ToolUseEvent];
  "result": [ResultEvent];
  "error": [Error];
  "started": [{ sessionId: string }];
  "stopped": [];
}

/**
 * Wraps a single Claude Agent SDK session.
 *
 * Manages the SDK query lifecycle, permission callbacks, and
 * emits typed events for the manager to route to Matrix.
 */
export class AgentSession extends EventEmitter<SessionEvents> {
  readonly agentId: string;
  readonly config: AgentConfig;

  private sessionId: string | undefined;
  private abortController: AbortController | undefined;
  private running = false;
  private totalCostUsd = 0;
  private totalTurns = 0;

  // Permission handling: pending promise resolvers keyed by request ID
  private permissionResolvers = new Map<string, {
    resolve: (result: PermissionResolveResult) => void;
    toolName: string;
  }>();
  private permissionCounter = 0;

  constructor(config: AgentConfig) {
    super();
    this.agentId = config.id;
    this.config = config;
  }

  /** Whether this session is currently running. */
  get isRunning(): boolean {
    return this.running;
  }

  /** Current session ID (for resume). */
  get currentSessionId(): string | undefined {
    return this.sessionId;
  }

  /** Accumulated cost across all queries in this session. */
  get cost(): number {
    return this.totalCostUsd;
  }

  /** Accumulated turns across all queries in this session. */
  get turns(): number {
    return this.totalTurns;
  }

  /**
   * Send a message to the agent. If no session exists, starts a new one.
   * If a session exists, resumes it with the new message.
   */
  async sendMessage(text: string, globalModel?: string): Promise<void> {
    const model = this.config.model || globalModel || DEFAULT_MODEL;

    const options: Options = {
      model,
      maxTurns: this.config.maxTurns,
      maxBudgetUsd: this.config.maxBudgetUsd,
      cwd: this.config.cwd,
      permissionMode: this.config.permissionMode || "default",
      canUseTool: this.handleCanUseTool.bind(this),
      abortController: this.abortController,
      systemPrompt: this.config.systemPrompt
        ? { type: "preset", preset: "claude_code", append: this.config.systemPrompt }
        : { type: "preset", preset: "claude_code" },
      tools: { type: "preset", preset: "claude_code" },
    };

    // Resume existing session or start fresh
    if (this.sessionId) {
      options.resume = this.sessionId;
    }

    this.running = true;
    this.abortController = new AbortController();
    options.abortController = this.abortController;

    try {
      const stream = query({ prompt: text, options });
      await this.consumeStream(stream);
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        console.log(`[agent:${this.agentId}] Session aborted.`);
      } else {
        console.error(`[agent:${this.agentId}] Query error:`, err);
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      this.running = false;
    }
  }

  /** Stop the current session. */
  stop(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = undefined;
    }
    this.running = false;

    // Reject any pending permission requests
    for (const [id, pending] of this.permissionResolvers) {
      pending.resolve({ approved: false, message: "Session stopped." });
      this.permissionResolvers.delete(id);
    }

    this.emit("stopped");
  }

  /** Reset session state (for full restart). */
  reset(): void {
    this.stop();
    this.sessionId = undefined;
    this.totalCostUsd = 0;
    this.totalTurns = 0;
  }

  /**
   * Resolve a pending permission request.
   * Returns false if no pending request found.
   */
  resolvePermission(requestId: string, result: PermissionResolveResult): boolean {
    const pending = this.permissionResolvers.get(requestId);
    if (!pending) return false;
    pending.resolve(result);
    this.permissionResolvers.delete(requestId);
    return true;
  }

  /**
   * Resolve the most recent permission request (convenience for single-pending flows).
   */
  resolveLatestPermission(result: PermissionResolveResult): boolean {
    const entries = [...this.permissionResolvers.entries()];
    if (entries.length === 0) return false;
    const [id, pending] = entries[entries.length - 1];
    pending.resolve(result);
    this.permissionResolvers.delete(id);
    return true;
  }

  /** Check if there are pending permission requests. */
  get hasPendingPermission(): boolean {
    return this.permissionResolvers.size > 0;
  }

  /** Get the tool name of the latest pending permission. */
  get latestPendingToolName(): string | undefined {
    const entries = [...this.permissionResolvers.entries()];
    if (entries.length === 0) return undefined;
    return entries[entries.length - 1][1].toolName;
  }

  /** Get status summary. */
  getStatus(): {
    id: string;
    name: string;
    running: boolean;
    sessionId?: string;
    totalCostUsd: number;
    totalTurns: number;
    pendingPermissions: number;
  } {
    return {
      id: this.agentId,
      name: this.config.name,
      running: this.running,
      sessionId: this.sessionId,
      totalCostUsd: this.totalCostUsd,
      totalTurns: this.totalTurns,
      pendingPermissions: this.permissionResolvers.size,
    };
  }

  // --- Private ---

  /** The canUseTool callback wired into the SDK. */
  private handleCanUseTool(
    toolName: string,
    input: Record<string, unknown>,
    _options: { signal: AbortSignal },
  ): Promise<{ behavior: "allow"; updatedInput?: Record<string, unknown> } | { behavior: "deny"; message: string }> {
    // Handle AskUserQuestion specially
    if (toolName === "AskUserQuestion") {
      return this.handleUserQuestion(input);
    }

    const requestId = String(++this.permissionCounter);

    return new Promise((resolve) => {
      // Store the resolver
      this.permissionResolvers.set(requestId, { resolve: (result) => {
        if (result.approved) {
          resolve({ behavior: "allow" });
        } else {
          resolve({ behavior: "deny", message: result.message || "Denied by user." });
        }
      }, toolName });

      // Emit event for the manager to post to Matrix
      this.emit("permission-request", { toolName, input });

      // Timeout: auto-deny after PERMISSION_TIMEOUT_MS
      setTimeout(() => {
        if (this.permissionResolvers.has(requestId)) {
          this.permissionResolvers.get(requestId)!.resolve({
            approved: false,
            message: "Permission request timed out.",
          });
          this.permissionResolvers.delete(requestId);
        }
      }, PERMISSION_TIMEOUT_MS);
    });
  }

  /** Handle AskUserQuestion: post question to Matrix, wait for answer. */
  private handleUserQuestion(
    input: Record<string, unknown>,
  ): Promise<{ behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string }> {
    const requestId = String(++this.permissionCounter);

    const questions = (input.questions as Array<{
      question: string;
      options: Array<{ label: string; description?: string }>;
    }>) || [];

    return new Promise((resolve) => {
      this.permissionResolvers.set(requestId, { resolve: (result) => {
        if (result.approved && result.answer) {
          // Build answers map: question text → selected label
          const answers: Record<string, string> = {};
          if (questions.length === 1) {
            answers[questions[0].question] = result.answer;
          } else {
            // For multi-question, the answer should be the raw text
            for (const q of questions) {
              answers[q.question] = result.answer;
            }
          }
          resolve({
            behavior: "allow",
            updatedInput: { ...input, answers },
          });
        } else {
          resolve({ behavior: "deny", message: result.message || "User declined to answer." });
        }
      }, toolName: "AskUserQuestion" });

      // Emit user-question event
      this.emit("user-question", { questions });

      // Timeout
      setTimeout(() => {
        if (this.permissionResolvers.has(requestId)) {
          this.permissionResolvers.get(requestId)!.resolve({
            approved: false,
            message: "Question timed out.",
          });
          this.permissionResolvers.delete(requestId);
        }
      }, PERMISSION_TIMEOUT_MS);
    });
  }

  /** Consume the SDK output stream, emitting events. */
  private async consumeStream(stream: AsyncIterable<SDKMessage>): Promise<void> {
    for await (const msg of stream) {
      switch (msg.type) {
        case "system": {
          if (msg.subtype === "init") {
            this.sessionId = msg.session_id;
            this.emit("started", { sessionId: msg.session_id });
            console.log(`[agent:${this.agentId}] Session started: ${msg.session_id}`);
          }
          break;
        }

        case "assistant": {
          const content = msg.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text" && block.text) {
                this.emit("text", { text: block.text });
              } else if (block.type === "tool_use") {
                this.emit("tool-use", {
                  toolName: block.name,
                  input: block.input as Record<string, unknown>,
                });
              }
            }
          }
          break;
        }

        case "result": {
          if (msg.subtype === "success") {
            const costUsd = (msg as Record<string, unknown>).total_cost_usd as number | undefined;
            const durationMs = (msg as Record<string, unknown>).duration_ms as number | undefined;
            const numTurns = (msg as Record<string, unknown>).num_turns as number | undefined;
            const result = (msg as Record<string, unknown>).result as string | undefined;

            if (costUsd) this.totalCostUsd += costUsd;
            if (numTurns) this.totalTurns += numTurns;

            this.emit("result", {
              success: true,
              text: result,
              costUsd,
              durationMs,
              numTurns,
            });
          } else {
            // Error result
            const errors = ((msg as Record<string, unknown>).errors as string[]) || [msg.subtype];
            this.emit("result", {
              success: false,
              errors,
            });
          }
          break;
        }

        default:
          // stream_event, compact_boundary, etc. — ignore for now
          break;
      }
    }
  }
}

export interface PermissionResolveResult {
  approved: boolean;
  message?: string;
  answer?: string; // For AskUserQuestion responses
}
