/**
 * PermissionRouter — Routes CLI permission events to the relay and
 * resolves them when a permission_response arrives from any client.
 *
 * In CLI subprocess mode, permissions are primarily handled by the
 * --permission-mode flag. This router handles any permission events
 * the CLI emits in stream-json mode and relays them to connected clients.
 */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
export class PermissionRouter {
    pending = new Map();
    relay;
    channel;
    timeoutMs;
    constructor(relay, channel, timeoutMs = DEFAULT_TIMEOUT_MS) {
        this.relay = relay;
        this.channel = channel;
        this.timeoutMs = timeoutMs;
    }
    /**
     * Broadcast a permission request to clients and wait for a response.
     * Returns the user's decision ("allow" or "deny").
     */
    async requestPermission(requestId, data) {
        this.relay.sendAgentEvent(this.channel, "permission_request", data, { requestId });
        return new Promise((resolve) => {
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
    handleResponse(requestId, behavior) {
        const entry = this.pending.get(requestId);
        if (!entry)
            return;
        clearTimeout(entry.timer);
        this.pending.delete(requestId);
        entry.resolve(behavior);
    }
    /** Clean up all pending permissions (e.g., on shutdown). */
    cleanup() {
        for (const [, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.resolve("deny");
        }
        this.pending.clear();
    }
}
//# sourceMappingURL=permission-router.js.map