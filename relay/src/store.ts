import Database from "better-sqlite3";
import type { ChannelMessage, MessageMetadata } from "./protocol.js";

const MAX_MESSAGES_PER_CHANNEL = 500;

/**
 * SQLite-backed message store.
 * Persists messages so they survive relay restarts and phone reconnects.
 */
export class MessageStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.migrate();
  }

  /** Store a message. Returns the assigned ID. */
  addMessage(
    channel: string,
    sender: "bot" | "user" | "system",
    content: string,
    metadata?: MessageMetadata,
  ): ChannelMessage {
    const timestamp = Date.now();
    const metaJson = metadata ? JSON.stringify(metadata) : null;

    const stmt = this.db.prepare(
      "INSERT INTO messages (channel, sender, content, metadata, timestamp) VALUES (?, ?, ?, ?, ?)",
    );
    const result = stmt.run(channel, sender, content, metaJson, timestamp);

    // Prune old messages
    this.prune(channel);

    return {
      type: "message",
      id: result.lastInsertRowid as number,
      channel,
      sender,
      content,
      timestamp,
      metadata: metadata || undefined,
    };
  }

  /** Get recent messages for a channel. */
  getHistory(channel: string, limit = 50, before?: number): { messages: ChannelMessage[]; hasMore: boolean } {
    const actualLimit = Math.min(limit, 100);

    let rows: Array<{
      id: number;
      channel: string;
      sender: string;
      content: string;
      metadata: string | null;
      timestamp: number;
    }>;

    if (before) {
      rows = this.db
        .prepare(
          "SELECT * FROM messages WHERE channel = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT ?",
        )
        .all(channel, before, actualLimit + 1) as typeof rows;
    } else {
      rows = this.db
        .prepare(
          "SELECT * FROM messages WHERE channel = ? ORDER BY timestamp DESC LIMIT ?",
        )
        .all(channel, actualLimit + 1) as typeof rows;
    }

    const hasMore = rows.length > actualLimit;
    const trimmed = rows.slice(0, actualLimit).reverse();

    return {
      messages: trimmed.map((row) => ({
        type: "message" as const,
        id: row.id,
        channel: row.channel,
        sender: row.sender as "bot" | "user" | "system",
        content: row.content,
        timestamp: row.timestamp,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      })),
      hasMore,
    };
  }

  /** Get all known channels. */
  getChannels(): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT channel FROM messages ORDER BY channel")
      .all() as Array<{ channel: string }>;
    return rows.map((r) => r.channel);
  }

  /** Close the database. */
  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL,
        sender TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_channel_ts ON messages (channel, timestamp);
    `);
  }

  private prune(channel: string): void {
    this.db.prepare(`
      DELETE FROM messages WHERE channel = ? AND id NOT IN (
        SELECT id FROM messages WHERE channel = ? ORDER BY timestamp DESC LIMIT ?
      )
    `).run(channel, channel, MAX_MESSAGES_PER_CHANNEL);
  }
}
