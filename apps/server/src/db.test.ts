import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

    store.bumpMissingAttachmentAttempts("msg_1", "att_1");
    store.bumpMissingAttachmentAttempts("msg_1", "att_1");
    expect(store.loadMissingAttachments()[0]?.attempts).toBe(2);

    store.clearMissingAttachment("msg_1", "att_1");
    expect(store.loadMissingAttachments()).toEqual([]);
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
});
