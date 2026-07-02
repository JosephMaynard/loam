import { existsSync, readFileSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  ChannelSchema,
  MessageSchema,
  UserSchema,
  type Channel,
  type Message,
  type User,
} from "@loam/schema";

export type SessionRecord = {
  token: string;
  userId: string;
};

export type OpenStoreOptions = {
  /**
   * When set, the database is **encrypted at rest** with SQLCipher via
   * `better-sqlite3-multiple-ciphers` (see docs/01). Requires a real file path — SQLCipher cannot
   * key an in-memory database. When unset, the built-in `node:sqlite` driver is used (no encryption),
   * keeping bare deployments free of the native dependency.
   */
  encryptionKey?: string;
};

type SqliteRow = Record<string, unknown>;
type SqliteStatement = {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): SqliteRow | undefined;
  all(...params: unknown[]): SqliteRow[];
};
/** The narrow surface both `node:sqlite` and `better-sqlite3-multiple-ciphers` share. */
type SqliteConnection = {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
};
type EncryptedDatabase = SqliteConnection & { pragma(source: string): unknown };

/**
 * Open the underlying SQLite connection, selecting the encrypted driver when a key is provided.
 * The encrypted driver is `require`d lazily so `node:sqlite` deployments never load the native
 * module (and the Android bundle only pulls it in when encryption is actually on).
 */
function openConnection(path: string, options: OpenStoreOptions): SqliteConnection {
  if (!options.encryptionKey) {
    return new DatabaseSync(path) as unknown as SqliteConnection;
  }

  if (path === ":memory:") {
    throw new Error("Encrypted stores require a file path — SQLCipher cannot key an in-memory database.");
  }

  const requireNative = createRequire(import.meta.url);
  const Database = requireNative("better-sqlite3-multiple-ciphers") as new (dbPath: string) => EncryptedDatabase;
  const db = new Database(path);
  db.pragma("cipher='sqlcipher'");
  // Escape single quotes so an arbitrary passphrase can't break out of the pragma literal.
  db.pragma(`key='${options.encryptionKey.replace(/'/g, "''")}'`);
  return db;
}

/**
 * Storage abstraction for all persisted LOAM state.
 *
 * The interface is deliberately driver-agnostic: the default implementation uses `node:sqlite`, but
 * an encrypted driver (SQLCipher/libsql) or an application-level-encryption wrapper can implement
 * the same surface without touching the server (see docs/01-sqlite-migration.md).
 */
export interface LoamStore {
  loadUsers(): User[];
  loadChannels(): Channel[];
  loadMessages(): Message[];
  loadSessions(): SessionRecord[];
  upsertUser(user: User): void;
  upsertChannel(channel: Channel): void;
  insertMessage(message: Message): void;
  updateMessage(message: Message): void;
  deleteMessage(messageId: string): void;
  putSession(token: string, userId: string): void;
  deleteSession(token: string): void;
  getConfigValue(key: string): string | undefined;
  setConfigValue(key: string, value: string): void;
  /** Run `fn` inside a single transaction; rolls back if it throws. */
  transaction<T>(fn: () => T): T;
  /** True when no users, channels, messages, or sessions exist (config is ignored). */
  isEmpty(): boolean;
  /** Delete all users, channels, messages, and sessions in one transaction. Config is preserved. */
  wipeAll(): void;
  close(): void;
}

/**
 * Extract the indexable columns from a message for the `messages` table.
 *
 * @param message - The message to derive column values from
 * @returns Positional values for type, author, channel, recipient, target, and creation time
 */
function messageColumns(message: Message): [string, string, string | null, string | null, string | null, number] {
  return [
    message.type,
    message.authorId,
    "channelId" in message ? message.channelId : null,
    message.type === "dm" ? message.recipientUserId : null,
    message.type === "reaction" ? message.targetMessageId : null,
    message.createdAt,
  ];
}

/**
 * Open (creating if necessary) the SQLite-backed LOAM store.
 *
 * @param path - Filesystem path for the database, or `":memory:"` for an in-memory store
 * @param options - Driver options; pass `encryptionKey` to encrypt the database at rest
 * @returns A `LoamStore` bound to the database
 */
