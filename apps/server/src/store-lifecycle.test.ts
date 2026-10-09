// Boot-time care of the data dir in store-lifecycle.ts: an ephemeral-key node booting a
// second time over its own previous database, the refusal to destroy a persistent database under an
// ephemeral key, the `.loam-db-ephemeral` marker contract shared with the Android launcher, and the file
// modes the node keeps on a shared computer (data dir 0700, database files and config writes 0600).
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type LoamApp } from "./app.js";
import { DbEphemeralExistingDatabaseError, DbEphemeralMarkerUnremovableError, DbEphemeralMarkerUnwritableError } from "./errors.js";
import { createStoreLifecycle } from "./store-lifecycle.js";
import type { AppOptions } from "./types.js";

// Filesystem faults on one exact path: `writeFileSync`, `openSync` or `rmSync` of that path throws EIO. Inert
// unless a test arms it; reset after every test.
const fsFaults = vi.hoisted(() => ({
  writeFileSync: undefined as string | undefined,
  openSync: undefined as string | undefined,
  rmSync: undefined as string | undefined,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const simulatedEio = (call: string, path: string): Error =>
    Object.assign(new Error(`simulated EIO: ${call} ${path}`), { code: "EIO" });
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (fsFaults.writeFileSync !== undefined && String(args[0]) === fsFaults.writeFileSync) {
        throw simulatedEio("write", fsFaults.writeFileSync);
      }
      return actual.writeFileSync(...args);
    },
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      if (fsFaults.openSync !== undefined && String(args[0]) === fsFaults.openSync) {
        throw simulatedEio("open", fsFaults.openSync);
      }
      return actual.openSync(...args);
    },
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      if (fsFaults.rmSync !== undefined && String(args[0]) === fsFaults.rmSync) {
        throw simulatedEio("remove", fsFaults.rmSync);
      }
      return actual.rmSync(...args);
    },
  };
});

const MARKER = ".loam-db-ephemeral";
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  fsFaults.writeFileSync = undefined;
  fsFaults.openSync = undefined;
  fsFaults.rmSync = undefined;
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

/** A fresh temp dir, removed after the test. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loam-lifecycle-test-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Boot a node in `dataDir`; `close` is safe to call more than once (the cleanup calls it too). */
async function boot(dataDir: string, opts: Partial<AppOptions> = {}): Promise<{ app: LoamApp; close: () => Promise<void> }> {
  const app = await buildApp({ dataDir, logger: false, requireRulesAcceptance: false, ...opts });
  let closed = false;
  const close = async (): Promise<void> => {
    if (!closed) {
      closed = true;
      await app.close();
    }
  };
  cleanups.push(close);
  return { app, close };
}

/** Mint an anonymous session and return its cookie. */
async function sessionCookie(app: LoamApp): Promise<string> {
  const response = await app.server.inject({ method: "GET", url: "/api/config" });
  const header = response.headers["set-cookie"];
  const raw = Array.isArray(header) ? header[0] : header;
  return String(raw).split(";")[0];
}

async function postToGeneral(app: LoamApp, cookie: string, body: string): Promise<number> {
  const response = await app.server.inject({
    method: "POST",
    url: "/api/messages",
    headers: { cookie },
    payload: { type: "channelPost", channelId: "general", body },
  });
  return response.statusCode;
}

function hasPost(app: LoamApp, body: string): boolean {
  return app.store.loadMessages().some((message) => message.type === "channelPost" && message.body === body);
}

