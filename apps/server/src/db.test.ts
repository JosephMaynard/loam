import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Channel, Message, User } from "@loam/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { importLegacyJsonData, openStore, type LoamStore } from "./db.js";

function makeUser(id: string, overrides: Partial<User> = {}): User {
  return {
    id,
    displayName: `Test ${id}`,
    type: "human",
    isAdmin: false,
    createdAt: 1_704_067_200_000,
    ephemeral: false,
    ...overrides,
  };
}

function makeChannel(id: string, overrides: Partial<Channel> = {}): Channel {
  return {
    id,
    name: `#${id}`,
    visibility: "public",
    allowPosting: "everyone",
    allowReplies: true,
    discoverable: true,
    createdAt: 1_704_067_200_000,
    ...overrides,
  };
}

function makeChannelPost(id: string, createdAt = 1_704_067_200_000): Message {
  return {
    id,
    type: "channelPost",
    channelId: "general",
    authorId: "user.1234",
    body: `body of ${id}`,
    createdAt,
    meta: { markdown: true, source: "human" },
  };
}

const allMessageVariants: Message[] = [
  makeChannelPost("msg_post"),
  {
    id: "msg_reply",
    type: "channelReply",
    channelId: "general",
    parentMessageId: "msg_post",
    authorId: "user.5678",
    body: "a reply",
    createdAt: 1_704_067_200_001,
  },
  {
    id: "msg_dm",
    type: "dm",
    recipientUserId: "user.5678",
    authorId: "user.1234",
    body: "a dm",
    createdAt: 1_704_067_200_002,
  },
  {
    id: "react_1",
    type: "reaction",
    targetMessageId: "msg_post",
    reaction: "👍",
    authorId: "user.5678",
    createdAt: 1_704_067_200_003,
  },
];

