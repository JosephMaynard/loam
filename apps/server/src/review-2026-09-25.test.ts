import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp, type LoamApp } from "./app.js";
import type { AppOptions } from "./types.js";

/**
 * Pre-release review 2026-09-25 — sync / mesh / kill-switch / transport fixes. Each security test here
 * was mutation-checked: with its fix reverted, it fails.
 */

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

/** A fresh app on its own temp data dir (optional config.json + options), cleaned up after the test. */
async function makeApp(config?: unknown, opts?: Partial<AppOptions>): Promise<{ app: LoamApp; dataDir: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), "loam-review-0925-"));
  if (config !== undefined) {
    writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  }
  const app = await buildApp({ dataDir, logger: false, maxNewIdentitiesPerWindow: 1_000_000, ...opts });
  cleanups.push(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { app, dataDir };
}

/** A fresh cookie session (the first one on a firstUser node is the admin). */
async function newSession(app: LoamApp): Promise<{ cookie: string; userId: string }> {
  const response = await app.server.inject({ method: "GET", url: "/api/config" });
  const setCookie = response.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";")[0];
  if (!cookie) {
    throw new Error("no session cookie");
  }
  return { cookie, userId: (response.json() as { currentUser: { id: string } }).currentUser.id };
}

describe("Emergency Reset sweeps preserve-recovery snapshots in every branch (#7)", () => {
  /** Plant a `.loam-recovery-*` snapshot dir (with an old DB copy) + the recovery anchor after boot. */
  function plantRecoveryArtifacts(dataDir: string): string[] {
    const snapshot = join(dataDir, ".loam-recovery-1700000000000-abcd");
    mkdirSync(join(snapshot, "avatars"), { recursive: true });
    writeFileSync(join(snapshot, "loam.db"), "old still-readable database");
    writeFileSync(join(snapshot, "avatars", "a.png"), "old avatar");
    const anchor = join(dataDir, ".loam-recovery-state");
    writeFileSync(anchor, ".loam-recovery-1700000000000-abcd");
    return [snapshot, anchor];
  }

  async function wipe(app: LoamApp): Promise<number> {
    const admin = await newSession(app);
    const res = await app.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });
    return res.statusCode;
  }

  it("plaintext (logical) wipe removes the snapshot dir and the anchor", async () => {
    const { app, dataDir } = await makeApp({ killSwitch: { enabled: true } });
    const planted = plantRecoveryArtifacts(dataDir);
    expect(await wipe(app)).toBe(200);
    for (const path of planted) {
      expect(existsSync(path)).toBe(false);
    }
  });

  it("ephemeral-key (cryptographic) wipe removes the snapshot dir and the anchor", async () => {
    const { app, dataDir } = await makeApp(
      { killSwitch: { enabled: true } },
      { ephemeralDbKey: true, dbEncryptionMode: "ephemeral" },
    );
    const planted = plantRecoveryArtifacts(dataDir);
    expect(await wipe(app)).toBe(200);
    for (const path of planted) {
      expect(existsSync(path)).toBe(false);
    }
  });
});
