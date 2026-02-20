/**
 * PermissionRouter — Routes CLI permission events to the relay and
 * resolves them when a permission_response arrives from any client.
 *
 * In CLI subprocess mode, permissions are primarily handled by the
 * --permission-mode flag. This router handles any permission events
 * the CLI emits in stream-json mode and relays them to connected clients.
 */

import type { RelayClient } from "./relay-client.js";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

interface PendingPermission {
  resolve: (behavior: "allow" | "deny") => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PermissionRouter {
  private pending = new Map<string, PendingPermission>();
  private relay: RelayClient;
  private channel: string;
  private timeoutMs: number;

  constructor(relay: RelayClient, channel: string, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.relay = relay;
    this.channel = channel;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Broadcast a permission request to clients and wait for a response.
   * Returns the user's decision ("allow" or "deny").
   */
  async requestPermission(requestId: string, data: Record<string, unknown>): Promise<"allow" | "deny"> {
    this.relay.sendAgentEvent(this.channel, "permission_request", data, { requestId });

    return new Promise<"allow" | "deny">((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve("deny"); // Timeout = deny
      }, this.timeoutMs);

      this.pending.set(requestId, { resolve, timer });
    });
  }

  /**
   * Called when a permission_response message arrives from the relay.
   */
  handleResponse(requestId: string, behavior: "allow" | "deny"): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;

    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    entry.resolve(behavior);
  }

  /** Clean up all pending permissions (e.g., on shutdown). */
  cleanup(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve("deny");
    }
    this.pending.clear();
  }
}
