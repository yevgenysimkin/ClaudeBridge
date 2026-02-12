import {
  MatrixClient,
  SimpleFsStorageProvider,
  AutojoinRoomsMixin,
} from "matrix-bot-sdk";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { EnvConfig } from "./config.js";
import {
  OPS_ROOM_ALIAS,
  OPS_ROOM_NAME,
  AGENT_ROOM_ALIAS_PREFIX,
  AGENT_ROOM_NAME_PREFIX,
} from "./constants.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORAGE_DIR = resolve(__dirname, "../../.matrix-storage");

export type MessageHandler = (roomId: string, sender: string, body: string) => void;

/**
 * Wraps matrix-bot-sdk with room management and message routing.
 */
export class BridgeMatrixClient {
  private client: MatrixClient;
  private adminUser: string;
  private serverName: string;
  private messageHandlers: MessageHandler[] = [];
  private botUserId: string;

  // Room ID cache: alias → roomId
  private roomIdCache = new Map<string, string>();

  constructor(config: EnvConfig) {
    mkdirSync(STORAGE_DIR, { recursive: true });
    const storage = new SimpleFsStorageProvider(resolve(STORAGE_DIR, "bot.json"));

    this.client = new MatrixClient(
      config.matrixHomeserverUrl,
      config.matrixBotAccessToken,
      storage,
    );
    this.adminUser = config.matrixAdminUser;
    this.botUserId = config.matrixBotUser;

    // Extract server name from bot user ID (@bridge-bot:claudebridge → claudebridge)
    this.serverName = config.matrixBotUser.split(":")[1];

    AutojoinRoomsMixin.setupOnClient(this.client);
  }

  /** Start the Matrix client and begin syncing. */
  async start(): Promise<void> {
    // Register message handler before starting sync
    this.client.on("room.message", (roomId: string, event: Record<string, unknown>) => {
      if (!event.content || typeof event.content !== "object") return;
      const content = event.content as Record<string, unknown>;
      if (content.msgtype !== "m.text") return;

      const sender = event.sender as string;
      // Ignore our own messages
      if (sender === this.botUserId) return;

      const body = content.body as string;
      if (!body) return;

      for (const handler of this.messageHandlers) {
        handler(roomId, sender, body);
      }
    });

    await this.client.start();
    console.log("[matrix] Client started and syncing.");
  }

  /** Register a handler for incoming text messages. */
  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  /** Ensure the ops room exists and admin is invited. Returns room ID. */
  async ensureOpsRoom(): Promise<string> {
    return this.ensureRoom(OPS_ROOM_ALIAS, OPS_ROOM_NAME);
  }

  /** Ensure an agent room exists and admin is invited. Returns room ID. */
  async ensureAgentRoom(agentId: string, agentName: string): Promise<string> {
    const alias = `${AGENT_ROOM_ALIAS_PREFIX}${agentId}`;
    const name = `${AGENT_ROOM_NAME_PREFIX}${agentName}`;
    return this.ensureRoom(alias, name);
  }

  /** Send a plain text message to a room. */
  async sendText(roomId: string, text: string): Promise<void> {
    await this.client.sendMessage(roomId, {
      msgtype: "m.text",
      body: text,
    });
  }

  /** Send a formatted (HTML) message to a room. */
  async sendHtml(roomId: string, body: string, html: string): Promise<void> {
    await this.client.sendMessage(roomId, {
      msgtype: "m.text",
      body,
      format: "org.matrix.custom.html",
      formatted_body: html,
    });
  }

  /** Send a notice (non-highlighted) message to a room. */
  async sendNotice(roomId: string, text: string): Promise<void> {
    await this.client.sendMessage(roomId, {
      msgtype: "m.notice",
      body: text,
    });
  }

  /** Send a formatted notice to a room. */
  async sendHtmlNotice(roomId: string, body: string, html: string): Promise<void> {
    await this.client.sendMessage(roomId, {
      msgtype: "m.notice",
      body,
      format: "org.matrix.custom.html",
      formatted_body: html,
    });
  }

  /** Get the room ID for a given alias, or undefined if not found. */
  getRoomId(alias: string): string | undefined {
    return this.roomIdCache.get(alias);
  }

  /** Get the room ID for an agent. */
  getAgentRoomId(agentId: string): string | undefined {
    return this.roomIdCache.get(`${AGENT_ROOM_ALIAS_PREFIX}${agentId}`);
  }

  /** Get the ops room ID. */
  getOpsRoomId(): string | undefined {
    return this.roomIdCache.get(OPS_ROOM_ALIAS);
  }

  /** Stop the Matrix client. */
  stop(): void {
    this.client.stop();
  }

  // --- Private helpers ---

  /** Ensure a room exists with the given alias and name. Create if needed. */
  private async ensureRoom(localAlias: string, name: string): Promise<string> {
    const cached = this.roomIdCache.get(localAlias);
    if (cached) return cached;

    const fullAlias = `#${localAlias}:${this.serverName}`;

    // Try to resolve existing room
    try {
      const roomId = await this.client.resolveRoom(fullAlias);
      this.roomIdCache.set(localAlias, roomId);
      console.log(`[matrix] Found existing room: ${fullAlias} → ${roomId}`);
      return roomId;
    } catch {
      // Room doesn't exist, create it
    }

    const roomId = await this.client.createRoom({
      room_alias_name: localAlias,
      name,
      visibility: "private",
      preset: "private_chat",
      invite: [this.adminUser],
    });

    this.roomIdCache.set(localAlias, roomId);
    console.log(`[matrix] Created room: ${fullAlias} → ${roomId}`);

    return roomId;
  }
}
