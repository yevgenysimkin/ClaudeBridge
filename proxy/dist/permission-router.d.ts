/**
 * PermissionRouter — Routes CLI permission events to the relay and
 * resolves them when a permission_response arrives from any client.
 *
 * In CLI subprocess mode, permissions are primarily handled by the
 * --permission-mode flag. This router handles any permission events
 * the CLI emits in stream-json mode and relays them to connected clients.
 */
import type { RelayClient } from "./relay-client.js";
export declare class PermissionRouter {
    private pending;
    private relay;
    private channel;
    private timeoutMs;
    constructor(relay: RelayClient, channel: string, timeoutMs?: number);
    /**
     * Broadcast a permission request to clients and wait for a response.
     * Returns the user's decision ("allow" or "deny").
     */
    requestPermission(requestId: string, data: Record<string, unknown>): Promise<"allow" | "deny">;
    /**
     * Called when a permission_response message arrives from the relay.
     */
    handleResponse(requestId: string, behavior: "allow" | "deny"): void;
    /** Clean up all pending permissions (e.g., on shutdown). */
    cleanup(): void;
}
//# sourceMappingURL=permission-router.d.ts.map