export function openStore(path: string, options: OpenStoreOptions = {}): LoamStore {
  const db = openConnection(path, options);
  let closed = false;

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      author_id TEXT NOT NULL,
      channel_id TEXT,
      recipient_user_id TEXT,
      target_message_id TEXT,
      created_at INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages (channel_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages (recipient_user_id, author_id);
    CREATE INDEX IF NOT EXISTS idx_messages_target ON messages (target_message_id);
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const upsertUserStmt = db.prepare(
    "INSERT INTO users (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
  );
  const upsertChannelStmt = db.prepare(
    "INSERT INTO channels (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
  );
  const insertMessageStmt = db.prepare(
    `INSERT INTO messages (id, type, author_id, channel_id, recipient_user_id, target_message_id, created_at, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateMessageStmt = db.prepare(
    `UPDATE messages
     SET type = ?, author_id = ?, channel_id = ?, recipient_user_id = ?, target_message_id = ?, created_at = ?, data = ?
     WHERE id = ?`,
  );
  const deleteMessageStmt = db.prepare("DELETE FROM messages WHERE id = ?");
  const putSessionStmt = db.prepare(
    "INSERT INTO sessions (token, user_id) VALUES (?, ?) ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id",
  );
  const deleteSessionStmt = db.prepare("DELETE FROM sessions WHERE token = ?");
  const setConfigStmt = db.prepare(
    "INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  const getConfigStmt = db.prepare("SELECT value FROM config WHERE key = ?");
  const countStmt = db.prepare(
    `SELECT (SELECT COUNT(*) FROM users)
          + (SELECT COUNT(*) FROM channels)
          + (SELECT COUNT(*) FROM messages)
          + (SELECT COUNT(*) FROM sessions) AS total`,
  );

  const store: LoamStore = {
    loadUsers() {
      return db
        .prepare("SELECT data FROM users ORDER BY rowid")
        .all()
        .map((row) => UserSchema.parse(JSON.parse(row.data as string)));
    },
    loadChannels() {
      return db
        .prepare("SELECT data FROM channels ORDER BY rowid")
        .all()
        .map((row) => ChannelSchema.parse(JSON.parse(row.data as string)));
    },
    loadMessages() {
      return db
        .prepare("SELECT data FROM messages ORDER BY created_at, rowid")
        .all()
        .map((row) => MessageSchema.parse(JSON.parse(row.data as string)));
    },
    loadSessions() {
      return db
        .prepare("SELECT token, user_id FROM sessions ORDER BY rowid")
        .all()
        .map((row) => ({ token: row.token as string, userId: row.user_id as string }));
    },
    upsertUser(user) {
      upsertUserStmt.run(user.id, JSON.stringify(user));
    },
    upsertChannel(channel) {
      upsertChannelStmt.run(channel.id, JSON.stringify(channel));
    },
    insertMessage(message) {
      insertMessageStmt.run(message.id, ...messageColumns(message), JSON.stringify(message));
    },
    updateMessage(message) {
      updateMessageStmt.run(...messageColumns(message), JSON.stringify(message), message.id);
    },
    deleteMessage(messageId) {
      deleteMessageStmt.run(messageId);
    },
    putSession(token, userId) {
      putSessionStmt.run(token, userId);
    },
    deleteSession(token) {
      deleteSessionStmt.run(token);
    },
    getConfigValue(key) {
      const row = getConfigStmt.get(key);
      return row ? (row.value as string) : undefined;
    },
    setConfigValue(key, value) {
      setConfigStmt.run(key, value);
    },
    transaction(fn) {
      db.exec("BEGIN IMMEDIATE");

      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    isEmpty() {
      const row = countStmt.get();
      return !row || row.total === 0;
    },
    wipeAll() {
      store.transaction(() => {
        db.exec("DELETE FROM messages");
        db.exec("DELETE FROM sessions");
        db.exec("DELETE FROM users");
        db.exec("DELETE FROM channels");
      });
    },
    close() {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  };

  return store;
}

function isSessionRecord(value: unknown): value is SessionRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Partial<SessionRecord>;
  return (
    typeof record.token === "string" &&
    record.token.length > 0 &&
    typeof record.userId === "string" &&
    record.userId.length > 0
  );
}

function readLegacyJsonArray(dataDir: string, file: string): unknown[] {
  const path = join(dataDir, `${file}.json`);

  if (!existsSync(path)) {
    return [];
  }

  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));

  if (!Array.isArray(parsed)) {
    // Coercing to [] would "import" nothing and rename the file to .bak — silent data loss.
    throw new Error(`Legacy data file ${path} does not contain a JSON array`);
  }

  return parsed;
}

/**
 * One-time import of the legacy flat-JSON persistence (`users/channels/messages/sessions.json`)
 * into an empty store, renaming each imported file to `<name>.json.bak` afterwards.
 *
 * Users, channels, and messages are validated strictly (a corrupt row aborts the import and rolls
 * back); session records are skipped when malformed, matching the old loader's leniency.
 *
 * @param store - The destination store; must be empty for the import to run
 * @param dataDir - Directory containing the legacy JSON files
 * @returns `true` when an import happened, `false` when the store had data or no files exist
 */
export function importLegacyJsonData(store: LoamStore, dataDir: string): boolean {
  if (!store.isEmpty()) {
    return false;
  }

  const files = ["users", "channels", "messages", "sessions"] as const;
  const presentFiles = files.filter((file) => existsSync(join(dataDir, `${file}.json`)));

  if (!presentFiles.length) {
    return false;
  }

  store.transaction(() => {
    for (const user of readLegacyJsonArray(dataDir, "users")) {
      store.upsertUser(UserSchema.parse(user));
    }

    for (const channel of readLegacyJsonArray(dataDir, "channels")) {
      store.upsertChannel(ChannelSchema.parse(channel));
    }

    for (const message of readLegacyJsonArray(dataDir, "messages")) {
      store.insertMessage(MessageSchema.parse(message));
    }

    for (const session of readLegacyJsonArray(dataDir, "sessions")) {
      if (isSessionRecord(session)) {
        store.putSession(session.token, session.userId);
      }
    }
  });

  for (const file of presentFiles) {
    const path = join(dataDir, `${file}.json`);
    renameSync(path, `${path}.bak`);
  }

  return true;
}
