import { existsSync, readFileSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import {
  ChannelSchema,
  MessageSchema,
  UserSchema,
  type AvatarImageMimeType,
  type Channel,
  type Message,
  type User,
} from "@loam/schema";

export type SessionRecord = {
  token: string;
  userId: string;
};

/** A persisted secure transport-identity token (docs/20). The bearer token is stored **hashed**
 * (`tokenHash`), never in the clear; it maps to the anonymous user it authenticates. Separate from
 * `SessionRecord` (the legacy cookie namespace) — the two must never mix. */
export type IdentityTokenRecord = {
  tokenHash: string;
  userId: string;
  createdAt: number;
};

/**
 * A work item recording that a peer's attachment file failed to copy during a node-to-node sync
 * import (docs/15 A6): the message itself still imported (best-effort), but without this record a
 * later sync digest would see the message id as already-known and never re-offer the attachment,
 * stranding it image-less forever. `attempts` bounds the independent retry pass that re-fetches just
 * this file from `peerUrl` without re-importing the message.
 */
export type MissingAttachmentRecord = {
  messageId: string;
  attachmentId: string;
  mimeType: AvatarImageMimeType;
  peerUrl: string;
  attempts: number;
  createdAt: number;
};

/**
 * Which SQLite backend to open.
 *
 * - `"node-sqlite"` (default): the built-in `node:sqlite` (`DatabaseSync`) — zero native deps,
 *   the desktop/CI default. Requires Node ≥ 22 (absent on the Android host's Node 18).
 * - `"better-sqlite3"`: the plain `better-sqlite3` native module, `require`d lazily. Used by the
 *   Android host, whose embedded Node 18 has no `node:sqlite`; ships an ABI-108 android-arm64
 *   prebuild (see docs/04). **Unencrypted** — on-device encryption needs a multiple-ciphers
 *   android prebuild and is a follow-up (docs/01).
 *
 * When `encryptionKey` is set the driver is ignored and `better-sqlite3-multiple-ciphers`
 * (SQLCipher) is used regardless.
 */
export type StoreDriver = "node-sqlite" | "better-sqlite3";

export type OpenStoreOptions = {
  /**
   * When set, the database is **encrypted at rest** with SQLCipher via
   * `better-sqlite3-multiple-ciphers` (see docs/01). Requires a real file path — SQLCipher cannot
   * key an in-memory database. Takes precedence over `driver`.
   */
  encryptionKey?: string;
  /**
   * Selects the plaintext backend when `encryptionKey` is absent. Defaults to `"node-sqlite"` so
   * bare desktop/CI deployments stay free of the native dependency; the Android host passes
   * `"better-sqlite3"` (its Node 18 has no `node:sqlite`). See {@link StoreDriver}.
   */
  driver?: StoreDriver;
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
 * Open the underlying SQLite connection, selecting the backend from `options`:
 * an encryption key forces `better-sqlite3-multiple-ciphers` (SQLCipher); otherwise the `driver`
 * chooses between the built-in `node:sqlite` (default) and the plain `better-sqlite3` native module
 * used by the Android host. Both native drivers are `require`d lazily (via `createRequire`) so
 * `node:sqlite` deployments never load — or need to bundle — a native module.
 */
function openConnection(path: string, options: OpenStoreOptions): SqliteConnection {
  if (options.encryptionKey) {
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

  if (options.driver === "better-sqlite3") {
    // The Android host's embedded Node 18 has no `node:sqlite`; use the plain (unencrypted)
    // better-sqlite3 native module. It shares the exec/prepare/run/get/all/close surface with the
    // multiple-ciphers fork, so the store built on top is identical.
    const requireNative = createRequire(import.meta.url);
    const Database = requireNative("better-sqlite3") as new (dbPath: string) => SqliteConnection;
    return new Database(path);
  }

  // `node:sqlite` is required lazily (not a static top-level import): it's a Node ≥22 builtin, so
  // eagerly loading this module would throw ERR_UNKNOWN_BUILTIN_MODULE on the Android host's Node 18
  // even when it ends up using the better-sqlite3 driver. Reached only for the desktop/CI default.
  const requireNode = createRequire(import.meta.url);
  const { DatabaseSync } = requireNode("node:sqlite") as typeof import("node:sqlite");
  return new DatabaseSync(path) as unknown as SqliteConnection;
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
  /** Secure transport-identity tokens (docs/20), separate from the cookie `sessions` namespace. */
  loadIdentityTokens(): IdentityTokenRecord[];
  putIdentityToken(tokenHash: string, userId: string, createdAt: number): void;
  deleteIdentityToken(tokenHash: string): void;
  deleteIdentityTokensForUser(userId: string): void;
  getConfigValue(key: string): string | undefined;
  setConfigValue(key: string, value: string): void;
  /**
   * Record that a message id was deliberately deleted here, so node-to-node sync never re-imports
   * it from a peer that still holds it (docs/11). Tombstones are data: wiped with everything else.
   */
  addTombstone(messageId: string): void;
  loadTombstones(): string[];
  /**
   * Delete tombstones stamped before `cutoffMs` — the horizon GC that keeps the table bounded on a
   * long-lived node (see the `addTombstone` note; the horizon is enforced by the caller, not here).
   * Returns the pruned message ids so the caller can drop them from its in-memory mirror too.
   */
  pruneTombstonesOlderThan(cutoffMs: number): string[];
  /**
   * Store (or replace) a local user's mesh keypair record — the opportunistic-mesh identity, secret
   * keys included (docs/16), as an opaque JSON string. Kept out of the `users` table since it holds
   * private material; wiped with everything else by the kill switch.
   */
  upsertMeshIdentity(userId: string, data: string): void;
  loadMeshIdentities(): { userId: string; data: string }[];
  /**
   * Store (or replace) one entry in a local user's mesh address book (docs/16): the owner's user id,
   * the contact's `mesh.` id, and an opaque JSON card (public keys + the contact's secret mailbox
   * token, needed to seal to them). Per-owner so one local user's contacts aren't another's; wiped by
   * the kill switch.
   */
  upsertMeshContact(ownerUserId: string, meshId: string, data: string): void;
  loadMeshContacts(): { ownerUserId: string; meshId: string; data: string }[];
  /**
   * Record that a peer attachment failed to copy during a sync import (docs/15 A6), starting its
   * attempt counter at 0. A conflict (same message+attachment already tracked) is a no-op — it keeps
   * the original `attempts`/`createdAt` rather than resetting the retry clock.
   */
  addMissingAttachment(record: Omit<MissingAttachmentRecord, "attempts" | "createdAt">): void;
  loadMissingAttachments(): MissingAttachmentRecord[];
  /** The attachment copy finally succeeded (or the message/work item it belonged to is gone) — drop it. */
  clearMissingAttachment(messageId: string, attachmentId: string): void;
  /** Another retry against the peer failed — bump the counter the retry pass bounds against. */
  bumpMissingAttachmentAttempts(messageId: string, attachmentId: string): void;
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

  try {
    return buildStore(db);
  } catch (error) {
    // A wrong encryption key surfaces here (the first pragma/DDL fails); don't leak the handle.
    db.close();
    throw error;
  }
}

/**
 * Backfill the `tombstones.created_at` column onto a database created before horizon-based GC
 * existed. `CREATE TABLE IF NOT EXISTS` is a no-op on an already-existing table, so a plain
 * `ALTER TABLE` here is the only way an older `.loam/loam.db` picks up the column. Existing rows
 * (whose real delete time is lost) are backfilled to "now" — the safe direction, since it starts
 * their horizon clock fresh rather than expiring them early and re-exposing an old delete to sync.
 */
function migrateTombstonesCreatedAt(db: SqliteConnection): void {
  const columns = db.prepare("PRAGMA table_info(tombstones)").all() as { name: string }[];
  const hasCreatedAt = columns.some((column) => column.name === "created_at");

  if (!hasCreatedAt) {
    db.exec("ALTER TABLE tombstones ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0");
    db.prepare("UPDATE tombstones SET created_at = ? WHERE created_at = 0").run(Date.now());
  }
}

/**
 * Initialise the schema and prepared statements on an open connection and return the store.
 * Split out so `openStore` can close the connection if any setup step throws.
 */
function buildStore(db: SqliteConnection): LoamStore {
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
    CREATE TABLE IF NOT EXISTS tombstones (
      message_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS mesh_identities (
      user_id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mesh_contacts (
      owner_user_id TEXT NOT NULL,
      mesh_id TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (owner_user_id, mesh_id)
    );
    CREATE TABLE IF NOT EXISTS transport_identity_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS missing_attachments (
      message_id TEXT NOT NULL,
      attachment_id TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      peer_url TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (message_id, attachment_id)
    );
  `);
  migrateTombstonesCreatedAt(db);

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
  const putIdentityTokenStmt = db.prepare(
    "INSERT INTO transport_identity_tokens (token_hash, user_id, created_at) VALUES (?, ?, ?) ON CONFLICT(token_hash) DO UPDATE SET user_id = excluded.user_id, created_at = excluded.created_at",
  );
  const deleteIdentityTokenStmt = db.prepare("DELETE FROM transport_identity_tokens WHERE token_hash = ?");
  const deleteIdentityTokensForUserStmt = db.prepare("DELETE FROM transport_identity_tokens WHERE user_id = ?");
  const setConfigStmt = db.prepare(
    "INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  const getConfigStmt = db.prepare("SELECT value FROM config WHERE key = ?");
  const addTombstoneStmt = db.prepare(
    "INSERT INTO tombstones (message_id, created_at) VALUES (?, ?) ON CONFLICT(message_id) DO NOTHING",
  );
  const pruneTombstonesStmt = db.prepare("SELECT message_id FROM tombstones WHERE created_at < ?");
  const deletePrunedTombstonesStmt = db.prepare("DELETE FROM tombstones WHERE created_at < ?");
  const upsertMeshIdentityStmt = db.prepare(
    "INSERT INTO mesh_identities (user_id, data) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data",
  );
  const loadMeshIdentitiesStmt = db.prepare("SELECT user_id, data FROM mesh_identities");
  const upsertMeshContactStmt = db.prepare(
    `INSERT INTO mesh_contacts (owner_user_id, mesh_id, data) VALUES (?, ?, ?)
     ON CONFLICT(owner_user_id, mesh_id) DO UPDATE SET data = excluded.data`,
  );
  const loadMeshContactsStmt = db.prepare("SELECT owner_user_id, mesh_id, data FROM mesh_contacts");
  const addMissingAttachmentStmt = db.prepare(
    `INSERT INTO missing_attachments (message_id, attachment_id, mime_type, peer_url, attempts, created_at)
     VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT(message_id, attachment_id) DO NOTHING`,
  );
  const loadMissingAttachmentsStmt = db.prepare(
    "SELECT message_id, attachment_id, mime_type, peer_url, attempts, created_at FROM missing_attachments ORDER BY rowid",
  );
  const clearMissingAttachmentStmt = db.prepare(
    "DELETE FROM missing_attachments WHERE message_id = ? AND attachment_id = ?",
  );
  const bumpMissingAttachmentAttemptsStmt = db.prepare(
    "UPDATE missing_attachments SET attempts = attempts + 1 WHERE message_id = ? AND attachment_id = ?",
  );
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
    loadIdentityTokens() {
      return db
        .prepare("SELECT token_hash, user_id, created_at FROM transport_identity_tokens ORDER BY rowid")
        .all()
        .map((row) => ({
          tokenHash: row.token_hash as string,
          userId: row.user_id as string,
          createdAt: row.created_at as number,
        }));
    },
    putIdentityToken(tokenHash, userId, createdAt) {
      putIdentityTokenStmt.run(tokenHash, userId, createdAt);
    },
    deleteIdentityToken(tokenHash) {
      deleteIdentityTokenStmt.run(tokenHash);
    },
    deleteIdentityTokensForUser(userId) {
      deleteIdentityTokensForUserStmt.run(userId);
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
    addTombstone(messageId) {
      addTombstoneStmt.run(messageId, Date.now());
    },
    loadTombstones() {
      return db
        .prepare("SELECT message_id FROM tombstones ORDER BY rowid")
        .all()
        .map((row) => row.message_id as string);
    },
    pruneTombstonesOlderThan(cutoffMs) {
      const pruned = pruneTombstonesStmt.all(cutoffMs).map((row) => row.message_id as string);
      deletePrunedTombstonesStmt.run(cutoffMs);
      return pruned;
    },
    upsertMeshIdentity(userId, data) {
      upsertMeshIdentityStmt.run(userId, data);
    },
    loadMeshIdentities() {
      return loadMeshIdentitiesStmt.all().map((row) => ({ userId: row.user_id as string, data: row.data as string }));
    },
    upsertMeshContact(ownerUserId, meshId, data) {
      upsertMeshContactStmt.run(ownerUserId, meshId, data);
    },
    loadMeshContacts() {
      return loadMeshContactsStmt.all().map((row) => ({
        ownerUserId: row.owner_user_id as string,
        meshId: row.mesh_id as string,
        data: row.data as string,
      }));
    },
    addMissingAttachment(record) {
      addMissingAttachmentStmt.run(record.messageId, record.attachmentId, record.mimeType, record.peerUrl, Date.now());
    },
    loadMissingAttachments() {
      return loadMissingAttachmentsStmt.all().map((row) => ({
        messageId: row.message_id as string,
        attachmentId: row.attachment_id as string,
        mimeType: row.mime_type as AvatarImageMimeType,
        peerUrl: row.peer_url as string,
        attempts: row.attempts as number,
        createdAt: row.created_at as number,
      }));
    },
    clearMissingAttachment(messageId, attachmentId) {
      clearMissingAttachmentStmt.run(messageId, attachmentId);
    },
    bumpMissingAttachmentAttempts(messageId, attachmentId) {
      bumpMissingAttachmentAttemptsStmt.run(messageId, attachmentId);
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
        db.exec("DELETE FROM tombstones");
        db.exec("DELETE FROM mesh_identities");
        db.exec("DELETE FROM mesh_contacts");
        db.exec("DELETE FROM transport_identity_tokens");
        db.exec("DELETE FROM missing_attachments");
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