describe("ephemeral key across boots", () => {
  it("boots again over its own previous database, starting empty with last boot's media gone", async () => {
    const dataDir = tempDir();
    const first = await boot(dataDir, { ephemeralDbKey: true });
    const cookie = await sessionCookie(first.app);
    expect(await postToGeneral(first.app, cookie, "FIRST_BOOT_NEEDLE")).toBe(201);
    // Stand-ins for uploads of the dead key's network: with the database gone they would be orphans forever.
    mkdirSync(join(dataDir, "avatars"), { recursive: true });
    writeFileSync(join(dataDir, "avatars", "avt_0123456789abcdef.webp"), "stale avatar");
    mkdirSync(join(dataDir, "attachments"), { recursive: true });
    writeFileSync(join(dataDir, "attachments", "att_0123456789abcdef.bin"), "stale attachment");
    await first.close();

    expect(existsSync(join(dataDir, MARKER))).toBe(true);
    expect(existsSync(join(dataDir, "loam.db"))).toBe(true);
    const markerBefore = readFileSync(join(dataDir, MARKER), "utf8");
    await new Promise((resolve) => setTimeout(resolve, 2));

    // Used to throw DbEncryptionUnreadableError: the file was encrypted under a key nobody has any more.
    const second = await boot(dataDir, { ephemeralDbKey: true });
    expect(second.app.store.loadMessages()).toEqual([]);
    expect(hasPost(second.app, "FIRST_BOOT_NEEDLE")).toBe(false);
    expect(existsSync(join(dataDir, "avatars"))).toBe(false);
    expect(existsSync(join(dataDir, "attachments"))).toBe(false);
    // The marker is written afresh for the boot after this one (same contents as the launcher's: a timestamp).
    const markerAfter = readFileSync(join(dataDir, MARKER), "utf8");
    expect(markerAfter).toMatch(/^\d+$/);
    expect(markerAfter).not.toBe(markerBefore);
    // And the node is usable.
    const again = await sessionCookie(second.app);
    expect(await postToGeneral(second.app, again, "second boot")).toBe(201);
  });

  it("refuses to destroy a persistent database (no marker) and leaves it untouched", async () => {
    const dataDir = tempDir();
    const plain = await boot(dataDir);
    const cookie = await sessionCookie(plain.app);
    expect(await postToGeneral(plain.app, cookie, "KEEP_ME")).toBe(201);
    await plain.close();
    expect(existsSync(join(dataDir, MARKER))).toBe(false);
    const before = readFileSync(join(dataDir, "loam.db"));

    const error: unknown = await buildApp({ dataDir, logger: false, requireRulesAcceptance: false, ephemeralDbKey: true }).then(
      async (app) => {
        await app.close();
        return undefined;
      },
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(DbEphemeralExistingDatabaseError);
    const { code, message } = error as DbEphemeralExistingDatabaseError;
    expect(code).toBe("db_ephemeral_existing_database");
    expect(message).toContain(dataDir);
    expect(message).toContain("--data-dir");
    expect(message).toContain("LOAM_DB_KEY");
    expect(message).not.toMatch(/wrong|lost/i);

    expect(readFileSync(join(dataDir, "loam.db")).equals(before)).toBe(true);
    expect(existsSync(join(dataDir, MARKER))).toBe(false);
    const reopened = await boot(dataDir);
    expect(hasPost(reopened.app, "KEEP_ME")).toBe(true);
  });

  it("honours a marker the launcher wrote and clears it on a non-ephemeral boot", async () => {
    // The Android launcher deletes the stale database and writes the marker BEFORE booting the server.
    const dataDir = tempDir();
    writeFileSync(join(dataDir, MARKER), "1700000000000", "utf8");
    const ephemeral = await boot(dataDir, { ephemeralDbKey: true });
    expect(ephemeral.app.store.loadMessages()).toEqual([]);
    expect(readFileSync(join(dataDir, MARKER), "utf8")).not.toBe("1700000000000");
    await ephemeral.close();

    // A plaintext (or fixed-key) boot clears the marker, as the launcher does, so the database it writes is
    // never later taken for ephemeral leftovers.
    const plainDir = tempDir();
    writeFileSync(join(plainDir, MARKER), String(Date.now()), "utf8");
    const plain = await boot(plainDir);
    expect(existsSync(join(plainDir, MARKER))).toBe(false);
    const cookie = await sessionCookie(plain.app);
    expect(await postToGeneral(plain.app, cookie, "PERSISTENT")).toBe(201);
    await plain.close();
    const refused: unknown = await buildApp({ dataDir: plainDir, logger: false, requireRulesAcceptance: false, ephemeralDbKey: true }).then(
      async (app) => {
        await app.close();
        return undefined;
      },
      (reason: unknown) => reason,
    );
    expect(refused).toBeInstanceOf(DbEphemeralExistingDatabaseError);
  });
});

/** Boot with an ephemeral key in `dataDir` and return the error the boot failed with (undefined if it booted). */
async function ephemeralBootError(dataDir: string): Promise<unknown> {
  return buildApp({ dataDir, logger: false, requireRulesAcceptance: false, ephemeralDbKey: true }).then(
    async (app) => {
      await app.close();
      return undefined;
    },
    (reason: unknown) => reason,
  );
}

describe("ephemeral-key marker before the database", () => {
  it("refuses to boot, creating no database, when the marker can't be written", async () => {
    const dataDir = tempDir();
    fsFaults.writeFileSync = join(dataDir, MARKER);

    const error = await ephemeralBootError(dataDir);
    expect(error).toBeInstanceOf(DbEphemeralMarkerUnwritableError);
    const { code, message } = error as DbEphemeralMarkerUnwritableError;
    expect(code).toBe("db_ephemeral_marker_unwritable");
    expect(message).toContain(join(dataDir, MARKER));
    expect(message).toContain("simulated EIO");
    expect(message).toContain("--data-dir");
    // The marker is written before the store opens, so the failed boot left no database for the next
    // ephemeral boot to mistake for a persistent one.
    expect(existsSync(join(dataDir, "loam.db"))).toBe(false);
    expect(existsSync(join(dataDir, MARKER))).toBe(false);

    // Once the fault clears, the same data dir boots, and boots again over its own leftovers.
    fsFaults.writeFileSync = undefined;
    const first = await boot(dataDir, { ephemeralDbKey: true });
    expect(existsSync(join(dataDir, MARKER))).toBe(true);
    await first.close();
    const second = await boot(dataDir, { ephemeralDbKey: true });
    expect(second.app.store.loadMessages()).toEqual([]);
  });

  it("refuses to boot over the previous boot's leftovers when the fresh marker can't be written", async () => {
    const dataDir = tempDir();
    const first = await boot(dataDir, { ephemeralDbKey: true });
    await first.close();
    expect(existsSync(join(dataDir, "loam.db"))).toBe(true);

    fsFaults.writeFileSync = join(dataDir, MARKER);
    expect(await ephemeralBootError(dataDir)).toBeInstanceOf(DbEphemeralMarkerUnwritableError);
    // The dead key's database went as usual; no new one was opened in its place.
    expect(existsSync(join(dataDir, "loam.db"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("refuses to boot when the data directory can't be flushed after the marker", async () => {
    const dataDir = tempDir();
    fsFaults.openSync = dataDir;

    const error = await ephemeralBootError(dataDir);
    expect(error).toBeInstanceOf(DbEphemeralMarkerUnwritableError);
    expect((error as Error).message).toContain("could not be flushed");
    expect(existsSync(join(dataDir, "loam.db"))).toBe(false);
  });
});

describe("stale ephemeral-key marker on a boot that keeps its database", () => {
  const KEY = "a fixed host passphrase";

  /** A fixed-key database with one post in it, closed, and a marker an earlier ephemeral boot left beside it. */
  async function fixedKeyDirWithStaleMarker(): Promise<{ dataDir: string; before: Buffer }> {
    const dataDir = tempDir();
    const first = await boot(dataDir, { dbEncryptionKey: KEY });
    const cookie = await sessionCookie(first.app);
    expect(await postToGeneral(first.app, cookie, "KEEP_ME")).toBe(201);
    await first.close();
    writeFileSync(join(dataDir, MARKER), "1700000000000", "utf8");
    return { dataDir, before: readFileSync(join(dataDir, "loam.db")) };
  }

  /** Boot with the fixed key and return the error the boot failed with (undefined if it booted). */
  async function fixedKeyBootError(dataDir: string): Promise<unknown> {
    return buildApp({ dataDir, logger: false, requireRulesAcceptance: false, dbEncryptionKey: KEY }).then(
      async (app) => {
        await app.close();
        return undefined;
      },
      (reason: unknown) => reason,
    );
  }

  it("refuses a fixed-key boot that cannot remove a stale ephemeral marker, leaving the database untouched", async () => {
    const { dataDir, before } = await fixedKeyDirWithStaleMarker();
    fsFaults.rmSync = join(dataDir, MARKER);

    const error = await fixedKeyBootError(dataDir);
    expect(error).toBeInstanceOf(DbEphemeralMarkerUnremovableError);
    const { code, message } = error as DbEphemeralMarkerUnremovableError;
    expect(code).toBe("db_ephemeral_marker_unremovable");
    expect(message).toContain(join(dataDir, MARKER));
    expect(message).toContain("simulated EIO");
    expect(message).toContain("by hand");
    // Refused before the open: the database is byte-for-byte what the last boot left, and the marker stays
    // for the operator to see.
    expect(readFileSync(join(dataDir, "loam.db")).equals(before)).toBe(true);
    expect(existsSync(join(dataDir, MARKER))).toBe(true);

    // Once the marker can go, the boot removes it and serves the same data.
    fsFaults.rmSync = undefined;
    const reopened = await boot(dataDir, { dbEncryptionKey: KEY });
    expect(existsSync(join(dataDir, MARKER))).toBe(false);
    expect(hasPost(reopened.app, "KEEP_ME")).toBe(true);
  });

  it.skipIf(process.platform === "win32")("refuses a fixed-key boot when the marker's removal can't be flushed to disk", async () => {
    const { dataDir, before } = await fixedKeyDirWithStaleMarker();
    fsFaults.openSync = dataDir;

    const error = await fixedKeyBootError(dataDir);
    expect(error).toBeInstanceOf(DbEphemeralMarkerUnremovableError);
    expect((error as Error).message).toContain("could not be flushed");
    expect(readFileSync(join(dataDir, "loam.db")).equals(before)).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")("file modes on a shared computer", () => {
  it("creates the data dir 0700 and keeps the database files 0600", async () => {
    const dataDir = join(tempDir(), "node-data");
    const { app } = await boot(dataDir);
    const cookie = await sessionCookie(app);
    expect(await postToGeneral(app, cookie, "a write, so the WAL exists")).toBe(201);

    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dataDir, "loam.db")).mode & 0o777).toBe(0o600);
    for (const sidecar of ["loam.db-wal", "loam.db-shm"]) {
      if (existsSync(join(dataDir, sidecar))) {
        expect(statSync(join(dataDir, sidecar)).mode & 0o777, sidecar).toBe(0o600);
      }
    }
  });

  it("durableWriteFileSync creates files 0600 and keeps an existing file's mode", () => {
    const dataDir = tempDir();
    const lifecycle = createStoreLifecycle({
      dataDir,
      avatarsDir: join(dataDir, "avatars"),
      attachmentsDir: join(dataDir, "attachments"),
      options: { dataDir },
      log: Fastify({ logger: false }).log,
      configPath: join(dataDir, "config.json"),
      markAwaitingWipeRestart: () => {},
    });

    // The wipe journal carries the config snapshot: new, so private by default.
    const journal = join(dataDir, ".loam-wipe-phase");
    expect(lifecycle.durableWriteFileSync(journal, '{"phase":"delete-pending"}')).toBe(true);
    expect(statSync(journal).mode & 0o777).toBe(0o600);
    expect(readFileSync(journal, "utf8")).toBe('{"phase":"delete-pending"}');

    // An operator's config.json keeps the mode they gave it when a wipe rewrites it.
    const config = join(dataDir, "config.json");
    writeFileSync(config, "{}", "utf8");
    chmodSync(config, 0o640);
    expect(lifecycle.durableWriteFileSync(config, '{"node":{"name":"after"}}')).toBe(true);
    expect(statSync(config).mode & 0o777).toBe(0o640);
    expect(readFileSync(config, "utf8")).toBe('{"node":{"name":"after"}}');
  });
});