describe("openStore", () => {
  let store: LoamStore;

  beforeEach(() => {
    store = openStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("starts empty", () => {
    expect(store.isEmpty()).toBe(true);
    expect(store.loadUsers()).toEqual([]);
    expect(store.loadChannels()).toEqual([]);
    expect(store.loadMessages()).toEqual([]);
    expect(store.loadSessions()).toEqual([]);
  });

  it("round-trips users and updates them on conflict", () => {
    const user = makeUser("user.abc", { avatar: { seed: "user.abc", mode: "face" } });
    store.upsertUser(user);
    expect(store.loadUsers()).toEqual([user]);

    const renamed = { ...user, displayName: "Renamed" };
    store.upsertUser(renamed);
    expect(store.loadUsers()).toEqual([renamed]);
    expect(store.isEmpty()).toBe(false);
  });

  it("round-trips channels", () => {
    const channel = makeChannel("general", { description: "Open room" });
    store.upsertChannel(channel);
    expect(store.loadChannels()).toEqual([channel]);
  });

  it("round-trips every message variant", () => {
    for (const message of allMessageVariants) {
      store.insertMessage(message);
    }

    expect(store.loadMessages()).toEqual(allMessageVariants);
  });

  it("orders loaded messages by createdAt", () => {
    store.insertMessage(makeChannelPost("msg_late", 2_000));
    store.insertMessage(makeChannelPost("msg_early", 1_000));

    expect(store.loadMessages().map((message) => message.id)).toEqual(["msg_early", "msg_late"]);
  });

  it("updates a message in place", () => {
    const message = makeChannelPost("msg_edit");
    store.insertMessage(message);

    const edited: Message = { ...message, body: "edited body", editedAt: 1_704_067_300_000 };
    store.updateMessage(edited);

    expect(store.loadMessages()).toEqual([edited]);
  });

  it("deletes a message", () => {
    const message = makeChannelPost("msg_gone");
    store.insertMessage(message);
    store.deleteMessage(message.id);

    expect(store.loadMessages()).toEqual([]);
  });

  it("round-trips sessions and deletes them", () => {
    store.putSession("token-a", "user.a");
    store.putSession("token-b", "user.b");
    store.putSession("token-a", "user.c");

    expect(store.loadSessions()).toEqual([
      { token: "token-a", userId: "user.c" },
      { token: "token-b", userId: "user.b" },
    ]);

    store.deleteSession("token-a");
    expect(store.loadSessions()).toEqual([{ token: "token-b", userId: "user.b" }]);
  });

  it("stores config values", () => {
    expect(store.getConfigValue("security.profile")).toBeUndefined();
    store.setConfigValue("security.profile", "standard");
    store.setConfigValue("security.profile", "hardened");
    expect(store.getConfigValue("security.profile")).toBe("hardened");
  });

  it("rolls back a failed transaction", () => {
    expect(() =>
      store.transaction(() => {
        store.upsertUser(makeUser("user.rollback"));
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(store.loadUsers()).toEqual([]);
  });

  it("wipeAll empties data tables but keeps config", () => {
    store.upsertUser(makeUser("user.abc"));
    store.upsertChannel(makeChannel("general"));
    store.insertMessage(makeChannelPost("msg_1"));
    store.putSession("token", "user.abc");
    store.setConfigValue("security.profile", "standard");

    store.wipeAll();

    expect(store.isEmpty()).toBe(true);
    expect(store.getConfigValue("security.profile")).toBe("standard");
  });

  it("round-trips tombstones and prunes only those older than the cutoff", () => {
    store.addTombstone("msg_recent");
    store.addTombstone("msg_also_recent");

    expect(store.loadTombstones().sort()).toEqual(["msg_also_recent", "msg_recent"]);

    // A cutoff in the past prunes nothing — both tombstones were just stamped with "now".
    const nothingPruned = store.pruneTombstonesOlderThan(Date.now() - 60_000);
    expect(nothingPruned).toEqual([]);
    expect(store.loadTombstones().sort()).toEqual(["msg_also_recent", "msg_recent"]);

    // A cutoff in the future prunes everything — simulates a tombstone that has aged past the
    // horizon without needing to wait or mock the clock.
    const pruned = store.pruneTombstonesOlderThan(Date.now() + 60_000);
    expect(pruned.sort()).toEqual(["msg_also_recent", "msg_recent"]);
    expect(store.loadTombstones()).toEqual([]);
  });

  it("round-trips missing-attachment work items, bumps attempts, and clears them (docs/15 A6)", () => {
    store.addMissingAttachment({
      messageId: "msg_1",
      attachmentId: "att_1",
      mimeType: "image/png",
      peerUrl: "http://peer.example",
    });

    const [record] = store.loadMissingAttachments();
    expect(record).toMatchObject({
      messageId: "msg_1",
      attachmentId: "att_1",
      mimeType: "image/png",
      peerUrl: "http://peer.example",
      attempts: 0,
      lastAttemptAt: 0, // F1: 0 means "never attempted" — the retry pass treats this as due immediately
      nextAttemptAt: 0, // P2-2: same "due immediately" default, now the column loadDueMissingAttachments filters on
    });
    expect(typeof record?.createdAt).toBe("number");

    // Re-adding the same (message, attachment) pair is a no-op — it must not reset the retry clock.
    store.addMissingAttachment({
      messageId: "msg_1",
      attachmentId: "att_1",
      mimeType: "image/png",
      peerUrl: "http://other-peer.example",
    });
    expect(store.loadMissingAttachments()).toHaveLength(1);
    expect(store.loadMissingAttachments()[0]?.peerUrl).toBe("http://peer.example");

    const beforeBump = Date.now();
    const farFuture = Date.now() + 3_600_000;
    store.bumpMissingAttachmentAttempts("msg_1", "att_1", 1); // caller (app.ts) owns the backoff policy
    store.bumpMissingAttachmentAttempts("msg_1", "att_1", farFuture);
    const bumped = store.loadMissingAttachments()[0];
    expect(bumped?.attempts).toBe(2);
    // F1: each bump also stamps lastAttemptAt (now) — what the retry pass's backoff measures from.
    expect(bumped?.lastAttemptAt).toBeGreaterThanOrEqual(beforeBump);
    // P2-2: nextAttemptAt is exactly whatever the caller passed — a dumb storage write, no policy here.
    expect(bumped?.nextAttemptAt).toBe(farFuture);

    // Not due yet — loadDueMissingAttachments must not return it.
    expect(store.loadDueMissingAttachments(Date.now(), 100)).toEqual([]);

    store.clearMissingAttachment("msg_1", "att_1");
    expect(store.loadMissingAttachments()).toEqual([]);
  });

  it("loadDueMissingAttachments selects only due records, ordered earliest-due-first, capped at limit (P2-2)", () => {
    const now = Date.now();

    // Three NOT-yet-due records (bumped into the future) and two DUE ones (default nextAttemptAt=0),
    // added in an order that would mislead a naive rowid/creation-order read.
    for (const id of ["future_a", "future_b", "future_c"]) {
      store.addMissingAttachment({ messageId: id, attachmentId: "att", mimeType: "image/png", peerUrl: "http://peer.example" });
      store.bumpMissingAttachmentAttempts(id, "att", now + 3_600_000);
    }
    store.addMissingAttachment({ messageId: "due_late", attachmentId: "att", mimeType: "image/png", peerUrl: "http://peer.example" });
    store.bumpMissingAttachmentAttempts("due_late", "att", now - 1_000); // overdue by 1s
    store.addMissingAttachment({ messageId: "due_early", attachmentId: "att", mimeType: "image/png", peerUrl: "http://peer.example" });
    store.bumpMissingAttachmentAttempts("due_early", "att", now - 5_000); // overdue by 5s (more overdue)

    const due = store.loadDueMissingAttachments(now, 100);
    expect(due.map((record) => record.messageId)).toEqual(["due_early", "due_late"]);

    // The cap applies to the DUE set, not the full table.
    expect(store.loadDueMissingAttachments(now, 1).map((record) => record.messageId)).toEqual(["due_early"]);
  });

  it("wipeAll clears missing-attachment work items too", () => {
    store.addMissingAttachment({
      messageId: "msg_1",
      attachmentId: "att_1",
      mimeType: "image/png",
      peerUrl: "http://peer.example",
    });

    store.wipeAll();

    expect(store.loadMissingAttachments()).toEqual([]);
  });

  it("migrates a pre-horizon-GC tombstones table by backfilling created_at", () => {
    // Simulate a database created before the `created_at` column existed: open a fresh file-backed
    // store, drop its `tombstones` table and re-create the bare-bones (pre-migration) shape, write a
    // tombstone the old way, then reopen through `openStore` (which runs the migration) and confirm
    // the row is usable — present, and not immediately prunable.
    const dataDir = mkdtempSync(join(tmpdir(), "loam-db-migration-test-"));
    const dbPath = join(dataDir, "loam.db");

    try {
      const initial = openStore(dbPath);
      initial.close();

      const raw = new DatabaseSync(dbPath);
      raw.exec("DROP TABLE tombstones");
      raw.exec("CREATE TABLE tombstones (message_id TEXT PRIMARY KEY)");
      raw.prepare("INSERT INTO tombstones (message_id) VALUES (?)").run("msg_legacy");
      raw.close();

      const reopened = openStore(dbPath);
      try {
        expect(reopened.loadTombstones()).toEqual(["msg_legacy"]);
        // Backfilled to "now", so it must not already be prunable with a past cutoff.
        expect(reopened.pruneTombstonesOlderThan(Date.now() - 60_000)).toEqual([]);
        expect(reopened.loadTombstones()).toEqual(["msg_legacy"]);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("migrates a pre-backoff missing_attachments table by backfilling last_attempt_at (F1)", () => {
    // Simulate a database created before retry-backoff existed: drop and re-create the bare-bones
    // (pre-`last_attempt_at`) shape, write a row the old way, then reopen through `openStore` (which
    // runs the migration) and confirm it's usable with the new column defaulted to 0 ("never
    // attempted" — due immediately, matching the old no-backoff behaviour those rows already had).
    const dataDir = mkdtempSync(join(tmpdir(), "loam-db-migration-test-"));
    const dbPath = join(dataDir, "loam.db");

    try {
      const initial = openStore(dbPath);
      initial.close();

      const raw = new DatabaseSync(dbPath);
      raw.exec("DROP TABLE missing_attachments");
      raw.exec(`
        CREATE TABLE missing_attachments (
          message_id TEXT NOT NULL,
          attachment_id TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          peer_url TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (message_id, attachment_id)
        )
      `);
      raw
        .prepare(
          "INSERT INTO missing_attachments (message_id, attachment_id, mime_type, peer_url, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("msg_legacy", "att_legacy", "image/png", "http://peer.example", 3, Date.now());
      raw.close();

      const reopened = openStore(dbPath);
      try {
        const [record] = reopened.loadMissingAttachments();
        expect(record).toMatchObject({
          messageId: "msg_legacy",
          attachmentId: "att_legacy",
          attempts: 3,
          lastAttemptAt: 0,
        });
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("migrates a pre-fair-retry missing_attachments table by backfilling next_attempt_at (P2-2)", () => {
    // Simulate a database created before fair-ordered due-selection existed: has `last_attempt_at`
    // (an earlier migration) but not yet `next_attempt_at`. Reopening through `openStore` must backfill
    // it to 0 ("due immediately"), so pre-existing rows become eligible on the very next pass rather
    // than being silently excluded from `loadDueMissingAttachments` forever.
    const dataDir = mkdtempSync(join(tmpdir(), "loam-db-migration-test-"));
    const dbPath = join(dataDir, "loam.db");

    try {
      const initial = openStore(dbPath);
      initial.close();

      const raw = new DatabaseSync(dbPath);
      raw.exec("DROP TABLE missing_attachments");
      raw.exec(`
        CREATE TABLE missing_attachments (
          message_id TEXT NOT NULL,
          attachment_id TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          peer_url TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          last_attempt_at INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (message_id, attachment_id)
        )
      `);
      raw
        .prepare(
          "INSERT INTO missing_attachments (message_id, attachment_id, mime_type, peer_url, attempts, created_at, last_attempt_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("msg_legacy", "att_legacy", "image/png", "http://peer.example", 3, Date.now(), Date.now());
      raw.close();

      const reopened = openStore(dbPath);
      try {
        const [record] = reopened.loadMissingAttachments();
        expect(record).toMatchObject({
          messageId: "msg_legacy",
          attachmentId: "att_legacy",
          attempts: 3,
          nextAttemptAt: 0,
        });
        // Backfilled to due-immediately, so it's picked up by the fair-selection query too.
        expect(reopened.loadDueMissingAttachments(Date.now(), 100).map((r) => r.messageId)).toEqual(["msg_legacy"]);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("importLegacyJsonData", () => {
  let dataDir: string;
  let store: LoamStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "loam-db-test-"));
    store = openStore(join(dataDir, "loam.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function writeLegacyFiles(): void {
    writeFileSync(join(dataDir, "users.json"), JSON.stringify([makeUser("user.1234", { isAdmin: true })]));
    writeFileSync(join(dataDir, "channels.json"), JSON.stringify([makeChannel("general")]));
    writeFileSync(join(dataDir, "messages.json"), JSON.stringify(allMessageVariants));
    writeFileSync(
      join(dataDir, "sessions.json"),
      JSON.stringify([
        { token: "token-a", userId: "user.1234" },
        { token: "", userId: "user.invalid" },
        { junk: true },
      ]),
    );
  }

  it("returns false when no legacy files exist", () => {
    expect(importLegacyJsonData(store, dataDir)).toBe(false);
  });

  it("imports legacy files, skips invalid sessions, and renames files to .bak", () => {
    writeLegacyFiles();

    expect(importLegacyJsonData(store, dataDir)).toBe(true);

    expect(store.loadUsers()).toEqual([makeUser("user.1234", { isAdmin: true })]);
    expect(store.loadChannels()).toEqual([makeChannel("general")]);
    expect(store.loadMessages()).toEqual(allMessageVariants);
    expect(store.loadSessions()).toEqual([{ token: "token-a", userId: "user.1234" }]);

    for (const file of ["users", "channels", "messages", "sessions"]) {
      expect(existsSync(join(dataDir, `${file}.json`))).toBe(false);
      expect(existsSync(join(dataDir, `${file}.json.bak`))).toBe(true);
    }

    expect(JSON.parse(readFileSync(join(dataDir, "users.json.bak"), "utf8"))).toHaveLength(1);
  });

  it("does not import into a non-empty store", () => {
    store.upsertUser(makeUser("user.existing"));
    writeLegacyFiles();

    expect(importLegacyJsonData(store, dataDir)).toBe(false);
    expect(store.loadUsers()).toEqual([makeUser("user.existing")]);
    expect(existsSync(join(dataDir, "users.json"))).toBe(true);
  });

  it("rolls back and keeps legacy files when a row is corrupt", () => {
    writeLegacyFiles();
    writeFileSync(join(dataDir, "messages.json"), JSON.stringify([{ id: "msg_bad", type: "channelPost" }]));

    expect(() => importLegacyJsonData(store, dataDir)).toThrow();
    expect(store.isEmpty()).toBe(true);
    expect(existsSync(join(dataDir, "users.json"))).toBe(true);
    expect(existsSync(join(dataDir, "users.json.bak"))).toBe(false);
  });
});

describe("encrypted store (SQLCipher via better-sqlite3-multiple-ciphers)", () => {
  let dataDir: string;
  let dbPath: string;
  const KEY = "correct horse battery staple";

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "loam-enc-test-"));
    dbPath = join(dataDir, "loam.db");
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("round-trips every entity through the same DAL surface as node:sqlite", () => {
    const store = openStore(dbPath, { encryptionKey: KEY });
    try {
      store.upsertUser(makeUser("user.enc"));
      store.upsertChannel(makeChannel("general"));
      for (const message of allMessageVariants) {
        store.insertMessage(message);
      }
      store.putSession("tok", "user.enc");
      store.setConfigValue("k", "v");

      expect(store.loadUsers()).toEqual([makeUser("user.enc")]);
      expect(store.loadChannels()).toEqual([makeChannel("general")]);
      expect(store.loadMessages()).toEqual(allMessageVariants);
      expect(store.loadSessions()).toEqual([{ token: "tok", userId: "user.enc" }]);
      expect(store.getConfigValue("k")).toBe("v");
    } finally {
      store.close();
    }
  });

  it("writes an encrypted file — message plaintext never touches disk, incl. WAL sidecars", () => {
    const store = openStore(dbPath, { encryptionKey: KEY });
    try {
      // Two distinct sentinels — a message body and a user display name — so we assert that neither
      // kind of user content reaches disk in the clear.
      store.insertMessage({ ...makeChannelPost("msg_secret", 1_704_067_200_000), body: "MESSAGE_BODY_NEEDLE" });
      store.upsertUser(makeUser("user.needle", { displayName: "DISPLAY_NAME_NEEDLE" }));

      // Scan every file in the data dir WHILE the store is open — WAL mode may hold recent writes in
      // the -wal sidecar before checkpoint, so checking only the main DB (or only after close) could
      // miss plaintext. SQLCipher encrypts the WAL too, so nothing should leak anywhere.
      const needles = [Buffer.from("MESSAGE_BODY_NEEDLE"), Buffer.from("DISPLAY_NAME_NEEDLE")];
      const files = readdirSync(dataDir);
      expect(files.some((name) => name.startsWith("loam.db"))).toBe(true);
      for (const name of files) {
        const raw = readFileSync(join(dataDir, name));
        for (const needle of needles) {
          expect(raw.includes(needle)).toBe(false);
        }
      }
      expect(readFileSync(dbPath).subarray(0, 15).toString("ascii")).not.toBe("SQLite format 3");
    } finally {
      store.close();
    }
  });

  it("persists across reopen with the right key and rejects the wrong key", () => {
    const first = openStore(dbPath, { encryptionKey: KEY });
    first.upsertUser(makeUser("user.persist"));
    first.close();

    const reopened = openStore(dbPath, { encryptionKey: KEY });
    try {
      expect(reopened.loadUsers()).toEqual([makeUser("user.persist")]);
    } finally {
      reopened.close();
    }

    // openStore closes its own connection when setup fails, so no handle leaks here.
    expect(() => openStore(dbPath, { encryptionKey: "the wrong key entirely" })).toThrow();
  });

  it("refuses to key an in-memory database", () => {
    expect(() => openStore(":memory:", { encryptionKey: KEY })).toThrow(/in-memory/);
  });

  it("wipeAll clears an encrypted store", () => {
    const store = openStore(dbPath, { encryptionKey: KEY });
    try {
      store.upsertUser(makeUser("user.enc"));
      store.insertMessage(makeChannelPost("msg_1"));
      store.wipeAll();
      expect(store.isEmpty()).toBe(true);
    } finally {
      store.close();
    }
  });

  // P1-2 (docs/15, Sol round 3): a FIXED (persistent/passphrase) key can't be rotated in-process — the
  // real recovery is "delete the ciphertext, clear the Keystore key, restart" so the NEXT boot resolves
  // a genuinely NEW key together with a fresh database. These two tests simulate exactly that cold
  // restart at the store level (openStore stands in for what a fresh boot does), for both modes that
  // use a fixed key — see executeKillSwitch's `fixedKeyMode` branch in app.ts for the in-process half.
  it("P1-2 persistent-mode cold restart: delete + reopen under a NEW key produces a fresh DB the OLD key can no longer open", () => {
    const keyA = "persistent-mode-key-A";
    const original = openStore(dbPath, { encryptionKey: keyA });
    original.upsertUser(makeUser("user.doomed"));
    original.insertMessage(makeChannelPost("msg_before_wipe"));
    original.close();

    // What executeKillSwitch's fixedKeyMode branch does: close + delete the ciphertext (and its WAL/SHM
    // sidecars), then hand off — here, simulated directly as "the next boot resolves a new key".
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
    expect(existsSync(dbPath)).toBe(false);

    const keyB = "persistent-mode-key-B"; // resolveDbKey('persistent') generates a genuinely new one
    const fresh = openStore(dbPath, { encryptionKey: keyB });
    try {
      expect(fresh.loadUsers()).toEqual([]); // no memory of the wiped data
      expect(fresh.loadMessages()).toEqual([]);
      fresh.upsertUser(makeUser("user.after"));
      expect(fresh.loadUsers()).toEqual([makeUser("user.after")]);
    } finally {
      fresh.close();
    }

    // The OLD key can never open the new file — it's an entirely different database, not a rekey.
    expect(() => openStore(dbPath, { encryptionKey: keyA })).toThrow();
  });

  it("P1-2 passphrase-mode cold restart: same lifecycle — delete + reopen under a NEW derived key locks out the OLD passphrase's key", () => {
    // passphrase mode derives its SQLCipher key from an operator passphrase (db-encryption.ts's
    // resolveDbKey — a SHA-256 pass, unrelated to this store-level test, which only cares that the
    // RESULTING key string changes across the restart, exactly as it would for persistent mode above.
    const keyA = "sha256-of-the-old-passphrase";
    const original = openStore(dbPath, { encryptionKey: keyA });
    original.upsertUser(makeUser("user.doomed"));
    original.close();

    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }

    const keyB = "sha256-of-a-brand-new-passphrase";
    const fresh = openStore(dbPath, { encryptionKey: keyB });
    try {
      expect(fresh.loadUsers()).toEqual([]);
    } finally {
      fresh.close();
    }

    expect(() => openStore(dbPath, { encryptionKey: keyA })).toThrow();
  });

  // P1-1 (Sol round 4): exercises the EXACT key-derivation formula `resolveDbKey` uses
  // (apps/app/src/lib/db-encryption.ts) — reimplemented here with Node's own `crypto` (SHA-256,
  // lowercase hex, identical output to `expo-crypto`'s `digestStringAsync`) since that module depends on
  // expo-secure-store/expo-crypto and apps/app has no test runner. `deviceSecret` stands in for the
  // Keystore-held `loam-db-encryption-device-secret` item; "wipe" is simulated by discarding secret-A
  // and minting a fresh secret-B, exactly what `clearStoredDbKeys` + the next `resolveDbKey` call do.
  function sha256Hex(input: string): string {
    return createHash("sha256").update(input, "utf8").digest("hex");
  }

  it("P1-1 persistent mode: the key IS the device secret — wiping (discarding secret-A, minting secret-B) opens a fresh DB under key-B that key-A can never open, and no plaintext DB is ever created", () => {
    const deviceSecretA = "device-secret-a-32-random-bytes-hex";
    // 'persistent' mode: key = deviceSecret, verbatim (see resolveDbKey's 'persistent' branch).
    const keyA = deviceSecretA;

    const original = openStore(dbPath, { encryptionKey: keyA });
    original.upsertUser(makeUser("user.doomed"));
    original.insertMessage(makeChannelPost("msg_before_wipe"));
    original.close();
    // Sanity: the file that exists is genuinely encrypted, not a plaintext fallback.
    expect(readFileSync(dbPath).subarray(0, 15).toString("ascii")).not.toBe("SQLite format 3");

    // executeKillSwitchBody's fixed-key branch: delete the ciphertext, hand off for a restart.
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
    expect(existsSync(dbPath)).toBe(false);

    // clearStoredDbKeys deletes the OLD device secret; the NEXT resolveDbKey('persistent') call mints a
    // genuinely new one (getOrCreateDeviceSecret) — never reusing secret-A.
    const deviceSecretB = "device-secret-b-a-totally-different-value";
    expect(deviceSecretB).not.toBe(deviceSecretA);
    const keyB = deviceSecretB;

    const fresh = openStore(dbPath, { encryptionKey: keyB });
    try {
      expect(fresh.loadUsers()).toEqual([]); // no memory of the wiped data
      expect(fresh.loadMessages()).toEqual([]);
      fresh.upsertUser(makeUser("user.after"));
      expect(fresh.loadUsers()).toEqual([makeUser("user.after")]);
      // Still genuinely encrypted — NEVER a plaintext fallback for this mode.
      expect(readFileSync(dbPath).subarray(0, 15).toString("ascii")).not.toBe("SQLite format 3");
      expect(() => openStore(dbPath, { driver: "node-sqlite" })).toThrow(); // not openable plaintext either
    } finally {
      fresh.close();
    }

    // The OLD device-secret-derived key can never open the new (post-wipe) file.
    expect(() => openStore(dbPath, { encryptionKey: keyA })).toThrow();
  });

  it("P1-1 passphrase mode: SAME passphrase + a freshly-minted device secret still yields a brand-new key — wiping opens a fresh DB the OLD passphrase-derived key can never open, and no plaintext DB is ever created", () => {
    const passphrase = "the operator's unchanged passphrase";
    const deviceSecretA = "device-secret-a-32-random-bytes-hex";
    // 'passphrase' mode: key = SHA256(passphrase + ':' + deviceSecret) — see resolveDbKey's 'passphrase'
    // branch. The passphrase itself is UNCHANGED across the wipe (clearStoredDbKeys never deletes it).
    const keyA = sha256Hex(`${passphrase}:${deviceSecretA}`);

    const original = openStore(dbPath, { encryptionKey: keyA });
    original.upsertUser(makeUser("user.doomed"));
    original.close();
    expect(readFileSync(dbPath).subarray(0, 15).toString("ascii")).not.toBe("SQLite format 3");

    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }

    // A wipe deletes ONLY the device secret (never the passphrase) — the very next boot's
    // getOrCreateDeviceSecret mints a fresh one, and the SAME passphrase combined with it still
    // produces a completely different digest.
    const deviceSecretB = "device-secret-b-a-totally-different-value";
    const keyB = sha256Hex(`${passphrase}:${deviceSecretB}`);
    expect(keyB).not.toBe(keyA);

    const fresh = openStore(dbPath, { encryptionKey: keyB });
    try {
      expect(fresh.loadUsers()).toEqual([]);
      expect(readFileSync(dbPath).subarray(0, 15).toString("ascii")).not.toBe("SQLite format 3");
      expect(() => openStore(dbPath, { driver: "node-sqlite" })).toThrow();
    } finally {
      fresh.close();
    }

    // The SAME passphrase alone (keyed to the OLD, now-discarded device secret) can never open the new
    // (post-wipe) file — proving the wipe genuinely rotated the key even though the passphrase survived.
    expect(() => openStore(dbPath, { encryptionKey: keyA })).toThrow();
  });

  describe("rekey (P1-1, Sol round 5 — passphrase key-derivation migration)", () => {
    it("re-encrypts an already-open store under a new key in place: the old key stops opening it, the new key opens it, and data survives", () => {
      // Simulates exactly the scenario `openInitialStore` (app.ts) migrates: an EXISTING passphrase DB
      // encrypted under the pre-round-4 derivation `SHA256(passphrase)` (legacyKey) needs to end up
      // openable under the round-4+ derivation `SHA256(passphrase + ':' + deviceSecret)` (currentKey),
      // with its data intact and the OLD key no longer usable.
      const passphrase = "the operator's passphrase, unchanged across the migration";
      const legacyKey = sha256Hex(passphrase);
      const deviceSecret = "device-secret-32-random-bytes-hex";
      const currentKey = sha256Hex(`${passphrase}:${deviceSecret}`);
      expect(currentKey).not.toBe(legacyKey);

      // Create the "existing" DB under the legacy derivation (pre-round-4 install).
      const legacy = openStore(dbPath, { encryptionKey: legacyKey });
      legacy.upsertUser(makeUser("user.pre-round-4"));
      legacy.insertMessage(makeChannelPost("msg_pre_migration"));

      // The migration itself: rekey the SAME open connection to the current derivation.
      legacy.rekey(currentKey);
      // The rekeyed connection is immediately usable under the new key without reopening.
      expect(legacy.loadUsers()).toEqual([makeUser("user.pre-round-4")]);
      legacy.close();

      // The OLD (legacy) key can no longer open the file at all.
      expect(() => openStore(dbPath, { encryptionKey: legacyKey })).toThrow();

      // The NEW (current) key opens it, with every row intact.
      const migrated = openStore(dbPath, { encryptionKey: currentKey });
      try {
        expect(migrated.loadUsers()).toEqual([makeUser("user.pre-round-4")]);
        expect(migrated.loadMessages()).toEqual([makeChannelPost("msg_pre_migration")]);
      } finally {
        migrated.close();
      }
    });

    it("throws when called on a plaintext (unencrypted) store — there is no key to rotate", () => {
      const plain = openStore(dbPath);
      try {
        expect(() => plain.rekey("anything")).toThrow();
      } finally {
        plain.close();
      }
    });
  });

  describe("checkpoint (RF6-e, Sol round 6 — verify the WAL was actually truncated)", () => {
    it("folds committed WAL frames into the main file and truncates the WAL to zero (busy=0, no throw)", () => {
      const store = openStore(dbPath, { encryptionKey: KEY });
      try {
        store.insertMessage(makeChannelPost("msg_wal_resident"));
        // Precondition: the write lives in a non-empty -wal sidecar before the checkpoint.
        expect(existsSync(`${dbPath}-wal`)).toBe(true);
        expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);

        // Sole connection → TRUNCATE returns busy=0 and this returns normally (does not throw).
        expect(() => store.checkpoint()).not.toThrow();

        // TRUNCATE reset the WAL to zero bytes; the row is now folded into the main file.
        expect(statSync(`${dbPath}-wal`).size).toBe(0);
        expect(store.loadMessages()).toEqual([makeChannelPost("msg_wal_resident")]);
      } finally {
        store.close();
      }
    });

    it("throws when called on a plaintext (unencrypted) store — no pragma handle to checkpoint through", () => {
      const plain = openStore(dbPath);
      try {
        expect(() => plain.checkpoint()).toThrow(/encryptionKey|plaintext/);
      } finally {
        plain.close();
      }
    });
  });
});
