import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  currentEpoch,
  mailboxTag,
  openTransport,
  sealTransport,
  transportClientDerive,
  transportClientHello,
} from "@loam/crypto";
import {
  MeshIdentityCardSchema,
  SERVER_ERROR_CODES,
  TransportHandshakeResponseSchema,
  type MeshIdentityCard,
} from "@loam/schema";

import { ALL_ERROR_CODES, buildApp, type AppOptions, type LoamApp } from "./app.js";
import { openStore } from "./db.js";

// RF4: a single-shot fault-injection seam for `node:fs`'s `renameSync`, used ONLY by the "marker-
// confirmed recovery failure" test below to make `openInitialStore`'s rename-aside step throw
// synthetically (there's no other way to force that specific failure deterministically — the real
// call happens between two other `node:fs` calls in the same synchronous function, so OS-permission
// tricks can't isolate it). `renameFailure.armed` defaults to `undefined` (pass straight through to the
// real implementation) and self-disarms the instant it fires, so every other test in this file — which
// never arms it — is completely unaffected; every other `node:fs` export is untouched (`...actual`).
const renameFailure = vi.hoisted(() => ({ armed: false }));
// P1-d (Sol round 6): a single-shot fault-injection seam for `node:fs`'s `writeFileSync` targeting the
// `.loam-wipe-pending` marker specifically — used ONLY by the fail-closed kill-switch test below to force
// the durable-marker write to fail so the synchronous, fail-closed ciphertext-destruction path runs.
// Defaults disarmed (pass through) and self-disarms on fire, so no other test is affected; never matches
// any other `writeFileSync` caller.
const wipeMarkerWriteFailure = vi.hoisted(() => ({ armed: false }));
// P1-a (Sol round 6): a capture seam for the migration's pre-migration backup copy. When `dir` is set, the
// `copyFileSync(loam.db → loam.db.premigration.tmp)` the migration performs is mirrored to
// `<dir>/captured-backup.db`, so a test can open that single-file snapshot under the legacy key and PROVE it
// contains committed rows that were WAL-resident before the checkpoint folded them in. Inert by default.
const backupCapture = vi.hoisted(() => ({ dir: undefined as string | undefined }));
// RF6-a (Sol round 6): a capture seam recording every `rmSync` PATH argument while `paths` is a live
// array (default `undefined` = inert). Used by the foreign-`-journal` test to PROVE Step 0b explicitly
// removes `loam.db-journal` before restoring — an end-to-end "no journal after boot" check can't, since
// any successful DB open also cleans a hot journal, so it would pass even WITHOUT the fix.
const rmSyncCapture = vi.hoisted(() => ({ paths: undefined as string[] | undefined }));
// P2-2 (Sol round 7): a single-shot fault-injection seam for `node:fs`'s `rmSync` targeting ONLY the
// migration's POST-REKEY cleanup of the committed `loam.db.premigration` backup (exact `.premigration`
// path — never the `.tmp`/`-wal`/`-shm`/`-journal` sidecars, which Step 0b deletes first for a clean
// migration). Used to prove that a cleanup failure AFTER a successful rekey does NOT fail the boot / leak
// the migrated handle. Defaults disarmed (pass through) and self-disarms on fire.
const postRekeyCleanupFailure = vi.hoisted(() => ({ armed: false }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      if (rmSyncCapture.paths) {
        rmSyncCapture.paths.push(String(args[0]));
      }
      if (postRekeyCleanupFailure.armed && String(args[0]).endsWith("loam.db.premigration")) {
        postRekeyCleanupFailure.armed = false;
        throw new Error("simulated post-rekey cleanup rmSync failure (P2-2 test fault injection)");
      }
      return actual.rmSync(...args);
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (renameFailure.armed) {
        renameFailure.armed = false;
        throw new Error("simulated renameSync failure (RF4 test fault injection)");
      }
      return actual.renameSync(...args);
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (wipeMarkerWriteFailure.armed && String(args[0]).endsWith(".loam-wipe-pending")) {
        wipeMarkerWriteFailure.armed = false;
        throw new Error("simulated wipe-pending marker write failure (P1-d test fault injection)");
      }
      return actual.writeFileSync(...args);
    },
    copyFileSync: (...args: Parameters<typeof actual.copyFileSync>) => {
      const result = actual.copyFileSync(...args);
      if (backupCapture.dir && String(args[1]).endsWith(".premigration.tmp")) {
        actual.copyFileSync(String(args[1]), `${backupCapture.dir}/captured-backup.db`);
      }
      return result;
    },
  };
});

// P1-2(a): a fault/delay-injection seam for `node:fs/promises`'s `rm`, used ONLY by the "confidentiality
// window" test below to hold the fixed-key kill-switch's file-deletion awaits open while concurrent
// requests are issued — there's no other reliable way to observe what a request sees DURING that async
// window. `rmGate.promise` defaults to `undefined` (pass straight through to the real implementation),
// so every other test — which never sets it — is unaffected; every other `node:fs/promises` export is
// untouched (`...actual`).
const rmGate = vi.hoisted(() => ({ promise: undefined as Promise<void> | undefined }));
// P1-4: a matching fault/delay-injection seam, but for `writeFile` calls that target the kill switch's
// `persistConfigForRestart` tmp file specifically (`config.json.tmp-...` — never any other `writeFile`
// caller, e.g. avatar/attachment uploads) — used to prove config.json is durably persisted BEFORE the
// wipe-pending marker is written and the launcher hook is signaled (the ordering P1-4 fixes), and to
// simulate a config-persist failure (`configWriteFailures.remaining`) to exercise the retry-once +
// proceed-with-the-wipe-regardless policy. Both default to inert (`undefined`/`0`) for every other test.
const configWriteGate = vi.hoisted(() => ({ promise: undefined as Promise<void> | undefined }));
const configWriteFailures = vi.hoisted(() => ({ remaining: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (rmGate.promise) {
        await rmGate.promise;
      }
      return actual.rm(...args);
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      const target = String(args[0]);
      if (target.includes("config.json.tmp-")) {
        if (configWriteFailures.remaining > 0) {
          configWriteFailures.remaining -= 1;
          throw new Error("simulated config.json write failure (P1-4 test fault injection)");
        }
        if (configWriteGate.promise) {
          await configWriteGate.promise;
        }
      }
      return actual.writeFile(...args);
    },
  };
});

type InjectResponse = Awaited<ReturnType<LoamApp["server"]["inject"]>>;

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  // Restore real timers before tearing anything down, so a test that installed fake timers can't
  // leave `app.close()` (which awaits Fastify shutdown) or the next test running on a frozen clock.
  vi.useRealTimers();
  // Belt-and-suspenders: a test that armed the P1-2(a) `rm()` gate but failed before releasing it must
  // never leave a later, unrelated test's own `rm()` calls hanging on a promise nobody will resolve.
  rmGate.promise = undefined;
  configWriteGate.promise = undefined;
  configWriteFailures.remaining = 0;
  wipeMarkerWriteFailure.armed = false;
  backupCapture.dir = undefined;
  postRekeyCleanupFailure.armed = false;
  rmSyncCapture.paths = undefined;
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

async function makeApp(
  config?: unknown,
  opts?: Partial<AppOptions>,
): Promise<{ app: LoamApp; dataDir: string } & LoamApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "loam-app-test-"));

  if (config !== undefined) {
    writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  }

  // A high identity cap so the per-IP new-identity limiter (all inject requests share 127.0.0.1)
  // never trips across a suite that mints many sessions; a dedicated test drives it low on purpose.
  const app = await buildApp({ dataDir, logger: false, maxNewIdentitiesPerWindow: 1_000_000, ...opts });
  cleanups.push(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { ...app, app, dataDir };
}

/** Reopen an app on an existing data dir (restart simulation). */
async function reopenApp(app: LoamApp, dataDir: string): Promise<LoamApp> {
  await app.close();
  const next = await buildApp({ dataDir, logger: false });
  cleanups.push(() => next.close());
  return next;
}

function sessionCookie(response: InjectResponse): string {
  const header = response.headers["set-cookie"];
  const first = Array.isArray(header) ? header[0] : header;
  const cookie = first?.split(";")[0];

  if (!cookie?.startsWith("loam_session=")) {
    throw new Error("No session cookie in response");
  }

  return cookie;
}

async function newSession(app: LoamApp): Promise<{ cookie: string; userId: string; isAdmin: boolean }> {
  const response = await app.server.inject({ method: "GET", url: "/api/config" });
  const body = response.json() as { currentUser: { id: string; isAdmin: boolean } };
  return { cookie: sessionCookie(response), userId: body.currentUser.id, isAdmin: body.currentUser.isAdmin };
}

/** Run a docs/08 transport handshake against a node → the session id + derived client key. */
async function openTransport08(app: LoamApp): Promise<{ sessionId: string; key: string }> {
  const hello = transportClientHello();
  const res = await app.server.inject({
    method: "POST",
    url: "/api/transport/handshake",
    payload: { clientEphemeralPublic: hello.ephemeralPublic },
  });
  const body = TransportHandshakeResponseSchema.parse(res.json());
  return {
    sessionId: body.sessionId,
    key: transportClientDerive({
      clientEphemeralSecret: hello.ephemeralSecret,
      hostPublic: body.hostPublicKey,
      hostEphemeralPublic: body.hostEphemeralPublic,
    }),
  };
}

/** Seal a `{ s, b? }` anti-replay envelope (docs/08) at an explicit sequence. */
function sealSeq(key: string, seq: number, aad: string, body?: unknown): string {
  return sealTransport(key, JSON.stringify(body === undefined ? { s: seq } : { s: seq, b: body }), aad);
}

/** Bind a transport session to an identity (docs/20 resume): seal `{ token? }` at `seq`, unseal the
 *  `{ currentUser, token }` reply. Afterwards the session is `bound` and reaches content via the tunnel. */
async function resumeIdentity(
  app: LoamApp,
  session: { sessionId: string; key: string },
  seq: number,
  token?: string,
): Promise<{ status: number; currentUser: { id: string; isAdmin: boolean }; token: string }> {
  const aad = "POST /api/session/resume";
  const res = await app.server.inject({
    method: "POST",
    url: "/api/session/resume",
    headers: { "x-loam-enc": session.sessionId, "content-type": "application/json" },
    payload: { enc: sealSeq(session.key, seq, aad, token === undefined ? {} : { token }) },
  });
  if (res.statusCode !== 200) {
    return { status: res.statusCode, currentUser: { id: "", isAdmin: false }, token: "" };
  }
  const opened = openTransport(session.key, (res.json() as { enc: string }).enc, aad);
  const body = JSON.parse(opened as string) as { currentUser: { id: string; isAdmin: boolean }; token: string };
  return { status: res.statusCode, ...body };
}

/** Send an inner request through the metadata-hiding tunnel (docs/08 v2) on a bound session (docs/20):
 *  seal `{ m, p, body? }` at `seq`, unseal the `{ status, contentType, body }` descriptor. */
async function tunnelInner(
  app: LoamApp,
  session: { sessionId: string; key: string },
  seq: number,
  inner: { m: string; p: string; body?: unknown },
): Promise<{ outerStatus: number; status: number; contentType: string; body: Buffer }> {
  const aad = "POST /api/transport/tunnel";
  const res = await app.server.inject({
    method: "POST",
    url: "/api/transport/tunnel",
    headers: { "x-loam-enc": session.sessionId, "content-type": "application/json" },
    payload: { enc: sealSeq(session.key, seq, aad, inner) },
  });
  if (res.statusCode !== 200) {
    return { outerStatus: res.statusCode, status: res.statusCode, contentType: "", body: Buffer.alloc(0) };
  }
  const opened = openTransport(session.key, (res.json() as { enc: string }).enc, aad);
  const desc = JSON.parse(opened as string) as { status: number; contentType: string; bodyB64: string };
  return {
    outerStatus: res.statusCode,
    status: desc.status,
    contentType: desc.contentType,
    body: Buffer.from(desc.bodyB64, "base64"),
  };
}

async function claim(app: LoamApp, cookie: string, secret: string): Promise<InjectResponse> {
  return app.server.inject({
    method: "POST",
    url: "/api/admin/claim",
    headers: { cookie },
    payload: { secret },
  });
}

type OllamaChatRequestBody = { model?: string; stream?: boolean; messages?: { role: string; content: string }[] };

/**
 * Minimal mock of Ollama's streaming `/api/chat` endpoint (node:http), emitting the same
 * newline-delimited JSON shape `streamOllamaChat` (apps/server/src/app.ts) parses: one
 * `{"message":{"content":...},"done":false}` line per delta (with a real delay between them, so a
 * test can tell genuine streaming from one lump), then a final `{"done":true}` line. Captures every
 * request body it receives for assertions (e.g. that the DM history was forwarded as `messages`).
 */
function startMockOllama(
  deltas: string[],
  opts: { delayMs?: number } = {},
): { url: Promise<string>; close: () => Promise<void>; requests: OllamaChatRequestBody[] } {
  const delayMs = opts.delayMs ?? 10;
  const requests: OllamaChatRequestBody[] = [];

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk));
    req.on("end", () => {
      void (async () => {
        try {
          requests.push(JSON.parse(raw || "{}") as OllamaChatRequestBody);
        } catch {
          // Malformed capture is surfaced by an empty `requests` entry never appearing; irrelevant
          // to the streaming behaviour under test.
        }

        res.writeHead(200, { "content-type": "application/x-ndjson" });
        for (const delta of deltas) {
          res.write(`${JSON.stringify({ message: { role: "assistant", content: delta }, done: false })}\n`);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        res.end(`${JSON.stringify({ done: true })}\n`);
      })();
    });
  });

  const url = new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });

  return { url, close: () => new Promise<void>((resolve) => server.close(() => resolve())), requests };
}

/** A `http://127.0.0.1:<port>` URL nothing is listening on, to simulate Ollama being unreachable. */
async function unusedLocalUrl(): Promise<string> {
  const probe = createServer();
  const url = await new Promise<string>((resolve) => {
    probe.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(probe.address() as AddressInfo).port}`));
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return url;
}

describe("error codes", () => {
  it("every error code the server actually returns is drawn from the canonical @loam/schema list", () => {
    // ALL_ERROR_CODES (Object.values of the server's ERROR_CODES map) is typed against
    // ServerErrorCode, so this is really a belt-and-braces runtime check that nothing slipped
    // through — the real guarantee is the compile-time type constraint in app.ts.
    for (const code of ALL_ERROR_CODES) {
      expect(SERVER_ERROR_CODES as readonly string[], `unknown code ${code}`).toContain(code);
    }
    // No duplicate English messages mapping to the same code by accident, and every canonical
    // code is unique too (both are asserted so the two lists can't quietly drift apart).
    expect(new Set(ALL_ERROR_CODES).size).toBe(ALL_ERROR_CODES.length);
  });
});

describe("admin bootstrap", () => {
  it("firstUser (default): the first session becomes admin, later ones do not", async () => {
    const app = await makeApp();

    const first = await newSession(app);
    expect(first.isAdmin).toBe(true);

    const second = await newSession(app);
    expect(second.isAdmin).toBe(false);
  });

  it("demotes legacy admin seed users so bootstrap governs admin", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "loam-app-test-"));
    writeFileSync(
      join(dataDir, "users.json"),
      JSON.stringify([
        {
          id: "user.1234",
          displayName: "Seed",
          type: "human",
          isAdmin: true,
          createdAt: 1_704_067_200_000,
          ephemeral: false,
        },
      ]),
    );

    const app = await buildApp({ dataDir, logger: false });
    cleanups.push(async () => {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    });

    const users = app.store.loadUsers();
    expect(users.find((user) => user.id === "user.1234")?.isAdmin).toBe(false);

    const first = await newSession(app);
    expect(first.isAdmin).toBe(true);
  });

  it("setupCode: exposes a one-time code that grants admin exactly once", async () => {
    const app = await makeApp({ admin: { bootstrap: "setupCode" } });
    expect(app.adminSetupCode).toMatch(/^[a-f0-9]{12}$/);

    const session = await newSession(app);
    expect(session.isAdmin).toBe(false);

    const wrong = await claim(app, session.cookie, "not-the-code");
    expect(wrong.statusCode).toBe(403);

    const right = await claim(app, session.cookie, app.adminSetupCode ?? "");
    expect(right.statusCode).toBe(200);
    expect((right.json() as { isAdmin: boolean }).isAdmin).toBe(true);

    const again = await claim(app, (await newSession(app)).cookie, app.adminSetupCode ?? "");
    expect(again.statusCode).toBe(403);
  });

  it("passphrase: grants admin for the configured passphrase only", async () => {
    const app = await makeApp({ admin: { bootstrap: "passphrase", passphrase: "correct horse battery" } });

    const session = await newSession(app);
    expect(session.isAdmin).toBe(false);

    expect((await claim(app, session.cookie, "wrong horse")).statusCode).toBe(403);

    const right = await claim(app, session.cookie, "correct horse battery");
    expect(right.statusCode).toBe(200);
    expect((right.json() as { isAdmin: boolean }).isAdmin).toBe(true);
  });

  it("none: claiming is rejected and nobody becomes admin", async () => {
    const app = await makeApp({ admin: { bootstrap: "none" } });

    const session = await newSession(app);
    expect(session.isAdmin).toBe(false);
    expect((await claim(app, session.cookie, "anything")).statusCode).toBe(403);
  });

  it("rate-limits repeated claim attempts", async () => {
    const app = await makeApp({ admin: { bootstrap: "passphrase", passphrase: "correct horse battery" } });
    const session = await newSession(app);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await claim(app, session.cookie, `wrong-${attempt}`)).statusCode).toBe(403);
    }

    expect((await claim(app, session.cookie, "wrong-again")).statusCode).toBe(429);
  });

  it("exposes allowAdminClaim only while a usable claim secret exists", async () => {
    const claimable = await makeApp({ admin: { bootstrap: "setupCode" } });
    const readClaimFlag = async (app: LoamApp) =>
      (
        (await app.server.inject({ method: "GET", url: "/api/config" })).json() as {
          networkConfig: { allowAdminClaim: boolean };
        }
      ).networkConfig.allowAdminClaim;

    expect(await readClaimFlag(claimable)).toBe(true);

    // Once the one-time code is spent, stop advertising a claim flow that cannot succeed.
    const session = await newSession(claimable);
    await claim(claimable, session.cookie, claimable.adminSetupCode ?? "");
    expect(await readClaimFlag(claimable)).toBe(false);

    const notClaimable = await makeApp();
    expect(await readClaimFlag(notClaimable)).toBe(false);
  });
});

describe("admin config API", () => {
  it("rejects non-admins", async () => {
    const app = await makeApp({ admin: { bootstrap: "none" } });
    const session = await newSession(app);

    const get = await app.server.inject({ method: "GET", url: "/api/admin/config", headers: { cookie: session.cookie } });
    expect(get.statusCode).toBe(403);

    const patch = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: session.cookie },
      payload: { features: { enableReplies: false } },
    });
    expect(patch.statusCode).toBe(403);
  });

  it("returns the effective config with the passphrase redacted", async () => {
    const app = await makeApp({ admin: { bootstrap: "passphrase", passphrase: "correct horse battery" } });
    const session = await newSession(app);
    await claim(app, session.cookie, "correct horse battery");

    const response = await app.server.inject({
      method: "GET",
      url: "/api/admin/config",
      headers: { cookie: session.cookie },
    });
    expect(response.statusCode).toBe(200);
    const config = response.json() as { admin: { bootstrap: string; passphrase?: string }; features: { enableReplies: boolean } };
    expect(config.admin.bootstrap).toBe("passphrase");
    expect(config.admin.passphrase).toBeUndefined();
    expect(config.features.enableReplies).toBe(true);
  });

  it("rejects invalid config updates", async () => {
    const app = await makeApp();
    const admin = await newSession(app);

    const response = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { features: { enableReplies: "nope" } },
    });
    expect(response.statusCode).toBe(400);
  });

  it("defaults dbEncryption to off and reflects a PATCHed value in /api/config when the store is actually keyed, independent of the security profile", async () => {
    // F5: `networkConfig.dbEncryption` now reports the EFFECTIVE posture, not the merely-configured
    // value — so this round-trip only shows the PATCHed value while a real key is active. The `off` →
    // false-report case (no real key) is covered separately below.
    const app = await makeApp(undefined, { dbEncryptionKey: "a fixed host passphrase" });
    const admin = await newSession(app);

    const before = (await app.server.inject({ method: "GET", url: "/api/config" })).json() as {
      networkConfig: { dbEncryption: string };
    };
    expect(before.networkConfig.dbEncryption).toBe("off");

    const patch = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { security: { dbEncryption: "ephemeral" } },
    });
    expect(patch.statusCode).toBe(200);

    const after = (await app.server.inject({ method: "GET", url: "/api/config" })).json() as {
      networkConfig: { dbEncryption: string; securityProfile: string };
    };
    expect(after.networkConfig.dbEncryption).toBe("ephemeral");
    // dbEncryption is not one of the axes a named profile forces (only transportEncryption /
    // joinPolicy / messageTtlMs / killSwitch are), so switching profiles must not clobber it.
    expect(after.networkConfig.securityProfile).toBe("custom");

    const rejected = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { security: { dbEncryption: "hardware-hsm" } },
    });
    expect(rejected.statusCode).toBe(400);
  });

  it("F5: reports the EFFECTIVE dbEncryption posture (off) when no real key is active, even after PATCHing a non-off value", async () => {
    // No dbEncryptionKey/ephemeralDbKey passed — the store is genuinely unencrypted, whatever the
    // config says. `security.dbEncryption` is a declarative admin setting decoupled from the real key
    // (see the comment on `encryptionEnabled` in app.ts); the wire must never claim encryption that
    // isn't active.
    const app = await makeApp();
    const admin = await newSession(app);

    const patch = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { security: { dbEncryption: "persistent" } },
    });
    expect(patch.statusCode).toBe(200);

    const after = (await app.server.inject({ method: "GET", url: "/api/config" })).json() as {
      networkConfig: { dbEncryption: string };
    };
    expect(after.networkConfig.dbEncryption).toBe("off");

    // The admin config view (the raw, redacted config) still reflects what was actually configured —
    // only the client-facing networkConfig is truthed up to the effective posture.
    const adminConfig = (await app.server.inject({
      method: "GET",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
    })).json() as { security: { dbEncryption: string } };
    expect(adminConfig.security.dbEncryption).toBe("persistent");
  });

  it("applies, enforces, broadcasts shape, and persists feature flag changes", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "loam-app-test-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const initialApp = await buildApp({ dataDir, logger: false });
    let app: LoamApp = initialApp;
    cleanups.push(() => initialApp.close());

    const admin = await newSession(app);
    expect(admin.isAdmin).toBe(true);

    const post = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: admin.cookie },
      payload: { type: "channelPost", channelId: "general", body: "root post" },
    });
    expect(post.statusCode).toBe(201);
    const postId = (post.json() as { message: { id: string } }).message.id;

    const patch = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { features: { enableReplies: false, enableReactions: false } },
    });
    expect(patch.statusCode).toBe(200);

    const reply = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: admin.cookie },
      payload: { type: "channelReply", channelId: "general", parentMessageId: postId, body: "reply" },
    });
    expect(reply.statusCode).toBe(400);
    expect((reply.json() as { error: string }).error).toMatch(/Replies are disabled/);

    const reaction = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: admin.cookie },
      payload: { type: "reaction", targetMessageId: postId, reaction: "👍" },
    });
    expect(reaction.statusCode).toBe(400);

    const networkConfig = (
      (await app.server.inject({ method: "GET", url: "/api/config", headers: { cookie: admin.cookie } })).json() as {
        networkConfig: { enableReplies: boolean; enableReactions: boolean };
      }
    ).networkConfig;
    expect(networkConfig.enableReplies).toBe(false);
    expect(networkConfig.enableReactions).toBe(false);

    app = await reopenApp(app, dataDir);
    const reopened = (
      (await app.server.inject({ method: "GET", url: "/api/config", headers: { cookie: admin.cookie } })).json() as {
        currentUser: { isAdmin: boolean };
        networkConfig: { enableReplies: boolean };
      }
    );
    expect(reopened.networkConfig.enableReplies).toBe(false);
    expect(reopened.currentUser.isAdmin).toBe(true);
  });

  it("redacts the panic token and never returns it", async () => {
    const app = await makeApp({
      killSwitch: { enabled: true, panicToken: "panic-token-0123456789" },
    });
    const admin = await newSession(app);

    const response = await app.server.inject({
      method: "GET",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
    });
    const config = response.json() as { killSwitch: { enabled: boolean; panicToken?: string } };
    expect(config.killSwitch.enabled).toBe(true);
    expect(config.killSwitch.panicToken).toBeUndefined();
  });

  it("refuses to clear the passphrase while the passphrase strategy is active", async () => {
    const app = await makeApp({ admin: { bootstrap: "passphrase", passphrase: "correct horse battery" } });
    const admin = await newSession(app);
    await claim(app, admin.cookie, "correct horse battery");

    const clearWhileActive = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { admin: { passphrase: "" } },
    });
    expect(clearWhileActive.statusCode).toBe(400);

    // Switching strategy and clearing together is fine — and claiming stops working.
    const switchAndClear = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { admin: { bootstrap: "none", passphrase: "" } },
    });
    expect(switchAndClear.statusCode).toBe(200);

    const session = await newSession(app);
    expect((await claim(app, session.cookie, "correct horse battery")).statusCode).toBe(403);
  });
});

describe("kill switch", () => {
  async function postKillSwitch(
    app: LoamApp,
    cookie: string,
    payload: Record<string, unknown> = { confirm: "wipe" },
  ) {
    return app.server.inject({ method: "POST", url: "/api/admin/kill-switch", headers: { cookie }, payload });
  }

  it("requires typed confirmation when requireConfirmation is on (the default)", async () => {
    const app = await makeApp({ killSwitch: { enabled: true } });
    const admin = await newSession(app);

    expect((await postKillSwitch(app, admin.cookie, {})).statusCode).toBe(400);
    expect((await postKillSwitch(app, admin.cookie, { confirm: "yes" })).statusCode).toBe(400);
    expect(app.store.loadSessions().length).toBeGreaterThan(0);
    expect((await postKillSwitch(app, admin.cookie, { confirm: "wipe" })).statusCode).toBe(200);
    expect(app.store.loadSessions()).toEqual([]);
  });

  it("fires without confirmation when requireConfirmation is off", async () => {
    const app = await makeApp({ killSwitch: { enabled: true, requireConfirmation: false } });
    const admin = await newSession(app);

    expect((await postKillSwitch(app, admin.cookie, {})).statusCode).toBe(200);
  });

  it("abandons an in-flight sync round when a kill switch fires mid-pull (docs/15 #2)", async () => {
    // A controllable peer: it advertises one message, then HOLDS the /api/sync/messages response until
    // we release it — so we can fire the kill switch while node A is suspended awaiting that fetch.
    let sawMessagesRequest!: () => void;
    const messagesRequested = new Promise<void>((resolve) => (sawMessagesRequest = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    const peerMessage = {
      id: "msg.peer-race",
      type: "channelPost",
      authorId: "user.peerauthor",
      channelId: "general",
      body: "from the peer",
      createdAt: 1,
    };
    const peerAuthor = {
      id: "user.peerauthor",
      displayName: "Peer Author",
      type: "human",
      isAdmin: false,
      createdAt: 1,
      ephemeral: true,
    };

    const peer = createServer((req, res) => {
      if (req.url === "/api/sync/digest") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ channels: [], messages: [{ id: peerMessage.id }] }));
        return;
      }
      if (req.url === "/api/sync/messages") {
        sawMessagesRequest();
        void gate.then(() => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ messages: [peerMessage], users: [peerAuthor] }));
        });
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(() => new Promise<void>((resolve) => peer.close(() => resolve())));
    const peerUrl = `http://127.0.0.1:${(peer.address() as AddressInfo).port}`;

    const app = await makeApp({
      killSwitch: { enabled: true, requireConfirmation: false },
      sync: { enabled: true, peers: [{ url: peerUrl }] },
    });
    const admin = await newSession(app);

    // Kick off a sync round; it blocks awaiting the held /api/sync/messages response.
    const syncInFlight = app.server.inject({
      method: "POST",
      url: "/api/admin/sync/run",
      headers: { cookie: admin.cookie },
    });

    await messagesRequested; // A is now mid-pull, suspended on the peer's message payload
    try {
      expect((await postKillSwitch(app, admin.cookie, {})).statusCode).toBe(200); // wipe fires mid-round
    } finally {
      release(); // always release the held response, even if the assertion throws, so nothing hangs
    }
    await syncInFlight;

    // The peer's message (and author) were NOT written back onto the freshly wiped store.
    const stored = app.store.loadMessages();
    expect(stored.some((message) => message.id === peerMessage.id)).toBe(false);
    expect(app.store.loadUsers().some((user) => user.id === peerAuthor.id)).toBe(false);
  });

  it("rejects non-admins and admins on nodes where it is disabled", async () => {
    const disabled = await makeApp();
    const admin = await newSession(disabled);
    const visitor = await newSession(disabled);

    expect((await postKillSwitch(disabled, visitor.cookie)).statusCode).toBe(403);
    expect((await postKillSwitch(disabled, admin.cookie)).statusCode).toBe(403);
    expect(disabled.store.loadMessages().length).toBe(0);
  });

  it("wipes all data, invalidates sessions, clears avatars, and re-seeds defaults", async () => {
    const { app, dataDir } = await makeApp({ killSwitch: { enabled: true } });
    const admin = await newSession(app);

    const avatarsDir = join(dataDir, "avatars");
    mkdirSync(avatarsDir, { recursive: true });
    writeFileSync(join(avatarsDir, "avt_deadbeefdeadbeef.webp"), "fake");

    const post = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: admin.cookie },
      payload: { type: "channelPost", channelId: "general", body: "to be wiped" },
    });
    expect(post.statusCode).toBe(201);

    const wipe = await postKillSwitch(app, admin.cookie);
    expect(wipe.statusCode).toBe(200);

    expect(app.store.loadMessages()).toEqual([]);
    expect(app.store.loadSessions()).toEqual([]);
    expect(app.store.loadUsers().every((user) => !user.isAdmin)).toBe(true);
    expect(app.store.loadChannels().map((channel) => channel.id).sort()).toEqual(["announcements", "general"]);
    expect(existsSync(join(avatarsDir, "avt_deadbeefdeadbeef.webp"))).toBe(false);

    const returning = await app.server.inject({
      method: "GET",
      url: "/api/config",
      headers: { cookie: admin.cookie },
    });
    const returningUser = (returning.json() as { currentUser: { id: string; isAdmin: boolean } }).currentUser;
    expect(returningUser.id).not.toBe(admin.userId);

    const fresh = await newSession(app);
    expect(fresh.isAdmin).toBe(false);
  });

  it("keeps the kill switch enabled after a wipe so it can fire again", async () => {
    const app = await makeApp({ killSwitch: { enabled: true } });
    const admin = await newSession(app);
    expect((await postKillSwitch(app, admin.cookie)).statusCode).toBe(200);

    const nextAdmin = await newSession(app);
    expect(nextAdmin.isAdmin).toBe(true);
    expect((await postKillSwitch(app, nextAdmin.cookie)).statusCode).toBe(200);
  });
});

describe("panic endpoint", () => {
  async function panic(app: LoamApp, token: string) {
    return app.server.inject({ method: "POST", url: "/api/panic", payload: { token } });
  }

  it("404s when the kill switch or token is not configured", async () => {
    const noKillSwitch = await makeApp();
    expect((await panic(noKillSwitch, "whatever")).statusCode).toBe(404);

    const noToken = await makeApp({ killSwitch: { enabled: true } });
    expect((await panic(noToken, "whatever")).statusCode).toBe(404);
  });

  it("wipes without authentication given the correct token, rejects wrong tokens", async () => {
    const app = await makeApp({
      killSwitch: { enabled: true, panicToken: "panic-token-0123456789" },
    });
    const admin = await newSession(app);

    await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: admin.cookie },
      payload: { type: "channelPost", channelId: "general", body: "to be wiped" },
    });

    // A wrong token answers 404 — identical to an unconfigured node — so the panic route can't be
    // fingerprinted; the message survives.
    expect((await panic(app, "wrong-token")).statusCode).toBe(404);
    expect(app.store.loadMessages().length).toBe(1);

    expect((await panic(app, "panic-token-0123456789")).statusCode).toBe(200);
    expect(app.store.loadMessages()).toEqual([]);
  });

  it("rate-limits repeated attempts (indistinguishably) and blocks the wipe once tripped", async () => {
    const app = await makeApp({
      killSwitch: { enabled: true, panicToken: "panic-token-0123456789" },
    });
    const admin = await newSession(app);
    await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: admin.cookie },
      payload: { type: "channelPost", channelId: "general", body: "survives the brute force" },
    });

    // Every wrong attempt looks like a 404 (not a distinguishable 403/429).
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await panic(app, `wrong-${attempt}`)).statusCode).toBe(404);
    }

    // Once the attempt limiter trips, even the CORRECT token is refused (checked after the limiter)
    // and the node is NOT wiped.
    expect((await panic(app, "panic-token-0123456789")).statusCode).toBe(404);
    expect(app.store.loadMessages().length).toBe(1);
  });

  it("answers 404 (never 429) even past the route-level rate limit", async () => {
    const app = await makeApp({
      killSwitch: { enabled: true, panicToken: "panic-token-0123456789" },
    });

    // The route allows 10/min; push well past it. Every rejection — including the route-level
    // rate-limit hit — must be a 404, so a 429 can never reveal that the panic route exists here.
    const codes: number[] = [];
    for (let attempt = 0; attempt < 13; attempt += 1) {
      codes.push((await panic(app, `wrong-${attempt}`)).statusCode);
    }
    expect(codes).not.toContain(429);
    expect(codes.every((code) => code === 404)).toBe(true);
  });
});

describe("message retention (ephemeral messages)", () => {
  it("reaps messages older than the configured TTL and keeps newer ones", async () => {
    // Fake timers make the age boundary exact and instant (was a real ~700ms sleep): the old
    // message is posted, the clock jumps a full TTL past its `createdAt`, then the fresh one is
    // posted so it sits safely inside the window while the old one falls outside it. Fake only
    // `Date` — the reaper's cutoff is the only clock this cares about, and faking the whole event
    // loop would deadlock `server.inject` (it needs real setImmediate/timers).
    const app = await makeApp({ retention: { messageTtlMs: 500 } });
    const session = await newSession(app);
    vi.useFakeTimers({ toFake: ["Date"] });

    const oldPost = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: session.cookie },
      payload: { type: "channelPost", channelId: "general", body: "old enough to expire" },
    });
    expect(oldPost.statusCode).toBe(201);

    await vi.advanceTimersByTimeAsync(700);

    const freshPost = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: session.cookie },
      payload: { type: "channelPost", channelId: "general", body: "still fresh" },
    });
    expect(freshPost.statusCode).toBe(201);

    app.reapExpiredMessages();

    const bodies = app.store.loadMessages().map((message) => ("body" in message ? message.body : ""));
    expect(bodies).toEqual(["still fresh"]);

    const served = (
      await app.server.inject({ method: "GET", url: "/api/messages/general", headers: { cookie: session.cookie } })
    ).json() as { body?: string }[];
    expect(served.map((message) => message.body)).toEqual(["still fresh"]);
  });

  it("does nothing when no TTL is configured", async () => {
    const app = await makeApp();
    const session = await newSession(app);

    await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: session.cookie },
      payload: { type: "channelPost", channelId: "general", body: "kept forever" },
    });

    app.reapExpiredMessages();
    expect(app.store.loadMessages().length).toBe(1);
  });

  it("applies a TTL set via the admin config API and clears it with null", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    // Fake only `Date` (see the reap-and-keep test): faking timers wholesale would hang inject.
    vi.useFakeTimers({ toFake: ["Date"] });

    await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: admin.cookie },
      payload: { type: "channelPost", channelId: "general", body: "doomed" },
    });

    const patch = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { retention: { messageTtlMs: 1 } },
    });
    expect(patch.statusCode).toBe(200);

    // Advance past the 1ms TTL so the message is reliably expired (was a real 10ms sleep).
    await vi.advanceTimersByTimeAsync(10);
    app.reapExpiredMessages();
    expect(app.store.loadMessages()).toEqual([]);

    const clear = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { retention: { messageTtlMs: null } },
    });
    expect(clear.statusCode).toBe(200);
    const cleared = clear.json() as { retention: { messageTtlMs?: number } };
    expect(cleared.retention.messageTtlMs).toBeUndefined();
  });
});

describe("message authorization", () => {
  it("blocks reactions on DMs from non-participants", async () => {
    const app = await makeApp();
    const alice = await newSession(app);
    const bob = await newSession(app);
    const mallory = await newSession(app);

    const dm = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: alice.cookie },
      payload: { type: "dm", recipientUserId: bob.userId, body: "secret" },
    });
    expect(dm.statusCode).toBe(201);
    const dmId = (dm.json() as { message: { id: string } }).message.id;

    const outsider = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: mallory.cookie },
      payload: { type: "reaction", targetMessageId: dmId, reaction: "👀" },
    });
    expect(outsider.statusCode).toBe(400);
    expect((outsider.json() as { error: string }).error).toMatch(/Cannot react/);

    const participant = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: bob.cookie },
      payload: { type: "reaction", targetMessageId: dmId, reaction: "👍" },
    });
    expect(participant.statusCode).toBe(201);
  });

  it("rejects DMs when enableDMs is off", async () => {
    const app = await makeApp({ features: { enableDMs: false } });
    const alice = await newSession(app);
    const bob = await newSession(app);

    const dm = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: alice.cookie },
      payload: { type: "dm", recipientUserId: bob.userId, body: "secret" },
    });
    expect(dm.statusCode).toBe(400);
    expect((dm.json() as { code?: string }).code).toBe("dms_disabled");
  });

  it("enforces channel posting policy server-side", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "loam-app-test-"));
    const base = {
      visibility: "public",
      allowPosting: "everyone",
      allowReplies: true,
      discoverable: true,
      createdAt: 1_704_067_200_000,
    };
    writeFileSync(
      join(dataDir, "channels.json"),
      JSON.stringify([
        { id: "general", name: "General", ...base },
        { id: "notices", name: "Notices", ...base, allowPosting: "admins" },
        { id: "old", name: "Old", ...base, archived: true },
      ]),
    );
    const app = await buildApp({ dataDir, logger: false });
    cleanups.push(async () => {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    });

    const admin = await newSession(app);
    const visitor = await newSession(app);
    const post = (cookie: string, channelId: string) =>
      app.server.inject({
        method: "POST",
        url: "/api/messages",
        headers: { cookie },
        payload: { type: "channelPost", channelId, body: "hello" },
      });

    expect((await post(visitor.cookie, "old")).statusCode).toBe(400);
    expect((await post(visitor.cookie, "notices")).statusCode).toBe(400);
    expect((await post(admin.cookie, "notices")).statusCode).toBe(201);
    expect((await post(visitor.cookie, "general")).statusCode).toBe(201);
  });
});

describe("config robustness", () => {
  it("ABORTS startup when the config file is malformed JSON (never falls back to defaults)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "loam-app-test-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    writeFileSync(join(dataDir, "config.json"), "{ this is not json");
    // A present-but-invalid config must fail closed: silently starting from defaults could downgrade an
    // intended `required` posture to `off` (docs/08). The operator must fix or remove the file.
    await expect(buildApp({ dataDir, logger: false })).rejects.toThrow(/Invalid configuration/);
  });

  it("ABORTS startup when the persisted config row is malformed", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "loam-app-test-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const initialApp = await buildApp({ dataDir, logger: false });
    initialApp.store.setConfigValue("config", "{ broken");
    await initialApp.close();

    await expect(buildApp({ dataDir, logger: false })).rejects.toThrow(/Invalid configuration/);
  });

  it("ABORTS startup when the persisted config row is present but EMPTY (not silently skipped)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "loam-app-test-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const initialApp = await buildApp({ dataDir, logger: false });
    initialApp.store.setConfigValue("config", ""); // a corrupt/empty row is present, not absent
    await initialApp.close();

    await expect(buildApp({ dataDir, logger: false })).rejects.toThrow(/Invalid configuration/);
  });

  it("ABORTS rather than silently serving `off` when a required-mode config has an invalid field", async () => {
    // The exact footgun: a `required` node whose `sync.token` is under the 16-char minimum invalidates the
    // whole document. It must NOT boot advertising `off` — it must refuse to start.
    const dataDir = mkdtempSync(join(tmpdir(), "loam-app-test-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({ security: { transportEncryption: "required" }, sync: { enabled: true, token: "short" } }),
    );
    await expect(buildApp({ dataDir, logger: false })).rejects.toThrow(/Invalid configuration/);
  });

  it("rejects update secrets shorter than their configured minimums", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const patch = (payload: Record<string, unknown>) =>
      app.server.inject({ method: "PATCH", url: "/api/admin/config", headers: { cookie: admin.cookie }, payload });

    expect((await patch({ admin: { passphrase: "short" } })).statusCode).toBe(400);
    expect((await patch({ killSwitch: { panicToken: "tooshort" } })).statusCode).toBe(400);
    expect((await patch({ admin: { passphrase: "" } })).statusCode).toBe(200);
    expect((await patch({ admin: { passphrase: "long enough passphrase" } })).statusCode).toBe(200);
  });
});

describe("join address resolution (docs/15 A7)", () => {
  it("re-resolves the join host on every request when no explicit joinHost is configured", async () => {
    let currentAddress = "10.0.0.1";
    const { app } = await makeApp(undefined, { resolveLanAddress: () => currentAddress });

    const first = (await app.server.inject({ method: "GET", url: "/api/bootstrap" })).json() as { joinUrl: string };
    expect(first.joinUrl).toContain("10.0.0.1");

    // Simulate the Android hotspot interface coming up (or changing) after boot — a later request
    // must reflect it, not whatever was resolved when the process started.
    currentAddress = "192.168.49.1";

    const second = (await app.server.inject({ method: "GET", url: "/api/bootstrap" })).json() as { joinUrl: string };
    expect(second.joinUrl).toContain("192.168.49.1");
    expect(second.joinUrl).not.toContain("10.0.0.1");

    // /api/config (used post-hydration) resolves the same live way.
    const config = (await app.server.inject({ method: "GET", url: "/api/config" })).json() as { joinUrl: string };
    expect(config.joinUrl).toContain("192.168.49.1");
  });

  it("an explicit joinHost wins outright and is never re-resolved (desktop/Pi: the boot address is fine)", async () => {
    const { app } = await makeApp(undefined, {
      joinHost: "pinned.example",
      resolveLanAddress: () => "should-never-be-used",
    });

    const response = (await app.server.inject({ method: "GET", url: "/api/bootstrap" })).json() as { joinUrl: string };
    expect(response.joinUrl).toContain("pinned.example");
    expect(response.joinUrl).not.toContain("should-never-be-used");
  });
});

describe("avatar uploads", () => {
  it("keeps only the latest uploaded avatar image per user", async () => {
    const { app, dataDir } = await makeApp({
      identity: { allowUserAvatarEdit: true, allowUserAvatarUpload: true },
    });
    const session = await newSession(app);
    const webp = Buffer.from("RIFF\0\0\0\0WEBP").toString("base64");
    const upload = () =>
      app.server.inject({
        method: "PUT",
        url: "/api/users/me/avatar-image",
        headers: { cookie: session.cookie },
        payload: { mimeType: "image/webp", data: webp },
      });

    const first = await upload();
    expect(first.statusCode).toBe(200);
    const firstImageId = (first.json() as { avatar: { imageId: string } }).avatar.imageId;
    expect(existsSync(join(dataDir, "avatars", `${firstImageId}.webp`))).toBe(true);

    const second = await upload();
    expect(second.statusCode).toBe(200);
    const secondImageId = (second.json() as { avatar: { imageId: string } }).avatar.imageId;

    expect(existsSync(join(dataDir, "avatars", `${secondImageId}.webp`))).toBe(true);
    expect(existsSync(join(dataDir, "avatars", `${firstImageId}.webp`))).toBe(false);
  });
});

describe("public-channel flag", () => {
  it("blocks replies as well as posts when enablePublicChannels is off", async () => {
    const app = await makeApp({ features: { enablePublicChannels: false } });
    const session = await newSession(app);

    const post = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: session.cookie },
      payload: { type: "channelPost", channelId: "general", body: "nope" },
    });
    expect(post.statusCode).toBe(400);

    const reply = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: session.cookie },
      payload: { type: "channelReply", channelId: "general", parentMessageId: "msg_whatever", body: "nope" },
    });
    expect(reply.statusCode).toBe(400);
    expect((reply.json() as { error: string }).error).toMatch(/Channel posting is disabled/);
  });
});

describe("secret storage", () => {
  it("persists the passphrase and panic token scrypt-hashed, never in the clear", async () => {
    const app = await makeApp();
    const admin = await newSession(app);

    const patch = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: {
        admin: { bootstrap: "passphrase", passphrase: "correct horse battery" },
        killSwitch: { enabled: true, panicToken: "panic-token-0123456789" },
      },
    });
    expect(patch.statusCode).toBe(200);

    const persisted = app.store.getConfigValue("config") ?? "";
    expect(persisted).not.toContain("correct horse battery");
    expect(persisted).not.toContain("panic-token-0123456789");
    expect(persisted).toContain("scrypt:");

    // The plaintext still verifies after a restart (hash round-trips through the DB).
    const { dataDir } = app as unknown as { dataDir: string };
    const reopened = await reopenApp(app, dataDir);
    const session = await newSession(reopened);
    expect((await claim(reopened, session.cookie, "correct horse battery")).statusCode).toBe(200);
  });

  it("rate-limits avatar uploads per route", async () => {
    const app = await makeApp({
      identity: { allowUserAvatarEdit: true, allowUserAvatarUpload: true },
    });
    const session = await newSession(app);
    const webp = Buffer.from("RIFF\0\0\0\0WEBP").toString("base64");
    let limited = 0;

    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await app.server.inject({
        method: "PUT",
        url: "/api/users/me/avatar-image",
        headers: { cookie: session.cookie },
        payload: { mimeType: "image/webp", data: webp },
      });

      if (response.statusCode === 429) {
        limited += 1;
      }
    }

    expect(limited).toBeGreaterThan(0);
  });
});

describe("encryption at rest + key-discard kill switch", () => {
  // Build directly (not via makeApp) so `app.store` stays the live getter across an encrypted wipe.
  async function makeEncryptedApp(
    opts: Pick<AppOptions, "dbEncryptionKey" | "ephemeralDbKey" | "dbEncryptionMode">,
    config?: unknown,
  ): Promise<{ app: LoamApp; dataDir: string }> {
    const dataDir = mkdtempSync(join(tmpdir(), "loam-enc-app-test-"));
    if (config !== undefined) {
      writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
    }
    const app = await buildApp({ dataDir, logger: false, ...opts });
    cleanups.push(async () => {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    });
    return { app, dataDir };
  }

  async function session(app: LoamApp) {
    const response = await app.server.inject({ method: "GET", url: "/api/config" });
    return {
      cookie: sessionCookie(response),
      user: (response.json() as { currentUser: { id: string; isAdmin: boolean } }).currentUser,
    };
  }

  async function post(app: LoamApp, cookie: string, body: string) {
    return app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie },
      payload: { type: "channelPost", channelId: "general", body },
    });
  }

  function dataDirHasPlaintext(dataDir: string, needle: string): boolean {
    const target = Buffer.from(needle);
    return readdirSync(dataDir)
      .filter((name) => name.startsWith("loam.db"))
      .some((name) => readFileSync(join(dataDir, name)).includes(target));
  }

  it("ephemeral mode writes an encrypted database (no plaintext on disk)", async () => {
    const { app, dataDir } = await makeEncryptedApp({ ephemeralDbKey: true });
    const admin = await session(app);
    expect((await post(app, admin.cookie, "EPHEMERAL_PLAINTEXT_NEEDLE")).statusCode).toBe(201);

    expect(dataDirHasPlaintext(dataDir, "EPHEMERAL_PLAINTEXT_NEEDLE")).toBe(false);
    expect(readFileSync(join(dataDir, "loam.db")).subarray(0, 15).toString("ascii")).not.toBe(
      "SQLite format 3",
    );
  });

  it("kill switch on an ephemeral-key node empties data, rotates the file, and the node recovers", async () => {
    const { app, dataDir } = await makeEncryptedApp(
      { ephemeralDbKey: true },
      { killSwitch: { enabled: true } },
    );
    const admin = await session(app);
    expect(admin.user.isAdmin).toBe(true);
    expect((await post(app, admin.cookie, "DOOMED_SECRET_NEEDLE")).statusCode).toBe(201);

    const before = readFileSync(join(dataDir, "loam.db"));

    const wipe = await app.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });
    expect(wipe.statusCode).toBe(200);

    // Live getter → the reopened store. Old message gone; node re-seeded and usable.
    expect(app.store.loadMessages()).toEqual([]);
    expect(dataDirHasPlaintext(dataDir, "DOOMED_SECRET_NEEDLE")).toBe(false);
    const after = readFileSync(join(dataDir, "loam.db"));
    expect(after.equals(before)).toBe(false); // fresh key ⇒ entirely different ciphertext
    expect(after.subarray(0, 15).toString("ascii")).not.toBe("SQLite format 3");

    const returning = await session(app);
    expect(returning.user.isAdmin).toBe(true); // firstUser bootstrap re-applies on the fresh node
    expect((await post(app, returning.cookie, "after wipe")).statusCode).toBe(201);
  });

  it("SF1/P1-1+P2-1: an Android-style ephemeral boot (ephemeralDbKey + dbEncryptionMode, as embedded.ts " +
    "now derives them) reports the effective posture immediately AND rotates the key on kill switch", async () => {
    // Mirrors exactly what the fixed `embedded.ts` passes for a real ephemeral session: `ephemeralDbKey`
    // is already resolved true (via `resolveEphemeralDbKey`, P1-1) and `dbEncryptionMode` carries the
    // launcher's declared mode — `dbEncryptionKey` is never set for this path (a real ephemeral session
    // discards whatever hex key LOAM_DB_KEY carried).
    const { app, dataDir } = await makeEncryptedApp(
      { ephemeralDbKey: true, dbEncryptionMode: "ephemeral" },
      { killSwitch: { enabled: true } },
    );
    const admin = await session(app);

    // P2-1: the wire reports "ephemeral" from the FIRST request — no admin PATCH of the declarative
    // `security.dbEncryption` axis (which defaults "off") is needed to make this true.
    const before = (await app.server.inject({ method: "GET", url: "/api/config" })).json() as {
      networkConfig: { dbEncryption: string };
    };
    expect(before.networkConfig.dbEncryption).toBe("ephemeral");

    expect((await post(app, admin.cookie, "ANDROID_EPHEMERAL_NEEDLE")).statusCode).toBe(201);
    const beforeWipeFile = readFileSync(join(dataDir, "loam.db"));

    // P1-1: with the fix, executeKillSwitch's `ephemeralDbKey` branch actually rotates the key for this
    // scenario (the old embedded.ts, checking only the LOAM_DB_KEY==="ephemeral" literal, would have
    // left `ephemeralDbKey` false here and skipped rotation entirely).
    const wipe = await app.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });
    expect(wipe.statusCode).toBe(200);

    expect(app.store.loadMessages()).toEqual([]);
    const afterWipeFile = readFileSync(join(dataDir, "loam.db"));
    expect(afterWipeFile.equals(beforeWipeFile)).toBe(false); // fresh key ⇒ entirely different ciphertext

    // Posture still reports "ephemeral" post-wipe (still encrypted, mode unchanged).
    const after = (await app.server.inject({ method: "GET", url: "/api/config" })).json() as {
      networkConfig: { dbEncryption: string };
    };
    expect(after.networkConfig.dbEncryption).toBe("ephemeral");
  });

  it("SF1/P2-1: a boot-resolved dbEncryptionMode (passphrase/persistent) is reported without an admin PATCH", async () => {
    const { app } = await makeEncryptedApp({
      dbEncryptionKey: "a fixed host passphrase",
      dbEncryptionMode: "persistent",
    });

    const config = (await app.server.inject({ method: "GET", url: "/api/config" })).json() as {
      networkConfig: { dbEncryption: string };
    };
    expect(config.networkConfig.dbEncryption).toBe("persistent");
  });

  it("kill switch on a passphrase-key node also empties and recovers", async () => {
    const { app } = await makeEncryptedApp(
      { dbEncryptionKey: "a fixed host passphrase" },
      { killSwitch: { enabled: true } },
    );
    const admin = await session(app);
    await post(app, admin.cookie, "doomed");

    const wipe = await app.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });
    expect(wipe.statusCode).toBe(200);
    expect(app.store.loadMessages()).toEqual([]);
    expect((await post(app, (await session(app)).cookie, "after")).statusCode).toBe(201);
  });

  /** Install the launcher's `globalThis.__loamRequestWipeRestart` hook (P1-2, docs/15) and record every
   *  invocation. Auto-uninstalled via the module-level `cleanups` array. */
  function installFakeWipeRestartHook(): { calls: number } {
    const state = { calls: 0 };
    (globalThis as unknown as { __loamRequestWipeRestart?: () => void }).__loamRequestWipeRestart = () => {
      state.calls += 1;
    };
    cleanups.push(() => {
      delete (globalThis as unknown as { __loamRequestWipeRestart?: unknown }).__loamRequestWipeRestart;
    });
    return state;
  }

  it("P1-2: persistent-mode executeKillSwitch deletes the DB files and does NOT recreate in-process — it hands off to the launcher's wipe-restart hook instead", async () => {
    const hook = installFakeWipeRestartHook();
    const { app, dataDir } = await makeEncryptedApp(
      { dbEncryptionKey: "a fixed persistent key", dbEncryptionMode: "persistent" },
      { killSwitch: { enabled: true } },
    );
    const admin = await session(app);
    expect((await post(app, admin.cookie, "doomed under a fixed key")).statusCode).toBe(201);
    expect(existsSync(join(dataDir, "loam.db"))).toBe(true);

    const wipe = await app.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });
    expect(wipe.statusCode).toBe(200);

    // The launcher hook was invoked exactly once — it owns clearing the Keystore key and restarting
    // the embedded runtime from here; this process must not try to obtain a new key itself.
    expect(hook.calls).toBe(1);

    // The DB files are gone and were NOT recreated in-process (this process has no way to mint the new
    // key the launcher's restart will resolve) — a bare delete, unlike the ephemeral/off paths below.
    expect(existsSync(join(dataDir, "loam.db"))).toBe(false);
    expect(existsSync(join(dataDir, "loam.db-wal"))).toBe(false);
    expect(existsSync(join(dataDir, "loam.db-shm"))).toBe(false);

    // Avatars/attachments still get cleaned up even on this early-return branch (they're plain
    // filesystem, not store-dependent).
    expect(existsSync(join(dataDir, "avatars"))).toBe(false);
    expect(existsSync(join(dataDir, "attachments"))).toBe(false);
  });

  it("P1-2: passphrase-mode executeKillSwitch also hands off to the wipe-restart hook rather than recreating under the same key", async () => {
    const hook = installFakeWipeRestartHook();
    const { app, dataDir } = await makeEncryptedApp(
      { dbEncryptionKey: "a fixed passphrase-derived key", dbEncryptionMode: "passphrase" },
      { killSwitch: { enabled: true } },
    );
    const admin = await session(app);
    expect((await post(app, admin.cookie, "doomed")).statusCode).toBe(201);

    const wipe = await app.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });
    expect(wipe.statusCode).toBe(200);

    expect(hook.calls).toBe(1);
    expect(existsSync(join(dataDir, "loam.db"))).toBe(false);
  });

  it("RF1: persistent-mode wipe-restart takes effect immediately (503 on everything but /api/health) instead of leaving the running process serving stale in-memory content until a manual restart", async () => {
    const hook = installFakeWipeRestartHook();
    const { app } = await makeEncryptedApp(
      { dbEncryptionKey: "a fixed persistent key", dbEncryptionMode: "persistent" },
      { killSwitch: { enabled: true } },
    );
    const admin = await session(app);
    expect((await post(app, admin.cookie, "still readable before the wipe?")).statusCode).toBe(201);

    // Sanity: before the wipe, the admin's cookie sees the node's data as normal.
    const before = await app.server.inject({
      method: "GET",
      url: "/api/channels",
      headers: { cookie: admin.cookie },
    });
    expect(before.statusCode).toBe(200);

    const wipe = await app.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });
    expect(wipe.statusCode).toBe(200);
    expect(hook.calls).toBe(1);

    // The SAME still-valid-looking cookie must not see any in-memory content: no stale 200 while this
    // process waits for the launcher to actually restart it.
    const afterWithCookie = await app.server.inject({
      method: "GET",
      url: "/api/channels",
      headers: { cookie: admin.cookie },
    });
    expect(afterWithCookie.statusCode).toBe(503);

    // A brand-new (cookie-less) request is refused identically — it must not mint a fresh identity or
    // see any re-seeded default content on this still-live process either.
    const afterFreshSession = await app.server.inject({ method: "GET", url: "/api/channels" });
    expect(afterFreshSession.statusCode).toBe(503);

    // Posting is refused too — the process cannot accept new writes while it awaits its restart.
    const afterPost = await post(app, admin.cookie, "should never be accepted");
    expect(afterPost.statusCode).toBe(503);

    // The one exception: the Android launcher's liveness probe still works, so it can tell the process
    // is still alive (and eventually notice/trigger the actual restart).
    const health = await app.server.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
  });

  it("P1-2: falls back to the existing recreate-under-the-SAME-key behaviour when no launcher restart hook is installed (desktop/CI — documented limitation)", async () => {
    // Deliberately NOT installing __loamRequestWipeRestart — simulates a non-Android host.
    const { app, dataDir } = await makeEncryptedApp(
      { dbEncryptionKey: "a fixed passphrase key", dbEncryptionMode: "passphrase" },
      { killSwitch: { enabled: true } },
    );
    const admin = await session(app);
    expect((await post(app, admin.cookie, "doomed")).statusCode).toBe(201);

    const wipe = await app.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });
    expect(wipe.statusCode).toBe(200);

    // No hook available → the node must still boot usable, recreated in-process (same key) exactly as
    // it always has — this is the documented limitation, not a crash or a stuck kill switch.
    expect(app.store.loadMessages()).toEqual([]);
    expect(existsSync(join(dataDir, "loam.db"))).toBe(true);
    expect((await post(app, (await session(app)).cookie, "after")).statusCode).toBe(201);
  });

  it("P1-2(b): a durable wipe-pending marker is written before signaling the launcher, and this process never deletes it itself (only a verified `loam-wipe-complete` ack may)", async () => {
    const hook = installFakeWipeRestartHook();
    const { app, dataDir } = await makeEncryptedApp(
      { dbEncryptionKey: "a fixed persistent key", dbEncryptionMode: "persistent" },
      { killSwitch: { enabled: true } },
    );
    const admin = await session(app);

    const wipe = await app.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });
    expect(wipe.statusCode).toBe(200);
    expect(hook.calls).toBe(1);

    // This process signaled the launcher but has no way to observe whether it actually cleared the
    // Keystore key — the marker MUST still be on disk. Only main.js's `loam-wipe-complete` handler
    // (after a VERIFIED `clearStoredDbKeys()`) is allowed to delete it, and that never happens here
    // (the fake hook is a bare recorder, not a real launcher).
    expect(existsSync(join(dataDir, ".loam-wipe-pending"))).toBe(true);
  });

  it("P1-2(a): a concurrent request during the slow file-deletion await already sees the lockdown (503), never stale in-memory data", async () => {
    const hook = installFakeWipeRestartHook();
    const { app } = await makeEncryptedApp(
      { dbEncryptionKey: "a fixed persistent key", dbEncryptionMode: "persistent" },
      { killSwitch: { enabled: true } },
    );
    const admin = await session(app);
    expect((await post(app, admin.cookie, "must not leak out mid-deletion")).statusCode).toBe(201);

    let release!: () => void;
    rmGate.promise = new Promise<void>((resolve) => {
      release = resolve;
    });

    const wipePromise = app.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });

    // Let the handler's synchronous lockdown, broadcast, launcher signal, and config.json persist all
    // run and reach the gated `rm()` call, without letting that call resolve yet — this is the window
    // the OLD code left unprotected (the lockdown used to run AFTER these awaits, not before them).
    await new Promise((resolve) => setTimeout(resolve, 50));

    const concurrentRead = await app.server.inject({
      method: "GET",
      url: "/api/channels",
      headers: { cookie: admin.cookie },
    });
    expect(concurrentRead.statusCode).toBe(503);

    const concurrentWrite = await post(app, admin.cookie, "must never be accepted mid-deletion");
    expect(concurrentWrite.statusCode).toBe(503);

    const freshSession = await app.server.inject({ method: "GET", url: "/api/channels" });
    expect(freshSession.statusCode).toBe(503);

    release();
    const wipe = await wipePromise;
    expect(wipe.statusCode).toBe(200);
    expect(hook.calls).toBe(1);
  });

  it("P1-4 (Sol round 5): config.json is persisted DURABLY before the wipe-pending marker is written and the launcher hook is signaled", async () => {
    const hook = installFakeWipeRestartHook();
    const { app, dataDir } = await makeEncryptedApp(
      { dbEncryptionKey: "a fixed persistent key", dbEncryptionMode: "persistent" },
      { killSwitch: { enabled: true } },
    );
    const admin = await session(app);

    let release!: () => void;
    configWriteGate.promise = new Promise<void>((resolve) => {
      release = resolve;
    });

    const wipePromise = app.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });

    // Give the handler a turn to run its synchronous lockdown (RF-a) and then reach (and block on) the
    // gated config.json write — which still precedes the marker + hook, per P1-4's fixed ordering.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Neither the durable marker nor the launcher signal has happened yet — config persistence comes
    // first now, not after (the bug this fixes: the OLD order let both fire before config was durable).
    expect(hook.calls).toBe(0);
    expect(existsSync(join(dataDir, ".loam-wipe-pending"))).toBe(false);

    // RF-a (adversarial review): a request landing DURING the persistConfigForRestart await must ALREADY
    // see the 503 lockdown, never a stale 200 from the still-populated `data`/`sessions`. This is the
    // confidentiality regression the fix closes — P1-4 had moved this await ahead of the synchronous
    // lockdown, so before the fix this GET was served a normal 200 with real content on the kill path.
    const duringConfigWrite = await app.server.inject({
      method: "GET",
      url: "/api/channels",
      headers: { cookie: admin.cookie },
    });
    expect(duringConfigWrite.statusCode).toBe(503);

    release();
    const wipe = await wipePromise;
    expect(wipe.statusCode).toBe(200);
    expect(hook.calls).toBe(1);
    expect(existsSync(join(dataDir, ".loam-wipe-pending"))).toBe(true);
  });

  it("P1-4 (Sol round 5): retries a failed config.json persist once, and on a SECOND failure still proceeds with the wipe (reporting a distinct notice, never silently continuing as if config were preserved)", async () => {
    const hook = installFakeWipeRestartHook();
    const { app, dataDir } = await makeEncryptedApp(
      { dbEncryptionKey: "a fixed persistent key", dbEncryptionMode: "persistent" },
      { killSwitch: { enabled: true } },
    );
    const admin = await session(app);

    // Fail the config.json write exactly once — the retry (attempt 2) succeeds.
    configWriteFailures.remaining = 1;
    const errorSpy = vi.spyOn(app.server.log, "error");

    const wipeOnce = await app.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });
    expect(wipeOnce.statusCode).toBe(200);
    expect(hook.calls).toBe(1);
    expect(existsSync(join(dataDir, ".loam-wipe-pending"))).toBe(true);
    // Recovered on retry — config.json exists and carries the effective config (the armed kill switch).
    const recoveredConfig = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) as {
      killSwitch: { enabled: boolean };
    };
    expect(recoveredConfig.killSwitch.enabled).toBe(true);
    errorSpy.mockRestore();

    // A SECOND node, where the config write fails twice in a row (attempt 1 AND the retry) — the wipe
    // must still proceed (data-destruction priority) rather than get stuck, but must report a distinct
    // notice rather than the ordinary "signaled" log line.
    const hook2 = installFakeWipeRestartHook();
    const second = await makeEncryptedApp(
      { dbEncryptionKey: "another fixed persistent key", dbEncryptionMode: "persistent" },
      { killSwitch: { enabled: true } },
    );
    const admin2 = await session(second.app);
    configWriteFailures.remaining = 2;
    const errorSpy2 = vi.spyOn(second.app.server.log, "error");

    const wipeTwice = await second.app.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin2.cookie },
      payload: { confirm: "wipe" },
    });
    expect(wipeTwice.statusCode).toBe(200);
    // The wipe still proceeded — the launcher was still signaled and the durable marker still written —
    // even though config.json could not be persisted.
    expect(hook2.calls).toBe(1);
    expect(existsSync(join(second.dataDir, ".loam-wipe-pending"))).toBe(true);
    expect(existsSync(join(second.dataDir, "loam.db"))).toBe(false);
    // A distinct, unmistakable notice was logged — never silently "succeeded".
    expect(errorSpy2.mock.calls.some((call) => String(call[call.length - 1] ?? "").includes("KILL SWITCH NOTICE"))).toBe(
      true,
    );
    errorSpy2.mockRestore();
  });

  it("P1-d (Sol round 6): when the durable wipe-pending marker CANNOT be written, the ciphertext is deleted and VERIFIED gone SYNCHRONOUSLY before the launcher is signaled (fail closed) — a kill right after the hook cannot recover the data", async () => {
    // A launcher hook that records, at the moment it is called, whether ANY ciphertext file still exists.
    // The fix's guarantee is that by the time the launcher is signaled, the ciphertext is already gone —
    // so a kill immediately after `hook()` (with RN's key-clear also interrupted) leaves nothing to recover.
    const reports = installFakeBootBridge();
    const { app, dataDir } = await makeEncryptedApp(
      { dbEncryptionKey: "a fixed persistent key", dbEncryptionMode: "persistent" },
      { killSwitch: { enabled: true } },
    );

    let ciphertextPresentAtHook: boolean | undefined;
    let hookCalls = 0;
    (globalThis as unknown as { __loamRequestWipeRestart?: () => void }).__loamRequestWipeRestart = () => {
      ciphertextPresentAtHook =
        existsSync(join(dataDir, "loam.db")) ||
        existsSync(join(dataDir, "loam.db-wal")) ||
        existsSync(join(dataDir, "loam.db-shm"));
      hookCalls += 1;
    };
    cleanups.push(() => {
      delete (globalThis as unknown as { __loamRequestWipeRestart?: unknown }).__loamRequestWipeRestart;
    });

    const admin = await session(app);
    expect((await post(app, admin.cookie, "MUST_NOT_SURVIVE_A_FAILED_MARKER")).statusCode).toBe(201);
    expect(existsSync(join(dataDir, "loam.db"))).toBe(true);

    // Force the durable marker write to fail — this is exactly the fail-open window P1-d closes.
    wipeMarkerWriteFailure.armed = true;

    const wipe = await app.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });
    expect(wipe.statusCode).toBe(200);

    // The crux: the launcher WAS signaled, but the ciphertext was already gone at that instant — so a stop
    // immediately after the hook cannot recover the encrypted data (the fail-OPEN bug would have had the
    // ciphertext still present here, deleted only by a later async rm that a kill could skip).
    expect(hookCalls).toBe(1);
    expect(ciphertextPresentAtHook).toBe(false);

    // And it is genuinely gone on disk afterward, with NO marker written (the write failed by design).
    expect(existsSync(join(dataDir, "loam.db"))).toBe(false);
    expect(existsSync(join(dataDir, "loam.db-wal"))).toBe(false);
    expect(existsSync(join(dataDir, "loam.db-shm"))).toBe(false);
    expect(existsSync(join(dataDir, ".loam-wipe-pending"))).toBe(false);

    // A distinct notice was surfaced so the operator knows the wipe completed without a resumable marker
    // (and must reopen to finish clearing the now-unused key if RN's key-clear was also interrupted).
    expect(reports.some((r) => r.code === "kill_switch_wipe_no_marker")).toBe(true);
  });

  describe("P1-3 (Sol round 4): the fixed-key wipe preserves admin-set config across the restart, with plaintext bearer secrets blanked", () => {
    async function expectConfigSurvivesFixedKeyWipe(dbEncryptionMode: "persistent" | "passphrase"): Promise<void> {
      const hook = installFakeWipeRestartHook();
      const { app, dataDir } = await makeEncryptedApp({
        dbEncryptionKey: `key A (${dbEncryptionMode})`,
        dbEncryptionMode,
      });
      const admin = await session(app);

      // Change settings ONLY via the admin API (never the initial config file) — exactly the scenario
      // the fix targets: an armed kill switch and a sync token that only ever lived in the DB `config`
      // table, which the fixed-key wipe branch deletes without ever recreating one in-process.
      const patch = await app.server.inject({
        method: "PATCH",
        url: "/api/admin/config",
        headers: { cookie: admin.cookie },
        payload: {
          killSwitch: { enabled: true },
          sync: { enabled: true, token: "a-plaintext-bearer-sync-token-9" },
        },
      });
      expect(patch.statusCode).toBe(200);

      const wipe = await app.server.inject({
        method: "POST",
        url: "/api/admin/kill-switch",
        headers: { cookie: admin.cookie },
        payload: { confirm: "wipe" },
      });
      expect(wipe.statusCode).toBe(200);
      expect(hook.calls).toBe(1);

      // config.json — the only surviving file — carries the effective config, with the plaintext sync
      // token blanked (unlike the already-scrypt-hashed admin.passphrase/killSwitch.panicToken, which
      // are safe to persist as-is and are NOT asserted away here).
      const rawConfig = readFileSync(join(dataDir, "config.json"), "utf8");
      expect(rawConfig).not.toContain("a-plaintext-bearer-sync-token-9");
      const configOnDisk = JSON.parse(rawConfig) as { killSwitch: { enabled: boolean }; sync: { token?: string } };
      expect(configOnDisk.killSwitch.enabled).toBe(true);
      expect(configOnDisk.sync.token).toBeUndefined();

      // Simulate the launcher's actual restart: a fresh boot, same dataDir, a NEW (rotated) key — the
      // whole point of the P1-2 handoff. The fresh DB's config table starts empty, so config.json is
      // the ONLY thing carrying the admin's settings forward into the new boot.
      const restarted = await buildApp({
        dataDir,
        logger: false,
        dbEncryptionKey: `key B (${dbEncryptionMode}, rotated)`,
        dbEncryptionMode,
      });
      try {
        const restartedAdmin = await session(restarted);
        const config = (
          await restarted.server.inject({
            method: "GET",
            url: "/api/admin/config",
            headers: { cookie: restartedAdmin.cookie },
          })
        ).json() as { killSwitch: { enabled: boolean }; sync: { enabled: boolean; token?: string } };

        // Not silently reverted to config.json-absent/defaults — the armed kill switch survives.
        expect(config.killSwitch.enabled).toBe(true);
        expect(config.sync.enabled).toBe(true);
        expect(config.sync.token).toBeUndefined();
      } finally {
        await restarted.close();
      }
    }

    it("persistent mode", async () => {
      await expectConfigSurvivesFixedKeyWipe("persistent");
    });

    it("passphrase mode", async () => {
      await expectConfigSurvivesFixedKeyWipe("passphrase");
    });
  });

  describe("P1-2 (Sol round 7): the kill switch wipes EVERY DB artifact (migration/recovery sidecars), not just the 3 live files", () => {
    const SENTINEL = "PREMIGRATION_LEGACY_SECRET";
    // Every NON-live artifact `dbArtifactPaths()` must reach: the DELETE-mode rollback journal, the full
    // `.premigration` snapshot family (+ the legacy multi-file `-wal`/`-shm` sidecars), and the
    // timestamped `*.unreadable-<ts>` recovery renames.
    const STALE_NAMES = [
      "loam.db-journal",
      "loam.db.premigration.tmp",
      "loam.db.premigration-wal",
      "loam.db.premigration-shm",
      "loam.db.premigration-journal",
      "loam.db-wal.premigration",
      "loam.db-shm.premigration",
      "loam.db.unreadable-1700000000000-abc123",
      "loam.db-wal.unreadable-1700000000000-abc123",
      "loam.db-journal.unreadable-1700000000000-abc123",
    ];

    /** Seed a REAL legacy-key-encrypted `loam.db.premigration` (openable with `legacyKey`, which has no
     *  discardable device secret — THE crypto-wipe hole) plus every other stale DB artifact into
     *  `dataDir`, alongside a running app's live DB. */
    function seedStaleDbArtifacts(dataDir: string, legacyKey: string): void {
      const seedDir = mkdtempSync(join(tmpdir(), "loam-legacy-premig-"));
      cleanups.push(() => rmSync(seedDir, { recursive: true, force: true }));
      const seedDb = join(seedDir, "legacy.db");
      const legacy = openStore(seedDb, { encryptionKey: legacyKey });
      legacy.setConfigValue("legacy-sentinel", SENTINEL);
      legacy.checkpoint();
      legacy.close();
      // Sanity: it really IS a legacy-key DB — anyone with the passphrase can still open it, which is
      // exactly why leaving `.premigration` behind (encrypted under the legacy key, not a discardable
      // device secret) breaks the cryptographic-wipe guarantee.
      const verify = openStore(seedDb, { encryptionKey: legacyKey });
      expect(verify.getConfigValue("legacy-sentinel")).toBe(SENTINEL);
      verify.checkpoint();
      verify.close();
      copyFileSync(seedDb, join(dataDir, "loam.db.premigration"));
      for (const name of STALE_NAMES) {
        writeFileSync(join(dataDir, name), Buffer.from(`stale artifact: ${name}`));
      }
    }

    /** Every stale DB artifact still on disk (empty = a clean wipe). Excludes the LIVE `loam.db`/`-wal`/
     *  `-shm`, which the ephemeral/same-key/off paths legitimately recreate/keep open. */
    function staleArtifactsRemaining(dataDir: string): string[] {
      if (!existsSync(dataDir)) return [];
      const liveNames = new Set(["loam.db", "loam.db-wal", "loam.db-shm"]);
      return readdirSync(dataDir).filter(
        (n) =>
          !liveNames.has(n) &&
          (n.includes(".premigration") || n.includes(".unreadable-") || n === "loam.db-journal"),
      );
    }

    async function fireKillSwitch(app: LoamApp, cookie: string): Promise<InjectResponse> {
      return app.server.inject({
        method: "POST",
        url: "/api/admin/kill-switch",
        headers: { cookie },
        payload: { confirm: "wipe" },
      });
    }

    it("marker-SUCCESS branch (fixed-key + launcher hook): deletes the legacy .premigration + journal + unreadable renames, not just the live files", async () => {
      const hook = installFakeWipeRestartHook();
      const { app, dataDir } = await makeEncryptedApp(
        { dbEncryptionKey: "a fixed persistent key", dbEncryptionMode: "persistent" },
        { killSwitch: { enabled: true } },
      );
      const admin = await session(app);
      expect((await post(app, admin.cookie, "doomed")).statusCode).toBe(201);
      seedStaleDbArtifacts(dataDir, "an old legacy premigration key");
      expect(existsSync(join(dataDir, "loam.db.premigration"))).toBe(true);

      expect((await fireKillSwitch(app, admin.cookie)).statusCode).toBe(200);
      expect(hook.calls).toBe(1);

      expect(existsSync(join(dataDir, "loam.db"))).toBe(false);
      // The legacy-key backup (and every other sidecar) is physically gone — no passphrase can open it.
      expect(staleArtifactsRemaining(dataDir)).toEqual([]);
      expect(existsSync(join(dataDir, "loam.db.premigration"))).toBe(false);
    });

    it("marker-FAILURE fail-closed branch (fixed-key, marker write fails): synchronously deletes AND verifies EVERY artifact before signaling the launcher", async () => {
      const { app, dataDir } = await makeEncryptedApp(
        { dbEncryptionKey: "a fixed persistent key", dbEncryptionMode: "persistent" },
        { killSwitch: { enabled: true } },
      );

      let artifactsPresentAtHook: string[] | undefined;
      (globalThis as unknown as { __loamRequestWipeRestart?: () => void }).__loamRequestWipeRestart = () => {
        artifactsPresentAtHook = staleArtifactsRemaining(dataDir);
      };
      cleanups.push(() => {
        delete (globalThis as unknown as { __loamRequestWipeRestart?: unknown }).__loamRequestWipeRestart;
      });

      const admin = await session(app);
      expect((await post(app, admin.cookie, "doomed")).statusCode).toBe(201);
      seedStaleDbArtifacts(dataDir, "an old legacy premigration key");

      wipeMarkerWriteFailure.armed = true;
      expect((await fireKillSwitch(app, admin.cookie)).statusCode).toBe(200);

      // Fail-closed: by the time the launcher was signaled EVERY stale artifact was already gone (not
      // just the 3 live files) — a kill right after the hook can't recover the legacy-key ciphertext.
      expect(artifactsPresentAtHook).toEqual([]);
      expect(staleArtifactsRemaining(dataDir)).toEqual([]);
      expect(existsSync(join(dataDir, "loam.db"))).toBe(false);
      expect(existsSync(join(dataDir, ".loam-wipe-pending"))).toBe(false);
    });

    it("ephemeral branch: deletes stale migration/recovery artifacts before rotating to a fresh key", async () => {
      const { app, dataDir } = await makeEncryptedApp(
        { ephemeralDbKey: true, dbEncryptionMode: "ephemeral" },
        { killSwitch: { enabled: true } },
      );
      const admin = await session(app);
      expect((await post(app, admin.cookie, "doomed")).statusCode).toBe(201);
      seedStaleDbArtifacts(dataDir, "an old legacy premigration key");

      expect((await fireKillSwitch(app, admin.cookie)).statusCode).toBe(200);

      // The live DB is recreated under a fresh key (loam.db exists), but every stale artifact is gone.
      expect(existsSync(join(dataDir, "loam.db"))).toBe(true);
      expect(staleArtifactsRemaining(dataDir)).toEqual([]);
      expect(app.store.loadMessages()).toEqual([]);
      expect((await post(app, (await session(app)).cookie, "after wipe")).statusCode).toBe(201);
    });

    it("same-key fallback branch (fixed-key, NO launcher hook): deletes stale artifacts before recreating under the same key", async () => {
      // Deliberately NOT installing __loamRequestWipeRestart — the desktop/CI same-key fallback.
      const { app, dataDir } = await makeEncryptedApp(
        { dbEncryptionKey: "a fixed passphrase key", dbEncryptionMode: "passphrase" },
        { killSwitch: { enabled: true } },
      );
      const admin = await session(app);
      expect((await post(app, admin.cookie, "doomed")).statusCode).toBe(201);
      seedStaleDbArtifacts(dataDir, "an old legacy premigration key");

      expect((await fireKillSwitch(app, admin.cookie)).statusCode).toBe(200);

      expect(existsSync(join(dataDir, "loam.db"))).toBe(true); // recreated under the same key
      expect(staleArtifactsRemaining(dataDir)).toEqual([]);
      expect(app.store.loadMessages()).toEqual([]);
    });

    it("off/wipeAll branch (unencrypted): removes stale encrypted-era artifacts while keeping the live plaintext DB open", async () => {
      const { app, dataDir } = await makeEncryptedApp({}, { killSwitch: { enabled: true } });
      const admin = await session(app);
      expect((await post(app, admin.cookie, "doomed")).statusCode).toBe(201);
      seedStaleDbArtifacts(dataDir, "an old legacy premigration key");

      expect((await fireKillSwitch(app, admin.cookie)).statusCode).toBe(200);

      expect(existsSync(join(dataDir, "loam.db"))).toBe(true); // live plaintext DB stays open (wipeAll)
      expect(staleArtifactsRemaining(dataDir)).toEqual([]);
      expect(app.store.loadMessages()).toEqual([]);
    });
  });

  /** Install the `globalThis.__loamReportBootError` bridge (the same one `embedded-main.ts` uses for
   *  fatal boot errors — see its own test suite) and capture every report. Auto-uninstalled. */
  function installFakeBootBridge(): { message: string; code: string }[] {
    const reports: { message: string; code: string }[] = [];
    (
      globalThis as unknown as { __loamReportBootError?: (message: string, code: string) => void }
    ).__loamReportBootError = (message, code) => reports.push({ message, code });
    cleanups.push(() => {
      delete (globalThis as unknown as { __loamReportBootError?: unknown }).__loamReportBootError;
    });
    return reports;
  }

  describe("P1-1 (Sol round 5): passphrase key-derivation migration (dbEncryptionMigrateFromKey / PRAGMA rekey)", () => {
    /** Install the `globalThis.__loamReportDbKeyMigrated` bridge (main.js's migration-confirmed signal,
     *  see db-encryption.ts's `markPassphraseKeyMigrated`) and count every invocation. Auto-uninstalled. */
    function installFakeMigratedHook(): { calls: number } {
      const state = { calls: 0 };
      (globalThis as unknown as { __loamReportDbKeyMigrated?: () => void }).__loamReportDbKeyMigrated = () => {
        state.calls += 1;
      };
      cleanups.push(() => {
        delete (globalThis as unknown as { __loamReportDbKeyMigrated?: unknown }).__loamReportDbKeyMigrated;
      });
      return state;
    }

    it("migrates an existing legacy-keyed passphrase DB in place: rows survive, the current key opens it directly afterward, the legacy key no longer does, and the launcher is told it migrated", async () => {
      const migrated = installFakeMigratedHook();
      const legacyKey = "legacy SHA256(passphrase)-only key";
      const currentKey = "current SHA256(passphrase + deviceSecret) key";

      const dataDir = mkdtempSync(join(tmpdir(), "loam-migrate-test-"));
      cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));

      // An "existing" passphrase DB, encrypted under the pre-round-4 legacy derivation.
      const original = await buildApp({
        dataDir,
        logger: false,
        dbEncryptionKey: legacyKey,
        dbEncryptionMode: "passphrase",
      });
      const admin = await session(original);
      expect((await post(original, admin.cookie, "MIGRATE_ME")).statusCode).toBe(201);
      await original.close();

      expect(migrated.calls).toBe(0);

      // Boot with the CURRENT key plus the legacy key as a migration fallback — mirrors main.js offering
      // both because it hasn't recorded a confirmed migration yet.
      const migratedApp = await buildApp({
        dataDir,
        logger: false,
        dbEncryptionKey: currentKey,
        dbEncryptionMigrateFromKey: legacyKey,
        dbEncryptionMode: "passphrase",
      });

      expect(migrated.calls).toBe(1);
      expect(migratedApp.store.loadMessages().some((m) => "body" in m && m.body === "MIGRATE_ME")).toBe(true);
      // RF-b: a CLEAN migration deletes the pre-migration backup sidecars — none must be left behind (a
      // leftover would be misread as an interrupted migration on the next boot and trigger a restore).
      expect(readdirSync(dataDir).some((name) => name.includes(".premigration"))).toBe(false);
      await migratedApp.close();

      // Rekeyed in place: a LATER boot with only the current key (no legacy key offered at all) opens
      // the same file directly.
      const reopened = await buildApp({
        dataDir,
        logger: false,
        dbEncryptionKey: currentKey,
        dbEncryptionMode: "passphrase",
      });
      expect(reopened.store.loadMessages().some((m) => "body" in m && m.body === "MIGRATE_ME")).toBe(true);
      await reopened.close();

      // The OLD legacy key can no longer open the file at all.
      await expect(
        buildApp({ dataDir, logger: false, dbEncryptionKey: legacyKey, dbEncryptionMode: "passphrase" }),
      ).rejects.toThrow();
    });

    it("RF-b: an interrupted rekey (a .premigration backup present alongside a corrupt/half loam.db) is restored on boot and migrates successfully", async () => {
      const migrated = installFakeMigratedHook();
      const legacyKey = "legacy SHA256(passphrase)-only key";
      const currentKey = "current SHA256(passphrase + deviceSecret) key";

      const dataDir = mkdtempSync(join(tmpdir(), "loam-migrate-interrupt-test-"));
      cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));

      // A real legacy-encrypted passphrase DB with a row we must not lose.
      const original = await buildApp({
        dataDir,
        logger: false,
        dbEncryptionKey: legacyKey,
        dbEncryptionMode: "passphrase",
      });
      const admin = await session(original);
      expect((await post(original, admin.cookie, "SURVIVE_INTERRUPTED_REKEY")).statusCode).toBe(201);
      await original.close();

      // Simulate a rekey interrupted by an OS-kill AFTER the pre-migration backup was taken but BEFORE
      // (or during) the in-place PRAGMA rekey completed: the intact legacy files are preserved under
      // `.premigration`, while the live `loam.db` is now half-rekeyed/corrupt (openable under neither key).
      for (const suffix of ["", "-wal", "-shm"]) {
        const live = join(dataDir, `loam.db${suffix}`);
        if (existsSync(live)) {
          copyFileSync(live, `${live}.premigration`);
        }
      }
      writeFileSync(join(dataDir, "loam.db"), Buffer.from("not a database — half-rekeyed corruption"));

      // Boot: Step 0b must restore the intact legacy DB from the sidecars, then the migration branch
      // rekeys it to the current key. The row survives and the launcher is told it migrated.
      const recovered = await buildApp({
        dataDir,
        logger: false,
        dbEncryptionKey: currentKey,
        dbEncryptionMigrateFromKey: legacyKey,
        dbEncryptionMode: "passphrase",
      });
      expect(migrated.calls).toBe(1);
      expect(
        recovered.store.loadMessages().some((m) => "body" in m && m.body === "SURVIVE_INTERRUPTED_REKEY"),
      ).toBe(true);
      // The successful re-migration cleaned up the sidecars.
      expect(readdirSync(dataDir).some((name) => name.includes(".premigration"))).toBe(false);
      await recovered.close();

      // And the rekey actually took: a later boot with only the current key opens it directly.
      const reopened = await buildApp({
        dataDir,
        logger: false,
        dbEncryptionKey: currentKey,
        dbEncryptionMode: "passphrase",
      });
      expect(
        reopened.store.loadMessages().some((m) => "body" in m && m.body === "SURVIVE_INTERRUPTED_REKEY"),
      ).toBe(true);
      await reopened.close();
    });

    it("P2-2 (Sol round 7): a post-rekey CLEANUP failure does NOT fail the boot — the current boot returns a ready, migrated store with data intact (not a plaintext/unreadable fallback)", async () => {
      const migrated = installFakeMigratedHook();
      const legacyKey = "legacy SHA256(passphrase)-only key";
      const currentKey = "current SHA256(passphrase + deviceSecret) key";

      const dataDir = mkdtempSync(join(tmpdir(), "loam-p22-cleanup-fail-"));
      cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));

      const original = await buildApp({
        dataDir,
        logger: false,
        dbEncryptionKey: legacyKey,
        dbEncryptionMode: "passphrase",
      });
      const admin = await session(original);
      expect((await post(original, admin.cookie, "SURVIVE_CLEANUP_FAILURE")).statusCode).toBe(201);
      await original.close();

      // Force the POST-rekey cleanup `rmSync(loam.db.premigration)` to throw. Before the fix that jumped to
      // the outer migration `catch` and fell through as if the rekey had FAILED — leaking the already-
      // rekeyed handle and running the plaintext/recovery chain against a DB already valid under the current
      // key. The fix treats the rekey as the commit point, so the cleanup failure is swallowed best-effort.
      postRekeyCleanupFailure.armed = true;

      const migratedApp = await buildApp({
        dataDir,
        logger: false,
        dbEncryptionKey: currentKey,
        dbEncryptionMigrateFromKey: legacyKey,
        dbEncryptionMode: "passphrase",
      });

      // The rekey is the commit point: the boot returns the LIVE migrated store — the launcher is told it
      // migrated and the row survives (NOT a plaintext/unreadable fallback that would lose or expose data).
      expect(migrated.calls).toBe(1);
      expect(
        migratedApp.store.loadMessages().some((m) => "body" in m && m.body === "SURVIVE_CLEANUP_FAILURE"),
      ).toBe(true);
      // Genuinely encrypted under the current key (not the plaintext fallback) — no plaintext on disk.
      expect(dataDirHasPlaintext(dataDir, "SURVIVE_CLEANUP_FAILURE")).toBe(false);
      // The cleanup failed, so the stale backup is INTENTIONALLY left behind for the next boot's Step-0b.
      expect(existsSync(join(dataDir, "loam.db.premigration"))).toBe(true);
      await migratedApp.close();

      // A later boot with ONLY the current key opens directly (the rekey took) AND Step-0b discards the
      // stale backup the failed cleanup left — proving the cleanup failure never corrupted the migration.
      const reopened = await buildApp({
        dataDir,
        logger: false,
        dbEncryptionKey: currentKey,
        dbEncryptionMode: "passphrase",
      });
      expect(
        reopened.store.loadMessages().some((m) => "body" in m && m.body === "SURVIVE_CLEANUP_FAILURE"),
      ).toBe(true);
      expect(existsSync(join(dataDir, "loam.db.premigration"))).toBe(false);
      await reopened.close();
    });

    describe("P1-a (Sol round 6): the pre-migration backup is CRASH-ATOMIC (single-file, checkpoint-folded, commit-by-rename)", () => {
      const legacyKey = "legacy SHA256(passphrase)-only key";
      const currentKey = "current SHA256(passphrase + deviceSecret) key";

      /** Build a legacy-encrypted passphrase DB carrying `body`, closed cleanly (WAL checkpointed away, so
       *  only a single-file `loam.db` remains on disk). Returns the dataDir it lives in. */
      async function makeLegacyDb(body: string): Promise<string> {
        const dataDir = mkdtempSync(join(tmpdir(), "loam-p1a-test-"));
        cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
        const app = await buildApp({ dataDir, logger: false, dbEncryptionKey: legacyKey, dbEncryptionMode: "passphrase" });
        const admin = await session(app);
        expect((await post(app, admin.cookie, body)).statusCode).toBe(201);
        await app.close();
        return dataDir;
      }

      /** Assert `dataDir` migrates cleanly under the current key with `body` intact and no leftover backup
       *  artifacts (neither a committed `.premigration` nor a stray `.premigration.tmp`). */
      async function expectCleanMigration(dataDir: string, body: string): Promise<void> {
        const migrated = installFakeMigratedHook();
        const app = await buildApp({
          dataDir,
          logger: false,
          dbEncryptionKey: currentKey,
          dbEncryptionMigrateFromKey: legacyKey,
          dbEncryptionMode: "passphrase",
        });
        expect(migrated.calls).toBe(1);
        expect(app.store.loadMessages().some((m) => "body" in m && m.body === body)).toBe(true);
        expect(readdirSync(dataDir).some((name) => name.includes(".premigration"))).toBe(false);
        await app.close();
      }

      it("kill AFTER checkpoint but BEFORE the copy: no backup artifacts exist, so the migration simply re-runs on the intact live DB", async () => {
        // A checkpoint is non-destructive; a kill right after it (before any copy) leaves the intact legacy
        // DB and NO `.premigration`/`.tmp` at all. This models that exact on-disk state.
        const dataDir = await makeLegacyDb("AFTER_CHECKPOINT_BEFORE_COPY");
        expect(readdirSync(dataDir).some((name) => name.includes(".premigration"))).toBe(false);
        await expectCleanMigration(dataDir, "AFTER_CHECKPOINT_BEFORE_COPY");
      });

      it("kill AFTER the copy but BEFORE the commit rename: a stray `.premigration.tmp` is DISCARDED, never restored, and the migration re-runs on the intact live DB", async () => {
        const dataDir = await makeLegacyDb("AFTER_COPY_BEFORE_RENAME");
        // Simulate a kill mid-copy: a truncated/partial `.tmp` is present, but no COMMITTED backup exists.
        writeFileSync(join(dataDir, "loam.db.premigration.tmp"), Buffer.from("a half-written backup copy"));
        expect(existsSync(join(dataDir, "loam.db.premigration"))).toBe(false);

        // Step 0b must NOT restore from the uncommitted `.tmp` (that is the whole crash-atomicity guarantee —
        // an incomplete backup can never replace the intact live DB); it discards it and the migration runs.
        await expectCleanMigration(dataDir, "AFTER_COPY_BEFORE_RENAME");
        expect(existsSync(join(dataDir, "loam.db.premigration.tmp"))).toBe(false);
      });

      it("kill AFTER the backup commit but BEFORE the rekey: the committed single-file backup is restored (single atomic rename) and the migration retries", async () => {
        const dataDir = await makeLegacyDb("AFTER_COMMIT_BEFORE_REKEY");
        // The committed backup exists and the rekey never ran, so the live DB still equals the (intact,
        // legacy-encrypted) backup — exactly the state a kill in this window leaves.
        copyFileSync(join(dataDir, "loam.db"), join(dataDir, "loam.db.premigration"));

        await expectCleanMigration(dataDir, "AFTER_COMMIT_BEFORE_REKEY");
      });

      it("kill MID-rekey: the committed single-file backup is restored over the half-rekeyed (corrupt) live DB and the migration retries", async () => {
        const dataDir = await makeLegacyDb("MID_REKEY");
        // Committed backup = the intact legacy DB; live loam.db = half-rekeyed corruption (openable under
        // neither key) plus stale `-wal`/`-shm` from the interrupted rekey.
        copyFileSync(join(dataDir, "loam.db"), join(dataDir, "loam.db.premigration"));
        writeFileSync(join(dataDir, "loam.db"), Buffer.from("half-rekeyed corruption — opens under no key"));
        writeFileSync(join(dataDir, "loam.db-wal"), Buffer.from("stale half-rekey wal"));
        writeFileSync(join(dataDir, "loam.db-shm"), Buffer.from("stale half-rekey shm"));

        await expectCleanMigration(dataDir, "MID_REKEY");
      });

      it("committed data still resident in the WAL: the checkpoint folds it into the single-file backup, which a restore then preserves (no committed rows lost)", async () => {
        // 1. Build a legacy DB whose committed row lives ONLY in the WAL, not in loam.db's main file.
        const dataDir = mkdtempSync(join(tmpdir(), "loam-p1a-wal-test-"));
        cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
        const producer = await buildApp({
          dataDir,
          logger: false,
          dbEncryptionKey: legacyKey,
          dbEncryptionMode: "passphrase",
        });
        const admin = await session(producer);
        expect((await post(producer, admin.cookie, "WAL_RESIDENT_ROW")).statusCode).toBe(201);
        // Snapshot the live files WHILE the connection is open (row committed to the WAL, not yet folded
        // into the main file — nothing writes after the synchronous write-through, so the copy is quiescent).
        const snapDir = mkdtempSync(join(tmpdir(), "loam-p1a-wal-snap-"));
        for (const suffix of ["", "-wal", "-shm"]) {
          const live = join(dataDir, `loam.db${suffix}`);
          if (existsSync(live)) copyFileSync(live, join(snapDir, `loam.db${suffix}`));
        }
        await producer.close(); // a clean close checkpoints + deletes the WAL — undone by the restore below
        for (const suffix of ["", "-wal", "-shm"]) {
          const snap = join(snapDir, `loam.db${suffix}`);
          const live = join(dataDir, `loam.db${suffix}`);
          if (existsSync(snap)) copyFileSync(snap, live);
          else rmSync(live, { force: true });
        }

        // Precondition proof: the main file ALONE (no WAL) does not yet contain the row — it is WAL-resident.
        const mainOnlyDir = mkdtempSync(join(tmpdir(), "loam-p1a-mainonly-"));
        cleanups.push(() => rmSync(mainOnlyDir, { recursive: true, force: true }));
        copyFileSync(join(snapDir, "loam.db"), join(mainOnlyDir, "loam.db"));
        const mainOnly = openStore(join(mainOnlyDir, "loam.db"), { encryptionKey: legacyKey });
        expect(mainOnly.loadMessages().some((m) => "body" in m && m.body === "WAL_RESIDENT_ROW")).toBe(false);
        mainOnly.close();
        rmSync(snapDir, { recursive: true, force: true });

        // 2. Capture the single-file backup the migration commits, and run the (clean) migration.
        const captureDir = mkdtempSync(join(tmpdir(), "loam-p1a-capture-"));
        cleanups.push(() => rmSync(captureDir, { recursive: true, force: true }));
        backupCapture.dir = captureDir;
        const migrated = installFakeMigratedHook();
        const migratedApp = await buildApp({
          dataDir,
          logger: false,
          dbEncryptionKey: currentKey,
          dbEncryptionMigrateFromKey: legacyKey,
          dbEncryptionMode: "passphrase",
        });
        expect(migrated.calls).toBe(1);
        // The clean migration preserved the WAL-resident row.
        expect(migratedApp.store.loadMessages().some((m) => "body" in m && m.body === "WAL_RESIDENT_ROW")).toBe(true);
        await migratedApp.close();

        // 3. The CAPTURED single-file backup — a copy of loam.db taken AFTER the checkpoint but BEFORE the
        // rekey — contains the row. Without the checkpoint-before-copy this file would be the main-only file
        // proven row-less above, and a restore from it would lose committed data.
        const captured = openStore(join(captureDir, "captured-backup.db"), { encryptionKey: legacyKey });
        expect(captured.loadMessages().some((m) => "body" in m && m.body === "WAL_RESIDENT_ROW")).toBe(true);
        captured.close();

        // 4. End-to-end restore: feed that production-made backup back through Step 0b over a corrupt live
        // DB and confirm the row survives the backup+restore round trip.
        backupCapture.dir = undefined;
        copyFileSync(join(captureDir, "captured-backup.db"), join(dataDir, "loam.db.premigration"));
        writeFileSync(join(dataDir, "loam.db"), Buffer.from("corrupt live db — must be restored from backup"));
        rmSync(join(dataDir, "loam.db-wal"), { force: true });
        rmSync(join(dataDir, "loam.db-shm"), { force: true });
        const migrated2 = installFakeMigratedHook();
        const restored = await buildApp({
          dataDir,
          logger: false,
          dbEncryptionKey: currentKey,
          dbEncryptionMigrateFromKey: legacyKey,
          dbEncryptionMode: "passphrase",
        });
        expect(migrated2.calls).toBe(1);
        expect(restored.store.loadMessages().some((m) => "body" in m && m.body === "WAL_RESIDENT_ROW")).toBe(true);
        expect(readdirSync(dataDir).some((name) => name.includes(".premigration"))).toBe(false);
        await restored.close();
      });

      it("RF6-a: an interrupted DELETE-mode rekey leaves a foreign `loam.db-journal` — Step 0b removes it so the restored single file is never paired with a hot rollback journal", async () => {
        const dataDir = await makeLegacyDb("SURVIVES_FOREIGN_JOURNAL");
        // Committed backup = the intact legacy DB. The live loam.db is half-rekeyed corruption (opens
        // under no key) PLUS a `loam.db-journal` — the rollback journal a DELETE-mode rekey (the mode
        // SQLCipher forces for rekey; it refuses under WAL) leaves when killed mid-way. This is NOT a
        // `-wal`/`-shm` pair, which is exactly the state the old Step 0b failed to clean.
        copyFileSync(join(dataDir, "loam.db"), join(dataDir, "loam.db.premigration"));
        writeFileSync(join(dataDir, "loam.db"), Buffer.from("half-rekeyed corruption — opens under no key"));
        writeFileSync(
          join(dataDir, "loam.db-journal"),
          Buffer.from("stale rollback journal left by the interrupted DELETE-mode rekey"),
        );

        // Capture rmSync paths so we can prove Step 0b EXPLICITLY removes the journal (not just that it
        // happens to be gone after a successful open, which SQLite would do regardless of the fix).
        rmSyncCapture.paths = [];
        try {
          await expectCleanMigration(dataDir, "SURVIVES_FOREIGN_JOURNAL");
          expect(rmSyncCapture.paths.some((p) => p.endsWith("loam.db-journal"))).toBe(true);
        } finally {
          rmSyncCapture.paths = undefined;
        }
        // The foreign rollback journal must be gone — a restored self-consistent file paired with a hot
        // journal violates the crash-atomic single-self-consistent-file invariant.
        expect(existsSync(join(dataDir, "loam.db-journal"))).toBe(false);
      });

      it("RF6-b: a stale `.premigration` left by a SUCCESSFUL-but-uncleaned migration is DISCARDED (not restored), preserving the serving session's data", async () => {
        // 1. A legacy DB with a pre-migration row; snapshot the intact legacy single file — this is what a
        // stale, never-cleaned `.premigration` holds (it predates the migration, so ONLY the pre row).
        const dataDir = await makeLegacyDb("PRE_MIGRATION_ROW");
        const staleSnapshot = join(dataDir, "stale-legacy-snapshot.db");
        copyFileSync(join(dataDir, "loam.db"), staleSnapshot);

        // 2. Migrate cleanly to the current key, then write a NEW row during that serving session — the
        // data a full session accrues AFTER a migration that already succeeded.
        const migrated = installFakeMigratedHook();
        const migratedApp = await buildApp({
          dataDir,
          logger: false,
          dbEncryptionKey: currentKey,
          dbEncryptionMigrateFromKey: legacyKey,
          dbEncryptionMode: "passphrase",
        });
        expect(migrated.calls).toBe(1);
        const admin = await session(migratedApp);
        expect((await post(migratedApp, admin.cookie, "POST_MIGRATION_SESSION_ROW")).statusCode).toBe(201);
        await migratedApp.close();
        // The clean migration removed its own backup.
        expect(readdirSync(dataDir).some((name) => name.includes(".premigration"))).toBe(false);

        // 3. Simulate the post-success `rmSync(committedBackup)` cleanup having THROWN (read-only dir /
        // locked file): the stale legacy snapshot survives as `loam.db.premigration` into the next boot.
        copyFileSync(staleSnapshot, join(dataDir, "loam.db.premigration"));
        rmSync(staleSnapshot, { force: true });

        // 4. Boot again under the current key. Step 0b PROBES the live DB (it opens under the current key →
        // the migration already succeeded) and DISCARDS the stale backup rather than restoring it. A blind
        // restore would revert to the pre-migration snapshot and LOSE the session row.
        const reopened = await buildApp({
          dataDir,
          logger: false,
          dbEncryptionKey: currentKey,
          dbEncryptionMigrateFromKey: legacyKey,
          dbEncryptionMode: "passphrase",
        });
        const bodies = reopened.store.loadMessages().flatMap((m) => ("body" in m ? [m.body] : []));
        expect(bodies).toContain("PRE_MIGRATION_ROW");
        // Preserved — proof the stale backup was discarded, not restored over the live DB.
        expect(bodies).toContain("POST_MIGRATION_SESSION_ROW");
        expect(readdirSync(dataDir).some((name) => name.includes(".premigration"))).toBe(false);
        await reopened.close();
      });
    });

    it("a fresh install (no prior DB) opens cleanly under the current key without ever needing the offered legacy one, and still reports migrated so the launcher stops offering it", async () => {
      const migrated = installFakeMigratedHook();
      const dataDir = mkdtempSync(join(tmpdir(), "loam-migrate-fresh-test-"));
      cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));

      const app = await buildApp({
        dataDir,
        logger: false,
        dbEncryptionKey: "current SHA256(passphrase + deviceSecret) key",
        dbEncryptionMigrateFromKey: "a legacy key that will never actually be needed",
        dbEncryptionMode: "passphrase",
      });
      cleanups.push(() => app.close());

      expect(migrated.calls).toBe(1);
      const admin = await session(app);
      expect((await post(app, admin.cookie, "fresh install")).statusCode).toBe(201);
    });

    it("falls through to the existing db_encryption_unreadable recovery path when NEITHER the current nor the offered legacy key opens the database", async () => {
      const reports = installFakeBootBridge();
      const { app: original, dataDir } = await makeEncryptedApp({ dbEncryptionKey: "the real key" });
      await session(original);
      await original.close();

      await expect(
        buildApp({
          dataDir,
          logger: false,
          dbEncryptionKey: "a totally wrong current key",
          dbEncryptionMigrateFromKey: "a totally wrong legacy key too",
        }),
      ).rejects.toThrow(/could not be opened/);

      expect(reports).toEqual([expect.objectContaining({ code: "db_encryption_unreadable" })]);
    });
  });

  describe("resilient encrypted-DB open (F4, docs/15)", () => {
    it("falls back to serving an existing PLAINTEXT database when the configured key can't open it, and reports db_encryption_open_failed", async () => {
      const reports = installFakeBootBridge();

      // A plaintext DB already on disk (no encryption ever configured) — simulates a node switched
      // into an encrypted mode without a rekey of the existing data.
      const dataDir = mkdtempSync(join(tmpdir(), "loam-enc-fallback-test-"));
      cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
      const plain = await buildApp({ dataDir, logger: false });
      const plainAdmin = await session(plain);
      expect((await post(plain, plainAdmin.cookie, "PLAINTEXT_ALREADY_ON_DISK")).statusCode).toBe(201);
      await plain.close();

      // Reopen the SAME data dir with an encryption key configured — case 1 (keyed open) fails against
      // the real plaintext file; case 2 (plaintext open) must succeed, and boot must not crash-loop.
      const reopened = await buildApp({ dataDir, logger: false, dbEncryptionKey: "a newly configured key" });
      cleanups.push(() => reopened.close());

      expect(reports).toEqual([
        expect.objectContaining({ code: "db_encryption_open_failed" }),
      ]);
      // The key itself must never appear in the reported message.
      expect(reports[0]?.message).not.toContain("a newly configured key");

      // Data survived (it opened the SAME plaintext file, not a fresh one).
      expect(reopened.store.loadMessages().some((m) => "body" in m && m.body === "PLAINTEXT_ALREADY_ON_DISK")).toBe(
        true,
      );

      // The effective posture on the wire is "off" — F5 — even though a key was configured.
      const config = (await reopened.server.inject({ method: "GET", url: "/api/config" })).json() as {
        networkConfig: { dbEncryption: string };
      };
      expect(config.networkConfig.dbEncryption).toBe("off");

      // The node still boots fully usable.
      const reopenedAdmin = await session(reopened);
      expect((await post(reopened, reopenedAdmin.cookie, "after fallback")).statusCode).toBe(201);
    });

    /** Path to the shared launcher "start fresh" confirmation marker (SF2, docs/15) inside `dataDir`. */
    function startFreshMarkerPath(dataDir: string): string {
      return join(dataDir, ".loam-db-start-fresh");
    }

    /** Every `loam.db*` file in `dataDir`, for asserting nothing (or something specific) was touched. */
    function dbFileNames(dataDir: string): string[] {
      return readdirSync(dataDir).filter((name) => name.startsWith("loam.db"));
    }

    it("P1-2/design#1: a genuinely unopenable DB with NO start-fresh marker present THROWS non-destructively — the original files are untouched, not silently opened as plaintext or auto-replaced", async () => {
      const reports = installFakeBootBridge();

      const { app: original, dataDir } = await makeEncryptedApp({ dbEncryptionKey: "the original key" });
      const originalAdmin = await session(original);
      expect((await post(original, originalAdmin.cookie, "LOCKED_BEHIND_KEY_A")).statusCode).toBe(201);
      await original.close();

      const filesBefore = dbFileNames(dataDir).sort();
      const bytesBefore = readFileSync(join(dataDir, "loam.db"));

      // Reopen with a DIFFERENT key — case 1 (keyed open under the new key) fails, and case 2 (plaintext
      // open) also fails because the file is genuinely SQLCipher ciphertext, not a valid plain SQLite
      // header. Design#1: with no marker present, this must THROW rather than auto-replace the DB.
      await expect(
        buildApp({ dataDir, logger: false, dbEncryptionKey: "a completely different key" }),
      ).rejects.toThrow(/could not be opened/);

      expect(reports).toEqual([expect.objectContaining({ code: "db_encryption_unreadable" })]);
      expect(reports[0]?.message).not.toContain("the original key");
      expect(reports[0]?.message).not.toContain("a completely different key");

      // Nothing on disk was touched — no rename, no new/renamed files, identical bytes.
      expect(dbFileNames(dataDir).sort()).toEqual(filesBefore);
      expect(readFileSync(join(dataDir, "loam.db")).equals(bytesBefore)).toBe(true);
    });

    it("P1-2: a ciphertext DB with NO key configured at all ALSO gets non-destructive recovery treatment, instead of buildApp's raw 'not a database' throw", async () => {
      const reports = installFakeBootBridge();

      const { app: original, dataDir } = await makeEncryptedApp({ dbEncryptionKey: "some key" });
      await session(original);
      await original.close();

      const filesBefore = dbFileNames(dataDir).sort();

      // No dbEncryptionKey/ephemeralDbKey at all this time — encryptionEnabled starts false, but the
      // file on disk is genuine SQLCipher ciphertext. Before the fix this bypassed recovery entirely
      // (encryptionEnabled gated it) and buildApp rejected with a raw "file is not a database" error;
      // now it must reach the same marker-gated non-destructive path as the keyed case.
      await expect(buildApp({ dataDir, logger: false })).rejects.toThrow(/could not be opened/);

      expect(reports).toEqual([expect.objectContaining({ code: "db_encryption_unreadable" })]);
      expect(dbFileNames(dataDir).sort()).toEqual(filesBefore); // untouched
    });

    it("design#1: an explicit .loam-db-start-fresh marker consumes itself and triggers a unique-suffix recovery, reporting db_encryption_recovered_fresh", async () => {
      const reports = installFakeBootBridge();

      const { app: original, dataDir } = await makeEncryptedApp({ dbEncryptionKey: "the original key" });
      const originalAdmin = await session(original);
      expect((await post(original, originalAdmin.cookie, "LOCKED_BEHIND_KEY_A")).statusCode).toBe(201);
      await original.close();

      // The RN host's explicit start-fresh confirmation UI writes this marker before restarting.
      writeFileSync(startFreshMarkerPath(dataDir), "");

      const recovered = await buildApp({ dataDir, logger: false, dbEncryptionKey: "a completely different key" });
      cleanups.push(() => recovered.close());

      expect(reports).toEqual([expect.objectContaining({ code: "db_encryption_recovered_fresh" })]);
      expect(reports[0]?.message).not.toContain("the original key");
      expect(reports[0]?.message).not.toContain("a completely different key");

      // The marker is consumed (deleted), never re-triggering recovery on a later boot.
      expect(existsSync(startFreshMarkerPath(dataDir))).toBe(false);

      // The old ciphertext is preserved on disk under a unique suffix (not deleted, and not the old
      // fixed `loam.db.unreadable` name — P1-3).
      const preserved = readdirSync(dataDir).filter((name) => name.startsWith("loam.db.unreadable-"));
      expect(preserved.length).toBeGreaterThan(0);
      expect(existsSync(join(dataDir, "loam.db.unreadable"))).toBe(false);

      // The fresh DB has no memory of the old data, but is fully usable (and still encrypted — the
      // effective posture wasn't downgraded, unlike the plaintext-fallback case above).
      expect(recovered.store.loadMessages()).toEqual([]);
      const recoveredAdmin = await session(recovered);
      expect((await post(recovered, recoveredAdmin.cookie, "fresh after recovery")).statusCode).toBe(201);
    });

    it("RF4: a rename/open failure during marker-confirmed recovery is recast as a recoverable db_encryption_unreadable, not a generic throw that would kill the process", async () => {
      const reports = installFakeBootBridge();

      const { app: original, dataDir } = await makeEncryptedApp({ dbEncryptionKey: "key A" });
      const originalAdmin = await session(original);
      expect((await post(original, originalAdmin.cookie, "seed")).statusCode).toBe(201);
      await original.close();

      writeFileSync(startFreshMarkerPath(dataDir), "");

      // Force the marker-confirmed recovery's rename-aside step to throw AFTER the marker has already
      // been consumed by step 0 — the exact scenario RF4 fixes (a failure here used to propagate as a
      // generic, untyped error rather than the recoverable `db_encryption_unreadable` case). Single-shot:
      // it fires on the very next `renameSync` call (the recovery block's — nothing else in this boot
      // path calls it first) and immediately self-disarms.
      renameFailure.armed = true;

      await expect(buildApp({ dataDir, logger: false, dbEncryptionKey: "key B" })).rejects.toThrow(
        /Start-fresh recovery failed/,
      );

      // Recast as the SAME typed, recoverable error case 3 (no marker / genuinely unopenable) throws —
      // NOT a generic error, which `embedded-main.ts` would treat as unrecoverable and `process.exit(1)`
      // on instead of staying alive for a retry.
      expect(reports).toEqual([expect.objectContaining({ code: "db_encryption_unreadable" })]);

      // The marker was already consumed before the injected failure (step 0 runs first) — it must not
      // linger to silently re-authorize some LATER, unrelated failure the operator never confirmed.
      expect(existsSync(startFreshMarkerPath(dataDir))).toBe(false);

      // A fresh confirmation lets the operator retry immediately and actually succeed this time — the
      // fault injection was single-shot, so this second attempt hits the real (un-mocked) renameSync.
      writeFileSync(startFreshMarkerPath(dataDir), "");
      const recovered = await buildApp({ dataDir, logger: false, dbEncryptionKey: "key B" });
      cleanups.push(() => recovered.close());
      expect(recovered.store.loadMessages()).toEqual([]);
      const recoveredAdmin = await session(recovered);
      expect((await post(recovered, recoveredAdmin.cookie, "after RF4 retry")).statusCode).toBe(201);
    });

    it("P1-3: two successive marker-confirmed recoveries each keep their OWN preserved copy — the second never overwrites the first", async () => {
      installFakeBootBridge();

      const { app: original, dataDir } = await makeEncryptedApp({ dbEncryptionKey: "key A" });
      const originalAdmin = await session(original);
      expect((await post(original, originalAdmin.cookie, "seed")).statusCode).toBe(201);
      await original.close();

      // First recovery: wrong key + marker present.
      writeFileSync(startFreshMarkerPath(dataDir), "");
      const first = await buildApp({ dataDir, logger: false, dbEncryptionKey: "key B" });
      const admin1 = await session(first);
      expect((await post(first, admin1.cookie, "after first recovery")).statusCode).toBe(201);
      await first.close();

      const preservedAfterFirst = readdirSync(dataDir).filter((name) => name.startsWith("loam.db.unreadable-"));
      expect(preservedAfterFirst.length).toBeGreaterThan(0);

      // Second recovery: open under yet ANOTHER wrong key, with a fresh marker again.
      writeFileSync(startFreshMarkerPath(dataDir), "");
      const second = await buildApp({ dataDir, logger: false, dbEncryptionKey: "key C" });
      cleanups.push(() => second.close());

      const preservedAfterSecond = readdirSync(dataDir).filter((name) => name.startsWith("loam.db.unreadable-"));
      // Both the first recovery's preserved set AND the second's are present — nothing was overwritten.
      expect(preservedAfterSecond.length).toBeGreaterThan(preservedAfterFirst.length);
      for (const name of preservedAfterFirst) {
        expect(preservedAfterSecond).toContain(name);
      }
    });

    it("P2-3: a start-fresh marker present when the NORMAL open already succeeds is still consumed — it can never linger to authorize a LATER, unrelated failure", async () => {
      const reports = installFakeBootBridge();

      const { app: original, dataDir } = await makeEncryptedApp({ dbEncryptionKey: "the correct key" });
      const originalAdmin = await session(original);
      expect((await post(original, originalAdmin.cookie, "seed")).statusCode).toBe(201);
      await original.close();

      // The operator wrote the marker (e.g. anticipating a key problem) but then the RIGHT key ended up
      // being used after all — case 1 (keyed open) succeeds immediately, never reaching the recovery
      // branch at all.
      writeFileSync(startFreshMarkerPath(dataDir), "");

      const reopened = await buildApp({ dataDir, logger: false, dbEncryptionKey: "the correct key" });
      cleanups.push(() => reopened.close());

      // No boot-bridge report at all — this was a perfectly normal open, not a degrade or a recovery.
      expect(reports).toEqual([]);

      // Old data is untouched (normal open, not a destructive replace).
      expect(reopened.store.loadMessages().some((m) => "body" in m && m.body === "seed")).toBe(true);

      // The marker is GONE — consumed up front (P2-3), not left behind to silently authorize some LATER,
      // unrelated unopenable-DB failure the operator never actually confirmed for.
      expect(existsSync(startFreshMarkerPath(dataDir))).toBe(false);
    });

    it("P2-3: if the marker can't actually be deleted, boot fails CLOSED — it is NOT treated as a valid confirmation", async () => {
      const reports = installFakeBootBridge();

      const { app: original, dataDir } = await makeEncryptedApp({ dbEncryptionKey: "key A" });
      await session(original);
      await original.close();

      const filesBefore = dbFileNames(dataDir).sort();

      // Force the marker deletion itself to fail: create it as a NON-EMPTY directory instead of a file.
      // `rmSync(path, { force: true })` (no `recursive`) throws ENOTEMPTY/EISDIR for this, exactly the
      // "delete failed" case P2-3 must fail closed on — `force` only swallows ENOENT (already-absent),
      // never a genuine deletion failure.
      const markerPath = startFreshMarkerPath(dataDir);
      mkdirSync(markerPath);
      writeFileSync(join(markerPath, "not-empty"), "");

      // Wrong key too — case 1 and case 2 both fail, so this reaches the marker-gated recovery check.
      await expect(buildApp({ dataDir, logger: false, dbEncryptionKey: "a completely different key" })).rejects.toThrow(
        /could not be opened/,
      );

      expect(reports).toEqual([expect.objectContaining({ code: "db_encryption_unreadable" })]);

      // Fail closed: no destructive replace happened — the original files are untouched...
      expect(dbFileNames(dataDir).sort()).toEqual(filesBefore);
      // ...and the marker (still an undeleted directory) is exactly where it was — NOT silently
      // "consumed" despite authorizing nothing.
      expect(existsSync(markerPath)).toBe(true);
    });
  });
});

describe("channels API", () => {
  type ChannelBody = {
    id: string;
    name: string;
    description?: string;
    ownerUserId?: string;
    visibility: string;
    allowPosting: string;
    allowReplies: boolean;
    discoverable: boolean;
    archived?: boolean;
  };

  async function listChannels(app: LoamApp, cookie: string): Promise<ChannelBody[]> {
    const response = await app.server.inject({
      method: "GET",
      url: "/api/channels",
      headers: { cookie },
    });
    return response.json() as ChannelBody[];
  }

  function createChannel(app: LoamApp, cookie: string, payload: unknown): Promise<InjectResponse> {
    return app.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie },
      payload,
    });
  }

  function updateChannel(
    app: LoamApp,
    cookie: string,
    channelId: string,
    payload: unknown,
  ): Promise<InjectResponse> {
    return app.server.inject({
      method: "PATCH",
      url: `/api/channels/${channelId}`,
      headers: { cookie },
      payload,
    });
  }

  it("restricts the full (archived-inclusive) channel list to admins", async () => {
    const app = await makeApp({ admin: { bootstrap: "none" } });
    const session = await newSession(app);
    expect(session.isAdmin).toBe(false);

    const list = await app.server.inject({
      method: "GET",
      url: "/api/admin/channels",
      headers: { cookie: session.cookie },
    });
    expect(list.statusCode).toBe(403);
  });

  it("lets a user create a channel when enableUserChannels is on, and blocks it when off", async () => {
    // Default config has enableUserChannels: true.
    const open = await makeApp();
    await newSession(open); // burn the firstUser=admin slot
    const user = await newSession(open);
    expect(user.isAdmin).toBe(false);

    const created = await createChannel(open, user.cookie, { name: "User Room" });
    expect(created.statusCode).toBe(201);
    expect((created.json() as ChannelBody).ownerUserId).toBe(user.userId);

    const locked = await makeApp({ features: { enableUserChannels: false } });
    const admin = await newSession(locked);
    const lockedUser = await newSession(locked);
    expect((await createChannel(locked, lockedUser.cookie, { name: "Nope" })).statusCode).toBe(403);
    // An admin can still create even when user channels are disabled.
    expect((await createChannel(locked, admin.cookie, { name: "Admin Room" })).statusCode).toBe(201);
  });

  it("lets the channel owner update it but blocks a non-owner non-admin", async () => {
    const app = await makeApp();
    await newSession(app); // burn the admin slot
    const owner = await newSession(app);
    const stranger = await newSession(app);
    const channel = (await createChannel(app, owner.cookie, { name: "Owned" })).json() as ChannelBody;
    expect(channel.ownerUserId).toBe(owner.userId);

    const renamed = await updateChannel(app, owner.cookie, channel.id, { name: "Owned Plus" });
    expect(renamed.statusCode).toBe(200);
    expect((renamed.json() as ChannelBody).name).toBe("Owned Plus");

    expect((await updateChannel(app, stranger.cookie, channel.id, { name: "Hijack" })).statusCode).toBe(403);
  });

  it("lists archived channels for admins even though the public list hides them", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const created = (await createChannel(app, admin.cookie, { name: "Hidden" })).json() as ChannelBody;
    await updateChannel(app, admin.cookie, created.id, { archived: true });

    // Public list omits it, admin list keeps it (so it can be restored).
    expect((await listChannels(app, admin.cookie)).some((entry) => entry.id === created.id)).toBe(false);

    const adminList = await app.server.inject({
      method: "GET",
      url: "/api/admin/channels",
      headers: { cookie: admin.cookie },
    });
    expect(adminList.statusCode).toBe(200);
    const entries = adminList.json() as ChannelBody[];
    const hidden = entries.find((entry) => entry.id === created.id);
    expect(hidden?.archived).toBe(true);
  });

  it("creates a public channel, owns it, and lists it", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    expect(admin.isAdmin).toBe(true);

    const create = await createChannel(app, admin.cookie, {
      name: "Logistics Team",
      description: "Supply coordination",
      allowPosting: "admins",
      allowReplies: false,
    });
    expect(create.statusCode).toBe(201);

    const channel = create.json() as ChannelBody;
    expect(channel.id).toBe("logistics-team");
    expect(channel.name).toBe("Logistics Team");
    expect(channel.visibility).toBe("public");
    expect(channel.discoverable).toBe(true);
    expect(channel.allowPosting).toBe("admins");
    expect(channel.allowReplies).toBe(false);
    expect(channel.ownerUserId).toBe(admin.userId);

    const channels = await listChannels(app, admin.cookie);
    expect(channels.some((entry) => entry.id === "logistics-team")).toBe(true);
  });

  it("rejects an empty channel name", async () => {
    const app = await makeApp();
    const admin = await newSession(app);

    const create = await createChannel(app, admin.cookie, { name: "   " });
    expect(create.statusCode).toBe(400);
  });

  it("gives duplicate names distinct, non-colliding ids", async () => {
    const app = await makeApp();
    const admin = await newSession(app);

    const first = (await createChannel(app, admin.cookie, { name: "Alerts" })).json() as ChannelBody;
    const second = (await createChannel(app, admin.cookie, { name: "Alerts" })).json() as ChannelBody;

    expect(first.id).toBe("alerts");
    expect(second.id).not.toBe(first.id);
    expect(second.id.startsWith("alerts-")).toBe(true);
  });

  it("falls back to a generated id when the name has no slug characters", async () => {
    const app = await makeApp();
    const admin = await newSession(app);

    const channel = (await createChannel(app, admin.cookie, { name: "🔥🔥" })).json() as ChannelBody;
    expect(channel.id.startsWith("channel-")).toBe(true);
    expect(channel.name).toBe("🔥🔥");
  });

  it("renames a channel and archives it out of the public list, then restores it", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const created = (await createChannel(app, admin.cookie, { name: "Temp" })).json() as ChannelBody;

    const renamed = await updateChannel(app, admin.cookie, created.id, { name: "Renamed" });
    expect(renamed.statusCode).toBe(200);
    expect((renamed.json() as ChannelBody).name).toBe("Renamed");

    const archived = await updateChannel(app, admin.cookie, created.id, { archived: true });
    expect(archived.statusCode).toBe(200);
    expect((await listChannels(app, admin.cookie)).some((entry) => entry.id === created.id)).toBe(false);

    const restored = await updateChannel(app, admin.cookie, created.id, { archived: false });
    expect(restored.statusCode).toBe(200);
    expect((await listChannels(app, admin.cookie)).some((entry) => entry.id === created.id)).toBe(true);
  });

  it("returns 404 when updating a channel that does not exist", async () => {
    const app = await makeApp();
    const admin = await newSession(app);

    const update = await updateChannel(app, admin.cookie, "does-not-exist", { name: "Nope" });
    expect(update.statusCode).toBe(404);
  });

  it("persists created channels across a restart", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "loam-app-test-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    // reopenApp closes this instance itself and registers the reopened one for teardown. The
    // try/finally closes the initial instance only if an assertion throws before reopen — so it
    // never leaks a handle, and is never double-closed on the happy path.
    let app: LoamApp = await buildApp({ dataDir, logger: false });
    let reopened = false;

    try {
      const admin = await newSession(app);
      // A multi-word name yields a hyphenated slug id; confirm that survives reload + ChannelSchema.parse.
      const created = (await createChannel(app, admin.cookie, { name: "Durable Channel" })).json() as ChannelBody;
      expect(created.id).toBe("durable-channel");

      app = await reopenApp(app, dataDir);
      reopened = true;
      expect(app.store.loadChannels().some((entry) => entry.id === created.id)).toBe(true);
    } finally {
      if (!reopened) {
        await app.close();
      }
    }
  });
});

describe("message deletion API", () => {
  function postMessage(app: LoamApp, cookie: string, payload: unknown): Promise<InjectResponse> {
    return app.server.inject({ method: "POST", url: "/api/messages", headers: { cookie }, payload });
  }

  function deleteMessage(app: LoamApp, cookie: string, id: string): Promise<InjectResponse> {
    return app.server.inject({ method: "DELETE", url: `/api/messages/${id}`, headers: { cookie } });
  }

  async function postId(app: LoamApp, cookie: string, payload: unknown): Promise<string> {
    const response = await postMessage(app, cookie, payload);
    expect(response.statusCode).toBe(201);
    return (response.json() as { message: { id: string } }).message.id;
  }

  const remainingIds = (app: LoamApp): string[] => app.store.loadMessages().map((message) => message.id);

  it("lets an author delete their own message", async () => {
    const app = await makeApp();
    await newSession(app); // burn the firstUser=admin slot so the author below is a plain user
    const author = await newSession(app);
    expect(author.isAdmin).toBe(false);
    const id = await postId(app, author.cookie, { type: "channelPost", channelId: "general", body: "hi" });

    expect((await deleteMessage(app, author.cookie, id)).statusCode).toBe(200);
    expect(remainingIds(app)).not.toContain(id);
  });

  it("stops a non-author non-admin from deleting someone else's message", async () => {
    const app = await makeApp();
    await newSession(app);
    const author = await newSession(app);
    const other = await newSession(app);
    const id = await postId(app, author.cookie, { type: "channelPost", channelId: "general", body: "hi" });

    const response = await deleteMessage(app, other.cookie, id);
    expect(response.statusCode).toBe(403);
    expect(remainingIds(app)).toContain(id);
  });

  it("lets an admin delete anyone's message (moderation)", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    expect(admin.isAdmin).toBe(true);
    const author = await newSession(app);
    const id = await postId(app, author.cookie, { type: "channelPost", channelId: "general", body: "hi" });

    expect((await deleteMessage(app, admin.cookie, id)).statusCode).toBe(200);
    expect(remainingIds(app)).not.toContain(id);
  });

  it("returns 404 for a message that does not exist", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    expect((await deleteMessage(app, admin.cookie, "msg_missing")).statusCode).toBe(404);
  });

  it("cascades: deleting a thread root removes its replies and reactions", async () => {
    const app = await makeApp();
    await newSession(app);
    const author = await newSession(app);
    const rootId = await postId(app, author.cookie, { type: "channelPost", channelId: "general", body: "root" });
    const replyId = await postId(app, author.cookie, {
      type: "channelReply",
      channelId: "general",
      parentMessageId: rootId,
      body: "reply",
    });
    expect((await postMessage(app, author.cookie, { type: "reaction", targetMessageId: rootId, reaction: "👍" })).statusCode).toBe(201);

    const response = await deleteMessage(app, author.cookie, rootId);
    expect(response.statusCode).toBe(200);
    const deletedIds = (response.json() as { deletedIds: string[] }).deletedIds;
    expect(deletedIds).toContain(rootId);
    expect(deletedIds).toContain(replyId);

    const remaining = app.store.loadMessages();
    expect(remaining.map((message) => message.id)).not.toContain(rootId);
    expect(remaining.map((message) => message.id)).not.toContain(replyId);
    expect(remaining.some((message) => message.type === "reaction")).toBe(false);
  });

  it("won't let a non-admin delete a thread others have replied to, but an admin can", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const author = await newSession(app);
    const other = await newSession(app);
    const rootId = await postId(app, author.cookie, { type: "channelPost", channelId: "general", body: "root" });
    await postId(app, other.cookie, {
      type: "channelReply",
      channelId: "general",
      parentMessageId: rootId,
      body: "someone else's reply",
    });

    // The author can't delete the root because the cascade would remove another user's reply.
    expect((await deleteMessage(app, author.cookie, rootId)).statusCode).toBe(403);
    // An admin can moderate it.
    expect((await deleteMessage(app, admin.cookie, rootId)).statusCode).toBe(200);
    expect(app.store.loadMessages()).toEqual([]);
  });
});

describe("message editing API", () => {
  function postMessage(app: LoamApp, cookie: string, payload: unknown): Promise<InjectResponse> {
    return app.server.inject({ method: "POST", url: "/api/messages", headers: { cookie }, payload });
  }

  function editMessage(app: LoamApp, cookie: string, id: string, payload: unknown): Promise<InjectResponse> {
    return app.server.inject({ method: "PATCH", url: `/api/messages/${id}`, headers: { cookie }, payload });
  }

  async function postId(app: LoamApp, cookie: string, payload: unknown): Promise<string> {
    const response = await postMessage(app, cookie, payload);
    expect(response.statusCode).toBe(201);
    return (response.json() as { message: { id: string } }).message.id;
  }

  it("lets an author edit their own message and stamps editedAt", async () => {
    const app = await makeApp();
    await newSession(app);
    const author = await newSession(app);
    const id = await postId(app, author.cookie, { type: "channelPost", channelId: "general", body: "typo herre" });

    const response = await editMessage(app, author.cookie, id, { body: "typo here" });
    expect(response.statusCode).toBe(200);
    const edited = response.json() as { body: string; editedAt?: number };
    expect(edited.body).toBe("typo here");
    expect(typeof edited.editedAt).toBe("number");

    const stored = app.store.loadMessages().find((message) => message.id === id);
    expect(stored && "body" in stored ? stored.body : undefined).toBe("typo here");
  });

  it("won't let another user (even an admin) edit someone else's message", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const author = await newSession(app);
    const id = await postId(app, author.cookie, { type: "channelPost", channelId: "general", body: "mine" });

    // Editing someone else's words is impersonation — admins moderate by deleting, not editing.
    expect((await editMessage(app, admin.cookie, id, { body: "tampered" })).statusCode).toBe(403);
    const stored = app.store.loadMessages().find((message) => message.id === id);
    expect(stored && "body" in stored ? stored.body : undefined).toBe("mine");
  });

  it("rejects an empty edited body and a missing message", async () => {
    const app = await makeApp();
    await newSession(app);
    const author = await newSession(app);
    const id = await postId(app, author.cookie, { type: "channelPost", channelId: "general", body: "keep" });

    expect((await editMessage(app, author.cookie, id, { body: "   " })).statusCode).toBe(400);
    expect((await editMessage(app, author.cookie, "msg_missing", { body: "hi" })).statusCode).toBe(404);
  });
});

describe("roles, moderation, and join policy", () => {
  function postChannel(app: LoamApp, cookie: string, body: string): Promise<InjectResponse> {
    return app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie },
      payload: { type: "channelPost", channelId: "general", body },
    });
  }

  function setRoles(app: LoamApp, cookie: string, userId: string, roles: string[]): Promise<InjectResponse> {
    return app.server.inject({
      method: "PATCH",
      url: `/api/admin/users/${userId}/roles`,
      headers: { cookie },
      payload: { roles },
    });
  }

  function moderate(
    app: LoamApp,
    cookie: string,
    userId: string,
    payload: Record<string, unknown>,
  ): Promise<InjectResponse> {
    return app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${userId}`,
      headers: { cookie },
      payload,
    });
  }

  function approve(app: LoamApp, cookie: string, userId: string): Promise<InjectResponse> {
    return app.server.inject({
      method: "POST",
      url: `/api/access/users/${userId}/approve`,
      headers: { cookie },
    });
  }

  function deny(app: LoamApp, cookie: string, userId: string): Promise<InjectResponse> {
    return app.server.inject({
      method: "POST",
      url: `/api/access/users/${userId}/deny`,
      headers: { cookie },
    });
  }

  /** Open a fresh session and return the cookie together with the full currentUser (incl. pending). */
  async function fullSession(
    app: LoamApp,
  ): Promise<{ cookie: string; user: { id: string; isAdmin: boolean; pending?: boolean } }> {
    const response = await app.server.inject({ method: "GET", url: "/api/config" });
    return {
      cookie: sessionCookie(response),
      user: (
        response.json() as { currentUser: { id: string; isAdmin: boolean; pending?: boolean } }
      ).currentUser,
    };
  }

  describe("roles", () => {
    it("lets an admin set a member's roles", async () => {
      const app = await makeApp();
      const admin = await newSession(app);
      const member = await newSession(app);

      const granted = await setRoles(app, admin.cookie, member.userId, ["moderator", "greeter"]);
      expect(granted.statusCode).toBe(200);
      expect((granted.json() as { roles: string[] }).roles).toEqual(["moderator", "greeter"]);
    });

    it("does not leak a member's roles to ordinary joiners, but shows them to self and moderators", async () => {
      const app = await makeApp();
      const admin = await newSession(app);
      const mod = await newSession(app);
      const stranger = await newSession(app);

      expect((await setRoles(app, admin.cookie, mod.userId, ["moderator"])).statusCode).toBe(200);

      const rosterFor = async (cookie: string) =>
        (await app.server.inject({ method: "GET", url: "/api/users", headers: { cookie } })).json() as {
          id: string;
          roles?: string[];
        }[];

      // A stranger still sees the moderator in the roster, but their roles are stripped (can't
      // enumerate who holds authority).
      const strangerRoster = await rosterFor(stranger.cookie);
      expect(strangerRoster.find((entry) => entry.id === mod.userId)).toBeDefined();
      expect(strangerRoster.find((entry) => entry.id === mod.userId)?.roles).toBeUndefined();

      // A moderator sees roles across the whole roster...
      const modRoster = await rosterFor(mod.cookie);
      expect(modRoster.find((entry) => entry.id === mod.userId)?.roles).toEqual(["moderator"]);

      // ...and sees their OWN roles via /api/config, so the client can gate its moderation UI.
      const modConfig = (
        await app.server.inject({ method: "GET", url: "/api/config", headers: { cookie: mod.cookie } })
      ).json() as { currentUser: { roles?: string[] } };
      expect(modConfig.currentUser.roles).toEqual(["moderator"]);
    });

    it("does not leak roles/shadowBan via the private-channel member list to a non-moderator member", async () => {
      const app = await makeApp();
      const admin = await newSession(app);
      const alice = await newSession(app);
      const mod = await newSession(app);

      const channelId = (
        (
          await app.server.inject({
            method: "POST",
            url: "/api/channels",
            headers: { cookie: admin.cookie },
            payload: { name: "ops", visibility: "private" },
          })
        ).json() as { id: string }
      ).id;
      for (const member of [alice, mod]) {
        expect(
          (
            await app.server.inject({
              method: "POST",
              url: `/api/channels/${channelId}/members`,
              headers: { cookie: admin.cookie },
              payload: { userId: member.userId },
            })
          ).statusCode,
        ).toBe(200);
      }
      expect((await setRoles(app, admin.cookie, mod.userId, ["moderator"])).statusCode).toBe(200);
      expect((await moderate(app, admin.cookie, mod.userId, { shadowBanned: true })).statusCode).toBe(200);

      const membersFor = async (cookie: string) =>
        (await app.server.inject({ method: "GET", url: `/api/channels/${channelId}/members`, headers: { cookie } }))
          .json() as { id: string; roles?: string[]; shadowBanned?: boolean }[];

      // Alice is an ordinary member — she must not learn the moderator's roles or shadow-ban state.
      const asAlice = (await membersFor(alice.cookie)).find((entry) => entry.id === mod.userId);
      expect(asAlice).toBeDefined();
      expect(asAlice?.roles).toBeUndefined();
      expect(asAlice?.shadowBanned).toBeUndefined();

      // The admin (a moderator) still sees roles (but never shadowBanned, which is moderation-endpoint only).
      const asAdmin = (await membersFor(admin.cookie)).find((entry) => entry.id === mod.userId);
      expect(asAdmin?.roles).toEqual(["moderator"]);
      expect(asAdmin?.shadowBanned).toBeUndefined();
    });

    it("rejects role changes from a non-admin", async () => {
      const app = await makeApp();
      const admin = await newSession(app);
      const member = await newSession(app);
      const other = await newSession(app);

      expect((await setRoles(app, other.cookie, member.userId, ["moderator"])).statusCode).toBe(403);
      // Sanity: the admin can, so it is genuinely a permission gate.
      expect((await setRoles(app, admin.cookie, member.userId, ["moderator"])).statusCode).toBe(200);
    });

    it("refuses to change an admin's roles and 404s an unknown user", async () => {
      const app = await makeApp();
      const admin = await newSession(app);

      expect((await setRoles(app, admin.cookie, admin.userId, ["moderator"])).statusCode).toBe(400);
      expect((await setRoles(app, admin.cookie, "user.does-not-exist", ["moderator"])).statusCode).toBe(404);
    });

    it("rejects an invalid roles body", async () => {
      const app = await makeApp();
      const admin = await newSession(app);
      const member = await newSession(app);

      const bad = await app.server.inject({
        method: "PATCH",
        url: `/api/admin/users/${member.userId}/roles`,
        headers: { cookie: admin.cookie },
        payload: { roles: ["overlord"] },
      });
      expect(bad.statusCode).toBe(400);
    });
  });

  describe("moderation", () => {
    it("lets a moderator ban a member: enforcement holds and sessions are invalidated", async () => {
      const app = await makeApp();
      const admin = await newSession(app);
      const mod = await newSession(app);
      const member = await newSession(app);

      // Grant a genuine (non-admin) moderator role so we exercise canModerate via role, not isAdmin.
      expect((await setRoles(app, admin.cookie, mod.userId, ["moderator"])).statusCode).toBe(200);

      // The member can post before the ban.
      expect((await postChannel(app, member.cookie, "before the ban")).statusCode).toBe(201);

      const ban = await moderate(app, mod.cookie, member.userId, { banned: true });
      expect(ban.statusCode).toBe(200);
      expect((ban.json() as { banned: boolean }).banned).toBe(true);

      // Their next post is forbidden, and their session is gone from the store.
      const after = await postChannel(app, member.cookie, "after the ban");
      expect(after.statusCode).toBe(403);
      expect(app.store.loadSessions().some((session) => session.userId === member.userId)).toBe(false);

      // A banned user is no longer a visible participant.
      const roster = (
        await app.server.inject({ method: "GET", url: "/api/users", headers: { cookie: admin.cookie } })
      ).json() as { id: string }[];
      expect(roster.some((user) => user.id === member.userId)).toBe(false);
    });

    it("refuses to ban an admin or oneself", async () => {
      const app = await makeApp();
      const admin = await newSession(app);
      const mod = await newSession(app);
      await setRoles(app, admin.cookie, mod.userId, ["moderator"]);

      expect((await moderate(app, mod.cookie, admin.userId, { banned: true })).statusCode).toBe(403);
      expect((await moderate(app, mod.cookie, mod.userId, { banned: true })).statusCode).toBe(403);
      expect((await moderate(app, admin.cookie, admin.userId, { banned: true })).statusCode).toBe(403);
    });

    it("requires moderator (or admin) rights and a non-empty body", async () => {
      const app = await makeApp();
      const admin = await newSession(app);
      const member = await newSession(app);

      expect((await moderate(app, member.cookie, admin.userId, { banned: true })).statusCode).toBe(403);
      // Empty moderation body (neither banned nor shadowBanned) is a bad request.
      expect((await moderate(app, admin.cookie, member.userId, {})).statusCode).toBe(400);
      expect((await moderate(app, admin.cookie, "user.nope", { banned: true })).statusCode).toBe(404);
    });

    it("shadow-ban lets the author keep posting while withholding the message from others", async () => {
      const app = await makeApp();
      const admin = await newSession(app);
      const member = await newSession(app);

      const shadow = await moderate(app, admin.cookie, member.userId, { shadowBanned: true });
      expect(shadow.statusCode).toBe(200);
      expect((shadow.json() as { shadowBanned: boolean }).shadowBanned).toBe(true);

      // The author is allowed through: the message is created and persisted (returned to them).
      const post = await postChannel(app, member.cookie, "am I shouting into the void?");
      expect(post.statusCode).toBe(201);
      const messageId = (post.json() as { message: { id: string } }).message.id;
      expect(app.store.loadMessages().some((message) => message.id === messageId)).toBe(true);

      // A shadow-banned user stays a visible participant — only their messages are withheld. But the
      // `shadowBanned` flag is stripped from the general roster (even for an admin — they read it via
      // the gated moderation endpoint), so no one can enumerate who is shadow-banned.
      const roster = (
        await app.server.inject({ method: "GET", url: "/api/users", headers: { cookie: admin.cookie } })
      ).json() as { id: string; shadowBanned?: boolean }[];
      const listed = roster.find((user) => user.id === member.userId);
      expect(listed).toBeDefined();
      expect(listed?.shadowBanned).toBeUndefined();

      // The target must NOT learn their own shadow-ban (that would defeat the "shadow") — their own
      // /api/config currentUser carries no flag.
      const selfConfig = (
        await app.server.inject({ method: "GET", url: "/api/config", headers: { cookie: member.cookie } })
      ).json() as { currentUser: { shadowBanned?: boolean } };
      expect(selfConfig.currentUser.shadowBanned).toBeUndefined();

      // Moderators still see it via the gated endpoint.
      const modRoster = (
        await app.server.inject({ method: "GET", url: "/api/moderation/users", headers: { cookie: admin.cookie } })
      ).json() as { id: string; shadowBanned?: boolean }[];
      expect(modRoster.find((user) => user.id === member.userId)?.shadowBanned).toBe(true);

      // Un-shadow-ban clears the flag.
      const restore = await moderate(app, admin.cookie, member.userId, { shadowBanned: false });
      expect((restore.json() as { shadowBanned?: boolean }).shadowBanned).toBe(false);
    });

    it("withholds a shadow-banned author's messages from REST reads, but not from the author", async () => {
      const app = await makeApp();
      const admin = await newSession(app);
      const spammer = await newSession(app);
      const viewer = await newSession(app);

      await moderate(app, admin.cookie, spammer.userId, { shadowBanned: true });
      expect((await postChannel(app, spammer.cookie, "buy my thing")).statusCode).toBe(201);

      const read = async (cookie: string): Promise<string[]> =>
        (
          (
            await app.server.inject({ method: "GET", url: "/api/messages/general", headers: { cookie } })
          ).json() as { body?: string }[]
        ).map((message) => message.body ?? "");

      // The author still sees their own post (shadow ban is invisible to them)...
      expect(await read(spammer.cookie)).toContain("buy my thing");
      // ...but nobody else does — not even an admin — via the REST path the client refetches on every
      // channel open and reconnect. Without the fix the WS-level concealment would be cosmetic.
      expect(await read(viewer.cookie)).not.toContain("buy my thing");
      expect(await read(admin.cookie)).not.toContain("buy my thing");
    });

    it("drops orphan reactions that target a shadow-banned author's now-hidden message", async () => {
      const app = await makeApp();
      const admin = await newSession(app);
      const spammer = await newSession(app);
      const viewer = await newSession(app);

      // Spammer posts and the viewer reacts — both visible while nobody is shadow-banned.
      const post = await postChannel(app, spammer.cookie, "root by spammer");
      const rootId = (post.json() as { message: { id: string } }).message.id;
      expect(
        (
          await app.server.inject({
            method: "POST",
            url: "/api/messages",
            headers: { cookie: viewer.cookie },
            payload: { type: "reaction", targetMessageId: rootId, reaction: "👍" },
          })
        ).statusCode,
      ).toBe(201);

      // Shadow-ban the spammer. The viewer's read must contain neither the hidden root nor their own
      // reaction to it — a surviving reaction would leak that the root exists.
      await moderate(app, admin.cookie, spammer.userId, { shadowBanned: true });
      const seen = (
        await app.server.inject({ method: "GET", url: "/api/messages/general", headers: { cookie: viewer.cookie } })
      ).json() as { id: string; type: string; targetMessageId?: string }[];
      expect(seen.some((message) => message.id === rootId)).toBe(false);
      expect(seen.some((message) => message.type === "reaction" && message.targetMessageId === rootId)).toBe(false);
    });

    it("exposes the full human roster (incl. banned) to moderators only", async () => {
      const app = await makeApp();
      const admin = await newSession(app);
      const member = await newSession(app);
      await moderate(app, admin.cookie, member.userId, { banned: true });

      const list = await app.server.inject({
        method: "GET",
        url: "/api/moderation/users",
        headers: { cookie: admin.cookie },
      });
      expect(list.statusCode).toBe(200);
      const users = list.json() as { id: string; banned?: boolean }[];
      expect(users.find((user) => user.id === member.userId)?.banned).toBe(true);

      // A plain member cannot read the moderation roster.
      const other = await newSession(app);
      expect(
        (
          await app.server.inject({
            method: "GET",
            url: "/api/moderation/users",
            headers: { cookie: other.cookie },
          })
        ).statusCode,
      ).toBe(403);
    });
  });

  describe("join policy (approval)", () => {
    it("marks fresh non-admin sessions pending and blocks their posts until approved", async () => {
      const app = await makeApp({ access: { joinPolicy: "approval" } });

      // firstUser bootstrap: the first session becomes admin and is never pending.
      const admin = await fullSession(app);
      expect(admin.user.isAdmin).toBe(true);
      expect(admin.user.pending).toBeUndefined();

      // The next session is a pending newcomer.
      const newcomer = await fullSession(app);
      expect(newcomer.user.isAdmin).toBe(false);
      expect(newcomer.user.pending).toBe(true);

      // A pending user cannot post.
      expect((await postChannel(app, newcomer.cookie, "hello?")).statusCode).toBe(403);

      // The greeter (admin) sees the newcomer in the pending queue; a pending user cannot.
      const pending = await app.server.inject({
        method: "GET",
        url: "/api/access/pending",
        headers: { cookie: admin.cookie },
      });
      expect(pending.statusCode).toBe(200);
      expect((pending.json() as { id: string }[]).some((user) => user.id === newcomer.user.id)).toBe(true);
      expect(
        (
          await app.server.inject({
            method: "GET",
            url: "/api/access/pending",
            headers: { cookie: newcomer.cookie },
          })
        ).statusCode,
      ).toBe(403);

      // Approving clears pending; now they can post.
      const approved = await approve(app, admin.cookie, newcomer.user.id);
      expect(approved.statusCode).toBe(200);
      expect((approved.json() as { pending?: boolean }).pending).toBe(false);
      expect((await postChannel(app, newcomer.cookie, "now I can talk")).statusCode).toBe(201);
    });

    it("leaves the open join policy ungated", async () => {
      const app = await makeApp(); // default access.joinPolicy = "open"
      await newSession(app); // burn the firstUser admin slot
      const newcomer = await fullSession(app);
      expect(newcomer.user.pending).toBeUndefined();
      expect((await postChannel(app, newcomer.cookie, "straight in")).statusCode).toBe(201);
    });

    it("lets a greeter (not just an admin) approve pending newcomers but not ban", async () => {
      const app = await makeApp({ access: { joinPolicy: "approval" } });
      const admin = await newSession(app);

      // Promote a user to greeter: approve them, then grant the role.
      const greeter = await newSession(app);
      await approve(app, admin.cookie, greeter.userId);
      await setRoles(app, admin.cookie, greeter.userId, ["greeter"]);

      const newcomer = await newSession(app);
      expect((await approve(app, greeter.cookie, newcomer.userId)).statusCode).toBe(200);

      // Greeting is not moderating: the greeter cannot ban.
      expect((await moderate(app, greeter.cookie, newcomer.userId, { banned: true })).statusCode).toBe(403);
    });

    it("lets a greeter deny (ban) a pending newcomer and tears their session down", async () => {
      const app = await makeApp({ access: { joinPolicy: "approval" } });
      const admin = await newSession(app);
      const newcomer = await fullSession(app);
      expect(newcomer.user.pending).toBe(true);

      const denied = await deny(app, admin.cookie, newcomer.user.id);
      expect(denied.statusCode).toBe(200);
      const record = denied.json() as { banned: boolean; pending?: boolean };
      expect(record.banned).toBe(true);
      expect(record.pending).toBe(false);
      expect(app.store.loadSessions().some((session) => session.userId === newcomer.user.id)).toBe(false);

      // Denying an admin/self is refused, and a plain member cannot deny at all.
      expect((await deny(app, admin.cookie, admin.userId)).statusCode).toBe(403);
      const member = await newSession(app);
      const another = await fullSession(app);
      expect((await deny(app, member.cookie, another.user.id)).statusCode).toBe(403);

      // Deny is onboarding-only: once a newcomer is approved they are no longer pending, so denying
      // them is refused (banning an established member is a moderator action, not a greeter one).
      await approve(app, admin.cookie, another.user.id);
      expect((await deny(app, admin.cookie, another.user.id)).statusCode).toBe(400);
    });

    it("surfaces the join policy and security profile on the public bootstrap", async () => {
      // `hardened` forces `required` transport, so `/api/config` is tunnel-only content now (docs/20).
      // The same networkConfig is exposed cookie-free on the public `/api/bootstrap`, which is what a
      // pre-session client reads to learn the mode + join policy.
      const app = await makeApp({ access: { joinPolicy: "approval" }, security: { profile: "hardened" } });
      const config = (
        await app.server.inject({ method: "GET", url: "/api/bootstrap" })
      ).json() as { networkConfig: { joinPolicy: string; securityProfile: string } };
      expect(config.networkConfig.joinPolicy).toBe("approval");
      expect(config.networkConfig.securityProfile).toBe("hardened");
    });

    it("persists access.joinPolicy through the admin config API and rebroadcasts it", async () => {
      const app = await makeApp();
      const admin = await newSession(app);

      const patch = await app.server.inject({
        method: "PATCH",
        url: "/api/admin/config",
        headers: { cookie: admin.cookie },
        payload: { access: { joinPolicy: "approval" } },
      });
      expect(patch.statusCode).toBe(200);
      expect((patch.json() as { access: { joinPolicy: string } }).access.joinPolicy).toBe("approval");

      const config = (
        await app.server.inject({ method: "GET", url: "/api/config", headers: { cookie: admin.cookie } })
      ).json() as { networkConfig: { joinPolicy: string } };
      expect(config.networkConfig.joinPolicy).toBe("approval");
    });
  });
});

describe("security profiles", () => {
  type FullConfig = {
    security: { profile: string };
    access: { joinPolicy: string };
    retention: { messageTtlMs?: number };
    killSwitch: { enabled: boolean };
  };

  async function adminConfig(app: LoamApp, cookie: string): Promise<FullConfig> {
    return (
      await app.server.inject({ method: "GET", url: "/api/admin/config", headers: { cookie } })
    ).json() as FullConfig;
  }

  it("hardened forces its coherent bundle: approval join, ephemeral TTL, armed kill switch, encryption", async () => {
    const app = await makeApp({ security: { profile: "hardened" } });

    // `hardened` forces `required` transport, so there is no cookie identity: the first client binds a
    // secure identity over the sealed channel (docs/20) and, being first, becomes the `firstUser` admin.
    // The public bootstrap advertises the forced axes cookie-free.
    const network = (
      await app.server.inject({ method: "GET", url: "/api/bootstrap" })
    ).json() as { networkConfig: { joinPolicy: string; securityProfile: string; transportEncryption: string } };
    expect(network.networkConfig.securityProfile).toBe("hardened");
    expect(network.networkConfig.joinPolicy).toBe("approval");
    expect(network.networkConfig.transportEncryption).toBe("required");

    const session = await openTransport08(app);
    const bound = await resumeIdentity(app, session, 1);
    expect(bound.status).toBe(200);
    expect(bound.currentUser.isAdmin).toBe(true); // first user under the secure model → firstUser admin

    // The admin config is content — under `required` it is reachable ONLY through the tunnel, and the
    // bound session (not a cookie) authorises it.
    const inner = await tunnelInner(app, session, 2, { m: "GET", p: "/api/admin/config" });
    expect(inner.status).toBe(200);
    const full = JSON.parse(inner.body.toString("utf8")) as {
      access: { joinPolicy: string };
      retention: { messageTtlMs: number };
      killSwitch: { enabled: boolean };
    };
    expect(full.access.joinPolicy).toBe("approval");
    expect(full.retention.messageTtlMs).toBe(3_600_000);
    expect(full.killSwitch.enabled).toBe(true);
  });

  it("selecting a profile via PATCH applies the whole bundle even for unspecified axes", async () => {
    const app = await makeApp();
    const admin = await newSession(app);

    const patch = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { security: { profile: "hardened" } },
    });
    expect(patch.statusCode).toBe(200);
    const cfg = patch.json() as FullConfig;
    expect(cfg.security.profile).toBe("hardened");
    expect(cfg.access.joinPolicy).toBe("approval");
    expect(cfg.retention.messageTtlMs).toBe(3_600_000);
    expect(cfg.killSwitch.enabled).toBe(true);
  });

  it("custom leaves individually-set axes untouched (no forcing)", async () => {
    const app = await makeApp({
      security: { profile: "custom" },
      access: { joinPolicy: "approval" },
      killSwitch: { enabled: true },
    });
    const admin = await newSession(app);
    const full = await adminConfig(app, admin.cookie);
    expect(full.security.profile).toBe("custom");
    expect(full.access.joinPolicy).toBe("approval");
    expect(full.killSwitch.enabled).toBe(true);
  });

  it("defaults to custom, so a kill switch set without a profile is preserved", async () => {
    const app = await makeApp({ killSwitch: { enabled: true } });
    const admin = await newSession(app);
    const full = await adminConfig(app, admin.cookie);
    expect(full.security.profile).toBe("custom");
    expect(full.killSwitch.enabled).toBe(true);
  });

  it("keeps explicit axes from a config.json that also pins a preset profile (effective: custom)", async () => {
    // Hand-authored config.json pinning `standard` (kill switch off) alongside an explicitly-armed
    // kill switch must not have it silently disarmed — the file path reconciles just like the DB one.
    const app = await makeApp({ security: { profile: "standard" }, killSwitch: { enabled: true } });
    const admin = await newSession(app);
    const full = await adminConfig(app, admin.cookie);
    expect(full.security.profile).toBe("custom");
    expect(full.killSwitch.enabled).toBe(true);
  });

  it("heals a legacy persisted profile that would otherwise silently disarm the kill switch", async () => {
    const { app, dataDir } = await makeApp();
    // Simulate config saved by an older build where the profile was inert: profile `standard` sat
    // alongside an explicitly-armed kill switch. The new authoritative `standard` preset would
    // disarm it, so boot must demote the profile to `custom` and keep the operator's setting.
    app.store.setConfigValue(
      "config",
      JSON.stringify({ security: { profile: "standard" }, killSwitch: { enabled: true } }),
    );

    const next = await reopenApp(app, dataDir);
    const admin = await newSession(next);
    const full = await adminConfig(next, admin.cookie);
    expect(full.security.profile).toBe("custom");
    expect(full.killSwitch.enabled).toBe(true);
  });
});

describe("private channels", () => {
  type PrivateChannelBody = {
    id: string;
    visibility: string;
    discoverable: boolean;
    ownerUserId?: string;
    memberUserIds?: string[];
  };

  async function createPrivateChannel(
    app: LoamApp,
    cookie: string,
    name = "Secret Ops",
  ): Promise<PrivateChannelBody> {
    const response = await app.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie },
      payload: { name, visibility: "private" },
    });

    if (response.statusCode !== 201) {
      throw new Error(`Private channel creation failed: ${response.statusCode}`);
    }

    return response.json() as PrivateChannelBody;
  }

  function addMember(app: LoamApp, cookie: string, channelId: string, userId: string): Promise<InjectResponse> {
    return app.server.inject({
      method: "POST",
      url: `/api/channels/${channelId}/members`,
      headers: { cookie },
      payload: { userId },
    });
  }

  function removeMember(app: LoamApp, cookie: string, channelId: string, userId: string): Promise<InjectResponse> {
    return app.server.inject({
      method: "DELETE",
      url: `/api/channels/${channelId}/members/${userId}`,
      headers: { cookie },
    });
  }

  async function channelIdsFor(app: LoamApp, cookie: string): Promise<string[]> {
    const response = await app.server.inject({ method: "GET", url: "/api/channels", headers: { cookie } });
    return (response.json() as { id: string }[]).map((entry) => entry.id);
  }

  function readMessages(app: LoamApp, cookie: string, channelId: string): Promise<InjectResponse> {
    return app.server.inject({ method: "GET", url: `/api/messages/${channelId}`, headers: { cookie } });
  }

  function post(app: LoamApp, cookie: string, channelId: string, body: string): Promise<InjectResponse> {
    return app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie },
      payload: { type: "channelPost", channelId, body },
    });
  }

  it("creates a private channel with the creator as the only member", async () => {
    const app = await makeApp();
    await newSession(app); // burn the firstUser=admin slot
    const owner = await newSession(app);

    const channel = await createPrivateChannel(app, owner.cookie);
    expect(channel.visibility).toBe("private");
    expect(channel.discoverable).toBe(false);
    expect(channel.ownerUserId).toBe(owner.userId);
    expect(channel.memberUserIds).toEqual([owner.userId]);
  });

  it("rejects private channel creation when enablePrivateChannels is off", async () => {
    const app = await makeApp({ features: { enablePrivateChannels: false } });
    const admin = await newSession(app);

    const response = await app.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie: admin.cookie },
      payload: { name: "Nope", visibility: "private" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("hides a private channel from everyone but its members", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const owner = await newSession(app);
    const outsider = await newSession(app);

    const channel = await createPrivateChannel(app, owner.cookie);

    expect(await channelIdsFor(app, owner.cookie)).toContain(channel.id);
    expect(await channelIdsFor(app, outsider.cookie)).not.toContain(channel.id);
    // Even node admins get no implicit membership in the public list...
    expect(await channelIdsFor(app, admin.cookie)).not.toContain(channel.id);

    // ...but the admin management list still shows it (archive/rename without reading).
    const adminList = await app.server.inject({
      method: "GET",
      url: "/api/admin/channels",
      headers: { cookie: admin.cookie },
    });
    expect((adminList.json() as { id: string }[]).some((entry) => entry.id === channel.id)).toBe(true);
  });

  it("answers 404 for message reads by outsiders and for unknown channels alike", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const owner = await newSession(app);
    const outsider = await newSession(app);

    const channel = await createPrivateChannel(app, owner.cookie);
    expect((await post(app, owner.cookie, channel.id, "member post")).statusCode).toBe(201);

    const asOwner = await readMessages(app, owner.cookie, channel.id);
    expect(asOwner.statusCode).toBe(200);
    expect((asOwner.json() as unknown[]).length).toBe(1);

    // Outsider, admin (no implicit read), and a genuinely-missing channel are indistinguishable.
    expect((await readMessages(app, outsider.cookie, channel.id)).statusCode).toBe(404);
    expect((await readMessages(app, admin.cookie, channel.id)).statusCode).toBe(404);
    expect((await readMessages(app, outsider.cookie, "does-not-exist")).statusCode).toBe(404);
  });

  it("blocks outsiders from posting and reacting without leaking channel existence", async () => {
    const app = await makeApp();
    await newSession(app);
    const owner = await newSession(app);
    const outsider = await newSession(app);

    const channel = await createPrivateChannel(app, owner.cookie);
    const posted = await post(app, owner.cookie, channel.id, "hello members");
    const messageId = (posted.json() as { message: { id: string } }).message.id;

    const blockedPost = await post(app, outsider.cookie, channel.id, "let me in");
    expect(blockedPost.statusCode).toBe(400);
    expect((blockedPost.json() as { error: string }).error).toBe("Channel does not exist");

    const blockedReaction = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: outsider.cookie },
      payload: { type: "reaction", targetMessageId: messageId, reaction: "👍" },
    });
    expect(blockedReaction.statusCode).toBe(400);
  });

  it("lets the owner invite and remove members, who gain and lose access", async () => {
    const app = await makeApp();
    await newSession(app);
    const owner = await newSession(app);
    const invitee = await newSession(app);

    const channel = await createPrivateChannel(app, owner.cookie);
    expect((await post(app, owner.cookie, channel.id, "founding note")).statusCode).toBe(201);

    const added = await addMember(app, owner.cookie, channel.id, invitee.userId);
    expect(added.statusCode).toBe(200);
    expect((added.json() as PrivateChannelBody).memberUserIds).toContain(invitee.userId);

    expect(await channelIdsFor(app, invitee.cookie)).toContain(channel.id);
    expect((await readMessages(app, invitee.cookie, channel.id)).statusCode).toBe(200);
    expect((await post(app, invitee.cookie, channel.id, "thanks for the invite")).statusCode).toBe(201);

    const removed = await removeMember(app, owner.cookie, channel.id, invitee.userId);
    expect(removed.statusCode).toBe(200);
    expect(await channelIdsFor(app, invitee.cookie)).not.toContain(channel.id);
    expect((await readMessages(app, invitee.cookie, channel.id)).statusCode).toBe(404);
  });

  it("lets a member leave, keeps the owner in place, and gates invites to owner/admin", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const owner = await newSession(app);
    const member = await newSession(app);
    const other = await newSession(app);

    const channel = await createPrivateChannel(app, owner.cookie);
    await addMember(app, owner.cookie, channel.id, member.userId);

    // A plain member cannot invite others...
    expect((await addMember(app, member.cookie, channel.id, other.userId)).statusCode).toBe(403);
    // ...or remove anyone else (the permission gate answers before owner-protection).
    expect((await removeMember(app, member.cookie, channel.id, owner.userId)).statusCode).toBe(403);

    // An admin may manage membership without being a member.
    expect((await addMember(app, admin.cookie, channel.id, other.userId)).statusCode).toBe(200);

    // A member may leave (remove themselves).
    expect((await removeMember(app, member.cookie, channel.id, member.userId)).statusCode).toBe(200);
    expect(await channelIdsFor(app, member.cookie)).not.toContain(channel.id);

    // The owner can never be removed — not even by themselves or an admin.
    expect((await removeMember(app, owner.cookie, channel.id, owner.userId)).statusCode).toBe(400);
    expect((await removeMember(app, admin.cookie, channel.id, owner.userId)).statusCode).toBe(400);
  });

  it("hides the member roster from outsiders and rejects it for public channels", async () => {
    const app = await makeApp();
    await newSession(app);
    const owner = await newSession(app);
    const outsider = await newSession(app);

    const channel = await createPrivateChannel(app, owner.cookie);

    const asOwner = await app.server.inject({
      method: "GET",
      url: `/api/channels/${channel.id}/members`,
      headers: { cookie: owner.cookie },
    });
    expect(asOwner.statusCode).toBe(200);
    expect((asOwner.json() as { id: string }[]).map((user) => user.id)).toEqual([owner.userId]);

    const asOutsider = await app.server.inject({
      method: "GET",
      url: `/api/channels/${channel.id}/members`,
      headers: { cookie: outsider.cookie },
    });
    expect(asOutsider.statusCode).toBe(404);

    const publicRoster = await app.server.inject({
      method: "GET",
      url: "/api/channels/general/members",
      headers: { cookie: owner.cookie },
    });
    expect(publicRoster.statusCode).toBe(400);
  });

  it("persists private channels and their members across a restart", async () => {
    const { app, dataDir } = await makeApp();
    await newSession(app);
    const owner = await newSession(app);
    const member = await newSession(app);

    const channel = await createPrivateChannel(app, owner.cookie);
    await addMember(app, owner.cookie, channel.id, member.userId);

    const next = await reopenApp(app, dataDir);
    const stored = next.store.loadChannels().find((entry) => entry.id === channel.id);
    expect(stored?.visibility).toBe("private");
    expect(stored?.memberUserIds).toEqual([owner.userId, member.userId]);

    expect((await readMessages(next, member.cookie, channel.id)).statusCode).toBe(200);
  });

  function transfer(app: LoamApp, cookie: string, channelId: string, userId: string): Promise<InjectResponse> {
    return app.server.inject({
      method: "POST",
      url: `/api/channels/${channelId}/transfer`,
      headers: { cookie },
      payload: { userId },
    });
  }

  it("transfers ownership, adding the new owner to the roster and keeping the old owner a member", async () => {
    const app = await makeApp();
    await newSession(app);
    const owner = await newSession(app);
    const heir = await newSession(app);

    const channel = await createPrivateChannel(app, owner.cookie);
    const response = await transfer(app, owner.cookie, channel.id, heir.userId);
    expect(response.statusCode).toBe(200);

    const body = response.json() as PrivateChannelBody;
    expect(body.ownerUserId).toBe(heir.userId);
    // New owner joined the roster; the previous owner stays a member.
    expect(body.memberUserIds).toEqual([owner.userId, heir.userId]);

    // The new owner can now manage members; the old owner no longer can.
    expect((await addMember(app, heir.cookie, channel.id, owner.userId)).statusCode).toBe(200);
    const oldOwnerInvites = await addMember(app, owner.cookie, channel.id, (await newSession(app)).userId);
    expect(oldOwnerInvites.statusCode).toBe(403);
  });

  it("lets a node admin transfer ownership but forbids a non-owner member", async () => {
    const app = await makeApp();
    const admin = await newSession(app); // firstUser → admin
    const owner = await newSession(app);
    const member = await newSession(app);

    const channel = await createPrivateChannel(app, owner.cookie);
    await addMember(app, owner.cookie, channel.id, member.userId);

    // A plain member cannot transfer.
    expect((await transfer(app, member.cookie, channel.id, member.userId)).statusCode).toBe(403);
    // An admin can, even without being a member.
    const asAdmin = await transfer(app, admin.cookie, channel.id, member.userId);
    expect(asAdmin.statusCode).toBe(200);
    expect((asAdmin.json() as PrivateChannelBody).ownerUserId).toBe(member.userId);
  });

  it("404s a transfer on a channel the caller can't see and rejects a banned target", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const owner = await newSession(app);
    const outsider = await newSession(app);

    const channel = await createPrivateChannel(app, owner.cookie);

    // An outsider can't even tell the channel exists.
    expect((await transfer(app, outsider.cookie, channel.id, owner.userId)).statusCode).toBe(404);

    // Ban the outsider, then try to hand them the channel — rejected.
    await app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${outsider.userId}`,
      headers: { cookie: admin.cookie },
      payload: { banned: true },
    });
    expect((await transfer(app, owner.cookie, channel.id, outsider.userId)).statusCode).toBe(400);
  });

  it("keeps the previous owner in the roster when transferring to an existing member", async () => {
    const app = await makeApp();
    await newSession(app);
    const owner = await newSession(app);
    const member = await newSession(app);

    const channel = await createPrivateChannel(app, owner.cookie);
    await addMember(app, owner.cookie, channel.id, member.userId);

    // Transfer to someone who was already a member — the old owner must remain an explicit member,
    // not silently drop out once they stop being the (implicit) owner.
    const body = (await transfer(app, owner.cookie, channel.id, member.userId)).json() as PrivateChannelBody;
    expect(body.ownerUserId).toBe(member.userId);
    expect(new Set(body.memberUserIds)).toEqual(new Set([owner.userId, member.userId]));
  });
});

describe("message search", () => {
  function search(app: LoamApp, cookie: string, query: string): Promise<InjectResponse> {
    return app.server.inject({
      method: "GET",
      url: `/api/search?q=${encodeURIComponent(query)}`,
      headers: { cookie },
    });
  }

  function results(response: InjectResponse): { id: string; body?: string }[] {
    return (response.json() as { results: { id: string; body?: string }[] }).results;
  }

  async function post(app: LoamApp, cookie: string, channelId: string, body: string): Promise<string> {
    const response = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie },
      payload: { type: "channelPost", channelId, body },
    });
    return (response.json() as { message: { id: string } }).message.id;
  }

  it("matches case-insensitively, newest first, and requires a query", async () => {
    const app = await makeApp();
    const session = await newSession(app);

    await post(app, session.cookie, "general", "The water point is OPEN again");
    await post(app, session.cookie, "general", "Bring water bottles tomorrow");
    await post(app, session.cookie, "general", "Unrelated note");

    const response = await search(app, session.cookie, "water");
    expect(response.statusCode).toBe(200);
    const found = results(response);
    expect(found.length).toBe(2);
    expect(found[0]?.body).toBe("Bring water bottles tomorrow");
    expect(found[1]?.body).toBe("The water point is OPEN again");

    expect((await search(app, session.cookie, "   ")).statusCode).toBe(400);
  });

  it("keeps DMs scoped to their participants", async () => {
    const app = await makeApp();
    const alice = await newSession(app);
    const bob = await newSession(app);
    const eve = await newSession(app);

    await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: alice.cookie },
      payload: { type: "dm", recipientUserId: bob.userId, body: "secret rendezvous point" },
    });

    expect(results(await search(app, alice.cookie, "rendezvous")).length).toBe(1);
    expect(results(await search(app, bob.cookie, "rendezvous")).length).toBe(1);
    expect(results(await search(app, eve.cookie, "rendezvous")).length).toBe(0);
  });

  it("keeps private-channel messages scoped to members and skips archived channels", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const owner = await newSession(app);
    const outsider = await newSession(app);

    const created = await app.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie: owner.cookie },
      payload: { name: "Quiet Room", visibility: "private" },
    });
    const channelId = (created.json() as { id: string }).id;
    await post(app, owner.cookie, channelId, "meet at the quiet spot");

    expect(results(await search(app, owner.cookie, "quiet spot")).length).toBe(1);
    expect(results(await search(app, outsider.cookie, "quiet spot")).length).toBe(0);
    expect(results(await search(app, admin.cookie, "quiet spot")).length).toBe(0);

    // Archiving a channel removes its messages from search results too.
    await post(app, admin.cookie, "general", "archive me please");
    await app.server.inject({
      method: "PATCH",
      url: "/api/channels/general",
      headers: { cookie: admin.cookie },
      payload: { archived: true },
    });
    expect(results(await search(app, admin.cookie, "archive me")).length).toBe(0);
  });

  it("shows a shadow-banned author's messages only to themselves", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const target = await newSession(app);

    await post(app, target.cookie, "general", "shadow banned words");
    await app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${target.userId}`,
      headers: { cookie: admin.cookie },
      payload: { shadowBanned: true },
    });

    expect(results(await search(app, target.cookie, "shadow banned words")).length).toBe(1);
    expect(results(await search(app, admin.cookie, "shadow banned words")).length).toBe(0);
  });

  it("caps results at the requested limit", async () => {
    const app = await makeApp();
    const session = await newSession(app);

    for (let index = 0; index < 5; index += 1) {
      await post(app, session.cookie, "general", `flood message ${index}`);
    }

    const response = await app.server.inject({
      method: "GET",
      url: "/api/search?q=flood&limit=3",
      headers: { cookie: session.cookie },
    });
    expect(results(response).length).toBe(3);
  });
});

describe("participation gating (banned / pending read access)", () => {
  const readPaths = ["/api/channels", "/api/users", "/api/messages/general", "/api/search?q=x"];

  async function statusFor(app: LoamApp, cookie: string, url: string): Promise<number> {
    return (await app.server.inject({ method: "GET", url, headers: { cookie } })).statusCode;
  }

  it("locks a banned user out of every read endpoint", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const target = await newSession(app);

    // Reads work before the ban.
    expect(await statusFor(app, target.cookie, "/api/channels")).toBe(200);

    const ban = await app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${target.userId}`,
      headers: { cookie: admin.cookie },
      payload: { banned: true },
    });
    expect(ban.statusCode).toBe(200);

    for (const path of readPaths) {
      expect(await statusFor(app, target.cookie, path)).toBe(403);
    }
    expect(await statusFor(app, target.cookie, `/api/dms/${admin.userId}`)).toBe(403);

    // Config stays open — it is how the client learns it is banned.
    expect(await statusFor(app, target.cookie, "/api/config")).toBe(200);
  });

  it("holds a pending user at the door until approval, then lets them in", async () => {
    const app = await makeApp({ access: { joinPolicy: "approval" } });
    const admin = await newSession(app);
    const joiner = await newSession(app);

    for (const path of readPaths) {
      expect(await statusFor(app, joiner.cookie, path)).toBe(403);
    }

    const created = await app.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie: joiner.cookie },
      payload: { name: "Sneaky" },
    });
    expect(created.statusCode).toBe(403);

    const approve = await app.server.inject({
      method: "POST",
      url: `/api/access/users/${joiner.userId}/approve`,
      headers: { cookie: admin.cookie },
    });
    expect(approve.statusCode).toBe(200);

    for (const path of readPaths) {
      expect(await statusFor(app, joiner.cookie, path)).toBe(200);
    }
  });
});

describe("websocket privacy filtering", () => {
  type WireEvent = {
    type?: string;
    messageId?: string;
    text?: string;
    error?: string;
    user?: { id?: string; pending?: boolean };
    message?: { id?: string; authorId?: string; body?: string; meta?: { streaming?: boolean } };
  };

  const openSockets: WebSocket[] = [];

  afterEach(() => {
    for (const socket of openSockets) {
      socket.close();
    }
    openSockets.length = 0;
  });

  async function listen(app: LoamApp): Promise<string> {
    return app.server.listen({ port: 0, host: "127.0.0.1" });
  }

  function connect(baseUrl: string, cookie: string): Promise<{ socket: WebSocket; events: WireEvent[]; closed: Promise<void> }> {
    return new Promise((resolve, reject) => {
      // Undici's WebSocket accepts an options bag with headers (needed to send the session cookie).
      const socket = new (WebSocket as unknown as new (url: string, opts: unknown) => WebSocket)(
        `${baseUrl.replace("http", "ws")}/ws`,
        { headers: { cookie } },
      );
      const events: WireEvent[] = [];
      const closed = new Promise<void>((resolveClose) => {
        socket.addEventListener("close", () => resolveClose());
      });
      socket.addEventListener("message", (event) => {
        events.push(JSON.parse(String((event as MessageEvent).data)) as WireEvent);
      });
      socket.addEventListener("open", () => {
        openSockets.push(socket);
        resolve({ socket, events, closed });
      });
      socket.addEventListener("error", () => reject(new Error("websocket failed to connect")));
    });
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

  /**
   * Bounded wait for an expected event, so positive assertions don't race CI scheduling the way a
   * fixed sleep can. Negative assertions ("never delivered") still use `settle` — or first await
   * the *other* party's copy of the same broadcast, which proves delivery completed.
   */
  async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (check()) {
        return true;
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    return check();
  }

  it("withholds a shadow-banned author's deleted message body from everyone else", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const target = await newSession(app);
    const viewer = await newSession(app);
    const baseUrl = await listen(app);

    const posted = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: target.cookie },
      payload: { type: "channelPost", channelId: "general", body: "the hidden text" },
    });
    const messageId = (posted.json() as { message: { id: string } }).message.id;

    await app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${target.userId}`,
      headers: { cookie: admin.cookie },
      payload: { shadowBanned: true },
    });

    const viewerSocket = await connect(baseUrl, viewer.cookie);
    const targetSocket = await connect(baseUrl, target.cookie);

    const deleted = await app.server.inject({
      method: "DELETE",
      url: `/api/messages/${messageId}`,
      headers: { cookie: admin.cookie },
    });
    expect(deleted.statusCode).toBe(200);

    // The delete event carries the full body — it must stay between the author and nobody else.
    // The author receiving their copy proves the broadcast completed, making the viewer's silence
    // a real verdict rather than a timing artifact.
    expect(
      await waitFor(() =>
        targetSocket.events.some((event) => event.type === "messageDeleted" && event.messageId === messageId),
      ),
    ).toBe(true);
    expect(viewerSocket.events.some((event) => event.type === "messageDeleted")).toBe(false);
  });

  it("rejects a banned user's websocket reconnect", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const target = await newSession(app);
    const baseUrl = await listen(app);

    await app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${target.userId}`,
      headers: { cookie: admin.cookie },
      payload: { banned: true },
    });

    const reconnect = await connect(baseUrl, target.cookie);
    await reconnect.closed;
    expect(reconnect.events.some((event) => event.type === "error")).toBe(true);

    // A healthy user still connects and stays connected.
    const healthy = await connect(baseUrl, admin.cookie);
    await settle();
    expect(healthy.socket.readyState).toBe(WebSocket.OPEN);
  });

  it("limits a pending user's feed to node notices and their own approval", async () => {
    const app = await makeApp({ access: { joinPolicy: "approval" } });
    const admin = await newSession(app);
    const joiner = await newSession(app);
    const baseUrl = await listen(app);

    const joinerSocket = await connect(baseUrl, joiner.cookie);

    await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: admin.cookie },
      payload: { type: "channelPost", channelId: "general", body: "members only chatter" },
    });
    await settle();
    expect(joinerSocket.events.some((event) => event.type === "messageCreated")).toBe(false);

    await app.server.inject({
      method: "POST",
      url: `/api/access/users/${joiner.userId}/approve`,
      headers: { cookie: admin.cookie },
    });
    expect(
      await waitFor(() =>
        joinerSocket.events.some(
          (event) => event.type === "userUpserted" && event.user?.id === joiner.userId && event.user?.pending !== true,
        ),
      ),
    ).toBe(true);
  });

  it("announces hidden identities only to themselves and to moderators", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const bystander = await newSession(app);
    const target = await newSession(app);
    const baseUrl = await listen(app);

    const adminSocket = await connect(baseUrl, admin.cookie);
    const bystanderSocket = await connect(baseUrl, bystander.cookie);

    await app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${target.userId}`,
      headers: { cookie: admin.cookie },
      payload: { banned: true },
    });

    const sawBanned = (events: WireEvent[]) =>
      events.some((event) => event.type === "userUpserted" && event.user?.id === target.userId);
    // The moderator receiving their copy proves the broadcast completed before the negative check.
    expect(await waitFor(() => sawBanned(adminSocket.events))).toBe(true);
    expect(sawBanned(bystanderSocket.events)).toBe(false);
  });

  it("streams Ollama deltas to the DM and converges to a single final messageUpdated (docs/15 #15)", async () => {
    const ollama = startMockOllama(["Hello", " from", " Ollama"]);
    cleanups.push(ollama.close);
    const app = await makeApp({ llm: { ollama: { enabled: true, baseUrl: await ollama.url } } });
    const user = await newSession(app);
    const baseUrl = await listen(app);
    const userSocket = await connect(baseUrl, user.cookie);
    const BOT_ID = "llm.ollama.gemma4"; // default botId (unchanged by the config override above)

    const dm = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: user.cookie },
      payload: { type: "dm", recipientUserId: BOT_ID, body: "hi" },
    });
    expect(dm.statusCode).toBe(201);

    expect(await waitFor(() => userSocket.events.some((event) => event.type === "end"))).toBe(true);

    // Genuinely streamed (more than one delta event), and the deltas concatenate to the full reply.
    const deltas = userSocket.events.filter((event) => event.type === "delta");
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map((event) => event.text).join("")).toBe("Hello from Ollama");

    // Exactly one persisted messageUpdated for the assistant message — clients converge on a single
    // final body instead of one broadcast per delta.
    const updates = userSocket.events.filter(
      (event) => event.type === "messageUpdated" && event.message?.authorId === BOT_ID,
    );
    expect(updates.length).toBe(1);
    expect(updates[0]?.message?.body).toBe("Hello from Ollama");
    expect(updates[0]?.message?.meta?.streaming).toBe(false);

    // The DM history was actually forwarded to Ollama.
    expect(ollama.requests[0]?.messages?.at(-1)).toEqual({ role: "user", content: "hi" });
  });

  it("never delivers Ollama stream deltas (or the bot DM) to a bystander outside the DM (docs/15 #15)", async () => {
    const ollama = startMockOllama(["secret", " reply"]);
    cleanups.push(ollama.close);
    const app = await makeApp({ llm: { ollama: { enabled: true, baseUrl: await ollama.url } } });
    const user = await newSession(app);
    const bystander = await newSession(app);
    const baseUrl = await listen(app);
    const userSocket = await connect(baseUrl, user.cookie);
    const bystanderSocket = await connect(baseUrl, bystander.cookie);
    const BOT_ID = "llm.ollama.gemma4";

    await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: user.cookie },
      payload: { type: "dm", recipientUserId: BOT_ID, body: "hi" },
    });

    // The DM participant seeing the stream complete proves the round finished, making the
    // bystander's silence below a real verdict rather than a timing artifact.
    expect(await waitFor(() => userSocket.events.some((event) => event.type === "end"))).toBe(true);

    expect(bystanderSocket.events.some((event) => event.type === "start")).toBe(false);
    expect(bystanderSocket.events.some((event) => event.type === "delta")).toBe(false);
    expect(bystanderSocket.events.some((event) => event.type === "end")).toBe(false);
    expect(
      bystanderSocket.events.some(
        (event) =>
          (event.type === "messageCreated" || event.type === "messageUpdated") && event.message?.authorId === BOT_ID,
      ),
    ).toBe(false);
  });
});

describe("review hardening fixes", () => {
  it("encrypted kill switch re-persists admin config edits into the fresh database", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "loam-enc-config-test-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const key = "a fixed host passphrase";
    const first = await buildApp({ dataDir, logger: false, dbEncryptionKey: key });
    cleanups.push(() => first.close());

    const admin = await newSession(first);
    // Arm the kill switch purely via the admin API — persisted only in the DB config table.
    const patch = await first.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { killSwitch: { enabled: true }, features: { enableReactions: false } },
    });
    expect(patch.statusCode).toBe(200);

    const wipe = await first.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });
    expect(wipe.statusCode).toBe(200);

    // Restart on the same data dir + key: the admin edits must survive the wipe.
    await first.close();
    const second = await buildApp({ dataDir, logger: false, dbEncryptionKey: key });
    cleanups.push(() => second.close());

    const nextAdmin = await newSession(second);
    const config = await second.server.inject({
      method: "GET",
      url: "/api/admin/config",
      headers: { cookie: nextAdmin.cookie },
    });
    const body = config.json() as { killSwitch: { enabled: boolean }; features: { enableReactions: boolean } };
    expect(body.killSwitch.enabled).toBe(true);
    expect(body.features.enableReactions).toBe(false);
  });

  it("retention reaper cascades an expired thread root to its replies and reactions", async () => {
    const app = await makeApp({ retention: { messageTtlMs: 500 } });
    const session = await newSession(app);
    // Fake only `Date` (see the reap-and-keep test): faking timers wholesale would hang inject.
    vi.useFakeTimers({ toFake: ["Date"] });

    const root = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: session.cookie },
      payload: { type: "channelPost", channelId: "general", body: "expiring root" },
    });
    const rootId = (root.json() as { message: { id: string } }).message.id;

    // Jump a full TTL past the root's `createdAt` (was a real 700ms sleep); the reply + reaction
    // added afterwards are young, so only the cascade — not their own age — can reap them.
    await vi.advanceTimersByTimeAsync(700);

    // Young reply + reaction attached to the now-expired root.
    await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: session.cookie },
      payload: { type: "channelReply", channelId: "general", parentMessageId: rootId, body: "fresh reply" },
    });
    await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: session.cookie },
      payload: { type: "reaction", targetMessageId: rootId, reaction: "👍" },
    });

    app.reapExpiredMessages();

    // No orphans: the root's whole thread goes with it.
    expect(app.store.loadMessages()).toEqual([]);
  });
});

describe("message attachments", () => {
  // A real 1x1 PNG (valid magic bytes) — small enough to inline.
  const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  async function upload(app: LoamApp, cookie: string, data = tinyPng, mimeType = "image/png") {
    return app.server.inject({
      method: "POST",
      url: "/api/attachments",
      headers: { cookie },
      payload: { mimeType, data, width: 1, height: 1 },
    });
  }

  it("uploads, attaches, serves, and allows an image-only message", async () => {
    const app = await makeApp();
    const session = await newSession(app);

    const uploaded = await upload(app, session.cookie);
    expect(uploaded.statusCode).toBe(201);
    const attachment = uploaded.json() as { id: string; mimeType: string };
    expect(attachment.id).toMatch(/^att_[a-f0-9]{16}$/);

    // Empty body + attachment is a valid message.
    const posted = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: session.cookie },
      payload: { type: "channelPost", channelId: "general", body: "", attachments: [attachment] },
    });
    expect(posted.statusCode).toBe(201);

    const served = await app.server.inject({
      method: "GET",
      url: `/api/attachments/${attachment.id}.png`,
      headers: { cookie: session.cookie },
    });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toContain("image/png");

    const listed = (
      await app.server.inject({ method: "GET", url: "/api/messages/general", headers: { cookie: session.cookie } })
    ).json() as { attachments?: { id: string }[] }[];
    expect(listed[0]?.attachments?.[0]?.id).toBe(attachment.id);
  });

  it("rejects a message with no body and no attachments", async () => {
    const app = await makeApp();
    const session = await newSession(app);

    const posted = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: session.cookie },
      payload: { type: "channelPost", channelId: "general", body: "   " },
    });
    expect(posted.statusCode).toBe(400);
  });

  it("rejects uploads when the flag is off, on signature mismatch, and foreign attachment ids", async () => {
    const flagOff = await makeApp({ features: { enableAttachments: false } });
    const offSession = await newSession(flagOff);
    expect((await upload(flagOff, offSession.cookie)).statusCode).toBe(403);

    const app = await makeApp();
    const alice = await newSession(app);
    const mallory = await newSession(app);

    // Declared webp but PNG bytes.
    expect((await upload(app, alice.cookie, tinyPng, "image/webp")).statusCode).toBe(400);

    const uploaded = (await upload(app, alice.cookie)).json() as { id: string; mimeType: string };

    // Mallory cannot attach Alice's pending upload...
    const stolen = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: mallory.cookie },
      payload: { type: "channelPost", channelId: "general", body: "mine now", attachments: [uploaded] },
    });
    expect(stolen.statusCode).toBe(400);
    expect((stolen.json() as { error: string }).error).toBe("Unknown attachment");

    // ...and after Alice uses it, the id is consumed and cannot be attached again.
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: "/api/messages",
          headers: { cookie: alice.cookie },
          payload: { type: "channelPost", channelId: "general", body: "one", attachments: [uploaded] },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: "/api/messages",
          headers: { cookie: alice.cookie },
          payload: { type: "channelPost", channelId: "general", body: "two", attachments: [uploaded] },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("deletes the attachment file with its message", async () => {
    const { app, dataDir } = await makeApp();
    const session = await newSession(app);

    const attachment = (await upload(app, session.cookie)).json() as { id: string; mimeType: string };
    const posted = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: session.cookie },
      payload: { type: "channelPost", channelId: "general", body: "", attachments: [attachment] },
    });
    const messageId = (posted.json() as { message: { id: string } }).message.id;
    const filePath = join(dataDir, "attachments", `${attachment.id}.png`);
    expect(existsSync(filePath)).toBe(true);

    await app.server.inject({
      method: "DELETE",
      url: `/api/messages/${messageId}`,
      headers: { cookie: session.cookie },
    });
    // File removal is best-effort/async — poll briefly.
    for (let i = 0; i < 40 && existsSync(filePath); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(existsSync(filePath)).toBe(false);
  });
});

describe("node-to-node sync", () => {
  async function listenApp(app: LoamApp): Promise<string> {
    return app.server.listen({ port: 0, host: "127.0.0.1" });
  }

  async function post(app: LoamApp, cookie: string, channelId: string, body: string): Promise<string> {
    const response = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie },
      payload: { type: "channelPost", channelId, body },
    });
    return (response.json() as { message: { id: string } }).message.id;
  }

  async function runSync(app: LoamApp, cookie: string) {
    return app.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie } });
  }

  async function generalBodies(app: LoamApp, cookie: string): Promise<string[]> {
    const response = await app.server.inject({
      method: "GET",
      url: "/api/messages/general",
      headers: { cookie },
    });
    return (response.json() as { body?: string }[]).map((message) => message.body ?? "");
  }

  it("answers 404 on the sync endpoints unless enabled", async () => {
    const app = await makeApp();
    expect((await app.server.inject({ method: "GET", url: "/api/sync/digest" })).statusCode).toBe(404);
    expect(
      (await app.server.inject({ method: "POST", url: "/api/sync/messages", payload: { ids: ["x"] } })).statusCode,
    ).toBe(404);
  });

  it("pulls public messages and channels from a peer, sanitizing imported users", async () => {
    const source = await makeApp({ sync: { enabled: true, peers: [], intervalMs: 3_600_000 } });
    const sourceAdmin = await newSession(source);
    expect(sourceAdmin.isAdmin).toBe(true);
    await post(source, sourceAdmin.cookie, "general", "hello from the other node");
    await source.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie: sourceAdmin.cookie },
      payload: { name: "Relief Ops" },
    });
    await post(source, sourceAdmin.cookie, "relief-ops", "supplies at the depot");
    const sourceUrl = await listenApp(source);

    const puller = await makeApp({
      sync: { enabled: true, peers: [{ url: sourceUrl, label: "source" }], intervalMs: 3_600_000 },
    });
    const pullerAdmin = await newSession(puller);

    const run = await runSync(puller, pullerAdmin.cookie);
    expect(run.statusCode).toBe(200);
    const report = run.json() as { peers: { status?: { lastError?: string; imported: number } }[] };
    expect(report.peers[0]?.status?.lastError).toBeUndefined();

    expect(await generalBodies(puller, pullerAdmin.cookie)).toContain("hello from the other node");

    // The peer's channel was imported too, with its messages.
    const channels = (
      await puller.server.inject({ method: "GET", url: "/api/channels", headers: { cookie: pullerAdmin.cookie } })
    ).json() as { id: string }[];
    expect(channels.some((channel) => channel.id === "relief-ops")).toBe(true);

    // The source's admin author arrives as a plain user — authority never syncs.
    const importedAuthor = puller.store.loadUsers().find((user) => user.id === sourceAdmin.userId);
    expect(importedAuthor).toBeDefined();
    expect(importedAuthor?.isAdmin).toBe(false);

    // Running again imports nothing new (idempotent by id).
    const again = (await runSync(puller, pullerAdmin.cookie)).json() as {
      peers: { status?: { imported: number } }[];
    };
    const importedTotal = again.peers[0]?.status?.imported ?? -1;
    expect(importedTotal).toBeGreaterThan(0);
    const third = (await runSync(puller, pullerAdmin.cookie)).json() as {
      peers: { status?: { imported: number } }[];
    };
    expect(third.peers[0]?.status?.imported).toBe(importedTotal);
  });

  it("never exports private channels, DMs, or shadow-banned authors' messages", async () => {
    const source = await makeApp({ sync: { enabled: true, peers: [], intervalMs: 3_600_000 } });
    const admin = await newSession(source);
    const owner = await newSession(source);
    const shadowed = await newSession(source);

    // Private channel + message.
    const created = await source.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie: owner.cookie },
      payload: { name: "Quiet", visibility: "private" },
    });
    const privateId = (created.json() as { id: string }).id;
    await source.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: owner.cookie },
      payload: { type: "channelPost", channelId: privateId, body: "private words" },
    });

    // DM.
    await source.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: admin.cookie },
      payload: { type: "dm", recipientUserId: owner.userId, body: "dm words" },
    });

    // Shadow-banned author's public post.
    await post(source, shadowed.cookie, "general", "shadow words");
    await source.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${shadowed.userId}`,
      headers: { cookie: admin.cookie },
      payload: { shadowBanned: true },
    });

    await post(source, admin.cookie, "general", "public words");

    const digest = (
      await source.server.inject({ method: "GET", url: "/api/sync/digest" })
    ).json() as { channels: { id: string }[]; messages: { id: string }[] };

    expect(digest.channels.some((channel) => channel.id === privateId)).toBe(false);

    // Resolve each advertised id and confirm none of the withheld bodies appear.
    const fetched = (
      await source.server.inject({
        method: "POST",
        url: "/api/sync/messages",
        payload: { ids: digest.messages.map((entry) => entry.id) },
      })
    ).json() as { messages: { body?: string }[] };
    const bodies = fetched.messages.map((message) => message.body ?? "");
    expect(bodies).toContain("public words");
    expect(bodies).not.toContain("private words");
    expect(bodies).not.toContain("dm words");
    expect(bodies).not.toContain("shadow words");
  });

  it("tombstones keep locally deleted messages from re-importing, and edits propagate", async () => {
    const source = await makeApp({ sync: { enabled: true, peers: [], intervalMs: 3_600_000 } });
    const sourceAdmin = await newSession(source);
    const keepId = await post(source, sourceAdmin.cookie, "general", "keep me");
    const doomedId = await post(source, sourceAdmin.cookie, "general", "delete me locally");
    const sourceUrl = await listenApp(source);

    const puller = await makeApp({
      sync: { enabled: true, peers: [{ url: sourceUrl }], intervalMs: 3_600_000 },
    });
    const pullerAdmin = await newSession(puller);
    await runSync(puller, pullerAdmin.cookie);
    expect(await generalBodies(puller, pullerAdmin.cookie)).toContain("delete me locally");

    // Delete locally on the puller; the source still holds it — it must not come back.
    await puller.server.inject({
      method: "DELETE",
      url: `/api/messages/${doomedId}`,
      headers: { cookie: pullerAdmin.cookie },
    });
    await runSync(puller, pullerAdmin.cookie);
    expect(await generalBodies(puller, pullerAdmin.cookie)).not.toContain("delete me locally");

    // An edit on the source propagates (newer editedAt wins).
    await source.server.inject({
      method: "PATCH",
      url: `/api/messages/${keepId}`,
      headers: { cookie: sourceAdmin.cookie },
      payload: { body: "keep me (edited)" },
    });
    await runSync(puller, pullerAdmin.cookie);
    expect(await generalBodies(puller, pullerAdmin.cookie)).toContain("keep me (edited)");
  });

  it("horizon GC: a tombstone blocks re-import within the horizon, but is prunable past it (docs/15 #7)", async () => {
    const source = await makeApp({ sync: { enabled: true, peers: [], intervalMs: 3_600_000 } });
    const sourceAdmin = await newSession(source);
    const doomedId = await post(source, sourceAdmin.cookie, "general", "delete me locally, horizon test");
    const sourceUrl = await listenApp(source);

    // A tiny horizon (test-only override) so the GC boundary can be exercised without waiting days.
    const puller = await makeApp(
      { sync: { enabled: true, peers: [{ url: sourceUrl }], intervalMs: 3_600_000 } },
      { tombstoneHorizonMs: 50 },
    );
    const pullerAdmin = await newSession(puller);
    await runSync(puller, pullerAdmin.cookie);
    expect(await generalBodies(puller, pullerAdmin.cookie)).toContain("delete me locally, horizon test");

    await puller.server.inject({
      method: "DELETE",
      url: `/api/messages/${doomedId}`,
      headers: { cookie: pullerAdmin.cookie },
    });
    expect(puller.store.loadTombstones()).toContain(doomedId);

    // Still within the horizon: the reaper leaves the tombstone alone, and sync must not resurrect it.
    puller.reapExpiredMessages();
    expect(puller.store.loadTombstones()).toContain(doomedId);
    await runSync(puller, pullerAdmin.cookie);
    expect(await generalBodies(puller, pullerAdmin.cookie)).not.toContain("delete me locally, horizon test");

    // Past the horizon: the reaper GCs the tombstone, and a subsequent pull can hand the message
    // back — the accepted DTN limitation for a peer that was offline longer than the horizon.
    await new Promise((resolve) => setTimeout(resolve, 75));
    puller.reapExpiredMessages();
    expect(puller.store.loadTombstones()).not.toContain(doomedId);
    await runSync(puller, pullerAdmin.cookie);
    expect(await generalBodies(puller, pullerAdmin.cookie)).toContain("delete me locally, horizon test");
  });
});

describe("attachment + sync review hardening", () => {
  const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  async function uploadAttachment(app: LoamApp, cookie: string) {
    const response = await app.server.inject({
      method: "POST",
      url: "/api/attachments",
      headers: { cookie },
      payload: { mimeType: "image/png", data: tinyPng },
    });
    return response.json() as { id: string; mimeType: string };
  }

  it("audience-gates attachment downloads like their owning message", async () => {
    const app = await makeApp();
    const alice = await newSession(app);
    const bob = await newSession(app);
    const eve = await newSession(app);

    // A DM attachment: participants can fetch it, a third party (or no session) cannot.
    const dmAttachment = await uploadAttachment(app, alice.cookie);
    await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: alice.cookie },
      payload: { type: "dm", recipientUserId: bob.userId, body: "look", attachments: [dmAttachment] },
    });

    const path = `/api/attachments/${dmAttachment.id}.png`;
    expect((await app.server.inject({ method: "GET", url: path, headers: { cookie: alice.cookie } })).statusCode).toBe(200);
    expect((await app.server.inject({ method: "GET", url: path, headers: { cookie: bob.cookie } })).statusCode).toBe(200);
    expect((await app.server.inject({ method: "GET", url: path, headers: { cookie: eve.cookie } })).statusCode).toBe(404);
    expect((await app.server.inject({ method: "GET", url: path })).statusCode).toBe(404);

    // A public-channel attachment stays anonymously fetchable (peer nodes copy without a session).
    const publicAttachment = await uploadAttachment(app, alice.cookie);
    await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: alice.cookie },
      payload: { type: "channelPost", channelId: "general", body: "", attachments: [publicAttachment] },
    });
    expect(
      (await app.server.inject({ method: "GET", url: `/api/attachments/${publicAttachment.id}.png` })).statusCode,
    ).toBe(200);

    // A pending (not yet attached) upload is only visible to its uploader.
    const pendingAttachment = await uploadAttachment(app, alice.cookie);
    const pendingPath = `/api/attachments/${pendingAttachment.id}.png`;
    expect((await app.server.inject({ method: "GET", url: pendingPath, headers: { cookie: alice.cookie } })).statusCode).toBe(200);
    expect((await app.server.inject({ method: "GET", url: pendingPath, headers: { cookie: eve.cookie } })).statusCode).toBe(404);
  });

  it("sweeps orphaned attachment files but keeps referenced and fresh-pending ones", async () => {
    const { app, dataDir } = await makeApp();
    const session = await newSession(app);
    const attachmentsDir = join(dataDir, "attachments");

    // Referenced file: attached to a message — must survive the sweep.
    const attached = await uploadAttachment(app, session.cookie);
    await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: session.cookie },
      payload: { type: "channelPost", channelId: "general", body: "", attachments: [attached] },
    });

    // Fresh pending upload: inside the grace period — must survive.
    const pending = await uploadAttachment(app, session.cookie);

    // Restart-orphan: a file on disk with no pending entry and no referencing message.
    mkdirSync(attachmentsDir, { recursive: true });
    const strayPath = join(attachmentsDir, "att_00000000000000ff.png");
    writeFileSync(strayPath, Buffer.from(tinyPng, "base64"));

    await app.reapOrphanedAttachments();

    expect(existsSync(join(attachmentsDir, `${attached.id}.png`))).toBe(true);
    expect(existsSync(join(attachmentsDir, `${pending.id}.png`))).toBe(true);
    expect(existsSync(strayPath)).toBe(false);
  });

  it("retries a transiently-failed sync attachment copy independently, without re-importing the message (docs/15 A6)", async () => {
    const source = await makeApp({ sync: { enabled: true, peers: [], intervalMs: 3_600_000 } });
    const sourceAdmin = await newSession(source);
    const attachment = await uploadAttachment(source, sourceAdmin.cookie);
    await source.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: sourceAdmin.cookie },
      payload: { type: "channelPost", channelId: "general", body: "", attachments: [attachment] },
    });

    const sourceFilePath = join(source.dataDir, "attachments", `${attachment.id}.png`);
    expect(existsSync(sourceFilePath)).toBe(true);

    // Simulate a transient failure: the peer's copy of the file is briefly unavailable (a hiccup, a
    // mid-write) at the moment the puller's sync round asks for it — the message itself still
    // imports (best-effort), but the attachment fetch throws.
    const bytes = readFileSync(sourceFilePath);
    rmSync(sourceFilePath);

    const sourceUrl = await source.server.listen({ port: 0, host: "127.0.0.1" });
    const puller = await makeApp({ sync: { enabled: true, peers: [{ url: sourceUrl }], intervalMs: 3_600_000 } });
    const pullerAdmin = await newSession(puller);

    const firstRun = (
      await puller.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie: pullerAdmin.cookie } })
    ).json() as { peers: { status?: { imported: number } }[] };
    const importedAfterFirstRun = firstRun.peers[0]?.status?.imported ?? -1;
    expect(importedAfterFirstRun).toBeGreaterThan(0); // the message (text) imported fine

    const pullerFilePath = join(puller.dataDir, "attachments", `${attachment.id}.png`);
    expect(existsSync(pullerFilePath)).toBe(false); // ...but the image is still missing

    // A second sync round is idempotent (the message id is already known — `imported` is a
    // cumulative counter, so it stays unchanged) and — this is the bug A6 fixes — on its own never
    // re-offers or re-fetches the attachment.
    const again = (
      await puller.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie: pullerAdmin.cookie } })
    ).json() as { peers: { status?: { imported: number } }[] };
    expect(again.peers[0]?.status?.imported).toBe(importedAfterFirstRun);
    expect(existsSync(pullerFilePath)).toBe(false);

    // The peer's file comes back (the transient failure resolves) — the independent retry pass
    // (NOT a re-import: no /api/admin/sync/run here) picks it up from the recorded work item.
    writeFileSync(sourceFilePath, bytes);
    await puller.retryMissingAttachments();

    expect(existsSync(pullerFilePath)).toBe(true);
    expect(readFileSync(pullerFilePath)).toEqual(bytes);

    // The work item is cleared on success — a further retry pass is a no-op, not a repeated fetch.
    await puller.retryMissingAttachments();
    expect(existsSync(pullerFilePath)).toBe(true);
  });

  it("F1: backs off between attempts, so a work item survives far more than the old fixed attempt cap without hitting its age bound", async () => {
    const source = await makeApp({ sync: { enabled: true, peers: [], intervalMs: 3_600_000 } });
    const sourceAdmin = await newSession(source);
    const attachment = await uploadAttachment(source, sourceAdmin.cookie);
    await source.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: sourceAdmin.cookie },
      payload: { type: "channelPost", channelId: "general", body: "", attachments: [attachment] },
    });

    // The peer's copy stays missing for the whole test — every retry attempt fails.
    rmSync(join(source.dataDir, "attachments", `${attachment.id}.png`));

    const sourceUrl = await source.server.listen({ port: 0, host: "127.0.0.1" });
    const puller = await makeApp({ sync: { enabled: true, peers: [{ url: sourceUrl }], intervalMs: 3_600_000 } });
    const pullerAdmin = await newSession(puller);
    await puller.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie: pullerAdmin.cookie } });
    expect(puller.store.loadMissingAttachments()).toHaveLength(1);

    // Simulate 25 reaper ticks back-to-back — more than the old fixed cap of 20 attempts, which used
    // to exhaust (and drop) the work item well before its days-scale age bound. With backoff, almost
    // all of these are throttled (skipped) instead of actually contacting the still-unreachable peer.
    for (let i = 0; i < 25; i += 1) {
      await puller.retryMissingAttachments();
    }

    const records = puller.store.loadMissingAttachments();
    expect(records).toHaveLength(1); // NOT given up — only the age bound (days) governs give-up now
    expect(records[0]?.attempts).toBeLessThan(5); // backoff meant most of the 25 ticks were skipped
  });

  it("F2: no-ops entirely when sync is disabled, without touching queued work items", async () => {
    const app = await makeApp({ sync: { enabled: false, peers: [{ url: "http://peer.example" }] } });
    app.store.addMissingAttachment({
      messageId: "msg_1",
      attachmentId: "att_1",
      mimeType: "image/png",
      peerUrl: "http://peer.example",
    });

    await app.retryMissingAttachments();

    const [record] = app.store.loadMissingAttachments();
    expect(record).toMatchObject({ messageId: "msg_1", attachmentId: "att_1", attempts: 0 });
  });

  it("F2: drops a queued retry immediately once its peer is removed from sync.peers, via the admin config PATCH", async () => {
    const app = await makeApp({ sync: { enabled: true, peers: [{ url: "http://peer.example" }] } });
    const admin = await newSession(app);
    app.store.addMissingAttachment({
      messageId: "msg_1",
      attachmentId: "att_1",
      mimeType: "image/png",
      peerUrl: "http://peer.example",
    });
    expect(app.store.loadMissingAttachments()).toHaveLength(1);

    const patch = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { sync: { peers: [] } },
    });
    expect(patch.statusCode).toBe(200);

    // Dropped immediately by the PATCH handler — no reaper tick needed.
    expect(app.store.loadMissingAttachments()).toEqual([]);
  });

  it("F2: retryMissingAttachments also defensively drops a record for a peer that isn't in the current sync.peers (belt-and-suspenders)", async () => {
    // A peer no longer in sync.peers — e.g. the config.json was edited between boots rather than via
    // the admin PATCH, so the PATCH-handler cleanup above never ran.
    const app = await makeApp({ sync: { enabled: true, peers: [{ url: "http://still-active.example" }] } });
    app.store.addMissingAttachment({
      messageId: "msg_1",
      attachmentId: "att_1",
      mimeType: "image/png",
      peerUrl: "http://long-gone.example",
    });

    await app.retryMissingAttachments();

    expect(app.store.loadMissingAttachments()).toEqual([]);
  });

  it("SF3: a tick overlapping an in-flight (slow) pass no-ops instead of running a second concurrent pass", async () => {
    // A local, definitely-unlistened port — the eventual peer fetch fails fast (ECONNREFUSED, no real
    // network/DNS involved), so the test stays quick while still giving the first pass a genuine async
    // suspension point (see below) to be "in flight" at.
    const unreachablePeerUrl = "http://127.0.0.1:39217";
    const app = await makeApp({ sync: { enabled: true, peers: [{ url: unreachablePeerUrl }] } });
    const admin = await newSession(app);

    // A record referencing a REAL local message (so it survives the F2b/message-exists checks and
    // reaches its first genuine `await` — `await stat(filePath)` on the still-missing file — instead of
    // being dropped synchronously). That's what makes the first call still "in flight" (suspended, not
    // yet past its `try`/`finally`) at the instant the second, overlapping call is fired.
    const posted = (await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: admin.cookie },
      payload: { type: "channelPost", channelId: "general", body: "carries a missing attachment" },
    })).json() as { message: { id: string } };

    app.store.addMissingAttachment({
      messageId: posted.message.id,
      attachmentId: "att_1",
      mimeType: "image/png",
      peerUrl: unreachablePeerUrl,
    });

    // A pass calls `store.loadDueMissingAttachments()` exactly once, synchronously, right at its start
    // (P2-2) — so counting calls to it distinguishes "a second pass actually ran" from "the mutex
    // no-op'd it".
    let calls = 0;
    const original = app.store.loadDueMissingAttachments.bind(app.store);
    app.store.loadDueMissingAttachments = (...args: Parameters<typeof original>): ReturnType<typeof original> => {
      calls += 1;
      return original(...args);
    };

    const first = app.retryMissingAttachments(); // synchronously runs up to `await stat(filePath)`, then suspends
    const second = app.retryMissingAttachments(); // fired while `first` is still in flight
    await Promise.all([first, second]);

    expect(calls).toBe(1);
    // The mutex was released once the (slow) first pass finished — a later, non-overlapping call runs
    // normally again.
    await app.retryMissingAttachments();
    expect(calls).toBe(2);
  });

  it("SF3: bounds work per pass at missingAttachmentMaxRecordsPerPass (25), leaving the rest for the next tick", async () => {
    const app = await makeApp({ sync: { enabled: true, peers: [{ url: "http://still-active.example" }] } });

    // All 30 point at a peer NOT in sync.peers, so every record the pass actually looks at is dropped
    // immediately (F2b) — a fast, deterministic way to observe exactly how many records one pass
    // touched, without any network mocking.
    for (let i = 0; i < 30; i += 1) {
      app.store.addMissingAttachment({
        messageId: `msg_${i}`,
        attachmentId: `att_${i}`,
        mimeType: "image/png",
        peerUrl: "http://long-gone.example",
      });
    }
    expect(app.store.loadMissingAttachments()).toHaveLength(30);

    await app.retryMissingAttachments();

    // Only the first 25 (the per-pass cap) were looked at and dropped; the remaining 5 are untouched.
    expect(app.store.loadMissingAttachments()).toHaveLength(5);

    // A second pass picks up where the first left off.
    await app.retryMissingAttachments();
    expect(app.store.loadMissingAttachments()).toEqual([]);
  });

  it("P2-2: the due set is looked at even when the first 25 (by creation order) are all still in backoff — no starvation", async () => {
    const app = await makeApp({ sync: { enabled: true, peers: [{ url: "http://still-active.example" }] } });

    // First 25 (in creation/rowid order) are all bumped into the future — deliberately still in backoff.
    for (let i = 0; i < 25; i += 1) {
      app.store.addMissingAttachment({
        messageId: `future_${i}`,
        attachmentId: "att",
        mimeType: "image/png",
        peerUrl: "http://long-gone.example", // dropped on sight (F2b) once actually looked at
      });
      app.store.bumpMissingAttachmentAttempts(`future_${i}`, "att", Date.now() + 3_600_000);
    }

    // Last 5 (created after) are due right now (default nextAttemptAt = 0).
    for (let i = 0; i < 5; i += 1) {
      app.store.addMissingAttachment({
        messageId: `due_${i}`,
        attachmentId: "att",
        mimeType: "image/png",
        peerUrl: "http://long-gone.example",
      });
    }

    expect(app.store.loadMissingAttachments()).toHaveLength(30);

    await app.retryMissingAttachments();

    // The old rowid-order slice-then-check-backoff logic looked at the first 25 (all still in backoff,
    // all skipped) and NEVER reached the 5 due records added after them — permanent starvation. The
    // fixed pass selects by due-ness (loadDueMissingAttachments), not creation order, so the 5 due ones
    // ARE processed (F2b drops them immediately — the peer is gone) while the 25 not-yet-due ones are
    // left untouched for a later tick.
    const remaining = app.store.loadMissingAttachments();
    expect(remaining).toHaveLength(25);
    expect(remaining.every((record) => record.messageId.startsWith("future_"))).toBe(true);
  });

  it("blocks a banned user from editing or deleting their old messages", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const target = await newSession(app);

    const posted = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: target.cookie },
      payload: { type: "channelPost", channelId: "general", body: "before the ban" },
    });
    const messageId = (posted.json() as { message: { id: string } }).message.id;

    await app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${target.userId}`,
      headers: { cookie: admin.cookie },
      payload: { banned: true },
    });

    const edit = await app.server.inject({
      method: "PATCH",
      url: `/api/messages/${messageId}`,
      headers: { cookie: target.cookie },
      payload: { body: "rewritten after the ban" },
    });
    expect(edit.statusCode).toBe(403);

    const remove = await app.server.inject({
      method: "DELETE",
      url: `/api/messages/${messageId}`,
      headers: { cookie: target.cookie },
    });
    expect(remove.statusCode).toBe(403);
  });

  it("keeps shadow-banned users' reactions out of the sync export", async () => {
    const app = await makeApp({ sync: { enabled: true, peers: [], intervalMs: 3_600_000 } });
    const admin = await newSession(app);
    const shadowed = await newSession(app);

    const posted = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: admin.cookie },
      payload: { type: "channelPost", channelId: "general", body: "react to me" },
    });
    const messageId = (posted.json() as { message: { id: string } }).message.id;

    const reacted = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: shadowed.cookie },
      payload: { type: "reaction", targetMessageId: messageId, reaction: "👍" },
    });
    const reactionId = (reacted.json() as { message: { id: string } }).message.id;

    await app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${shadowed.userId}`,
      headers: { cookie: admin.cookie },
      payload: { shadowBanned: true },
    });

    const digest = (await app.server.inject({ method: "GET", url: "/api/sync/digest" })).json() as {
      messages: { id: string }[];
    };
    expect(digest.messages.some((entry) => entry.id === messageId)).toBe(true);
    expect(digest.messages.some((entry) => entry.id === reactionId)).toBe(false);
  });

  it("refuses to import a reply whose parent was tombstoned locally", async () => {
    const source = await makeApp({ sync: { enabled: true, peers: [], intervalMs: 3_600_000 } });
    const sourceAdmin = await newSession(source);
    const parentPost = await source.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: sourceAdmin.cookie },
      payload: { type: "channelPost", channelId: "general", body: "thread root" },
    });
    const parentId = (parentPost.json() as { message: { id: string } }).message.id;
    const sourceUrl = await source.server.listen({ port: 0, host: "127.0.0.1" });

    const puller = await makeApp({
      sync: { enabled: true, peers: [{ url: sourceUrl }], intervalMs: 3_600_000 },
    });
    const pullerAdmin = await newSession(puller);
    await puller.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie: pullerAdmin.cookie } });

    // The puller deletes the imported thread root (tombstoning it)...
    await puller.server.inject({
      method: "DELETE",
      url: `/api/messages/${parentId}`,
      headers: { cookie: pullerAdmin.cookie },
    });

    // ...then the source grows a reply under that root.
    await source.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: sourceAdmin.cookie },
      payload: { type: "channelReply", channelId: "general", parentMessageId: parentId, body: "late reply" },
    });

    await puller.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie: pullerAdmin.cookie } });

    const bodies = (
      (
        await puller.server.inject({ method: "GET", url: "/api/messages/general", headers: { cookie: pullerAdmin.cookie } })
      ).json() as { body?: string }[]
    ).map((message) => message.body ?? "");
    expect(bodies).not.toContain("thread root");
    expect(bodies).not.toContain("late reply");
  });
});

describe("ready-for-use features (node name, promotion, presence)", () => {
  it("serves and hot-updates the configurable network name", async () => {
    const app = await makeApp();
    const admin = await newSession(app);

    const before = (await app.server.inject({ method: "GET", url: "/api/config", headers: { cookie: admin.cookie } })).json() as {
      nodeName: string;
      networkConfig: { nodeName: string };
    };
    expect(before.nodeName).toBe("LOAM local");
    expect(before.networkConfig.nodeName).toBe("LOAM local");

    const patch = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { node: { name: "Sector 7 Relief Net" } },
    });
    expect(patch.statusCode).toBe(200);

    const after = (await app.server.inject({ method: "GET", url: "/api/config", headers: { cookie: admin.cookie } })).json() as {
      nodeName: string;
      networkConfig: { nodeName: string };
    };
    expect(after.nodeName).toBe("Sector 7 Relief Net");
    expect(after.networkConfig.nodeName).toBe("Sector 7 Relief Net");
  });

  it("serves and hot-updates the node UI locale", async () => {
    const app = await makeApp();
    const admin = await newSession(app);

    const before = (
      await app.server.inject({ method: "GET", url: "/api/config", headers: { cookie: admin.cookie } })
    ).json() as { networkConfig: { locale: string } };
    expect(before.networkConfig.locale).toBe("en");

    const patch = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { node: { locale: "ar" } },
    });
    expect(patch.statusCode).toBe(200);

    const after = (
      await app.server.inject({ method: "GET", url: "/api/config", headers: { cookie: admin.cookie } })
    ).json() as { networkConfig: { locale: string } };
    expect(after.networkConfig.locale).toBe("ar");

    const rejected = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { node: { locale: "xx" } },
    });
    expect(rejected.statusCode).toBe(400);
  });

  it("attaches a stable snake_case error code alongside the English error message", async () => {
    const app = await makeApp();
    await newSession(app); // first session claims the firstUser admin grant
    const user = await newSession(app); // this one is a plain member

    // A non-admin hitting an admin-only route gets the localizable code plus the English fallback.
    const denied = await app.server.inject({
      method: "GET",
      url: "/api/admin/config",
      headers: { cookie: user.cookie },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: "Admin access required", code: "admin_required" });

    // A 404 for an unknown channel carries the not-found code.
    const missing = await app.server.inject({
      method: "GET",
      url: "/api/messages/does-not-exist",
      headers: { cookie: user.cookie },
    });
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as { code?: string }).code).toBe("channel_not_found");
  });

  it("codes the participation-gate and channel-posting-policy errors (were English-only)", async () => {
    const app = await makeApp({ access: { joinPolicy: "approval" } });
    const admin = await newSession(app);
    const pending = await newSession(app); // under approval policy, starts pending

    // A pending user hitting a mutating endpoint: the gate message now carries a code to localize.
    const gated = await app.server.inject({
      method: "GET",
      url: "/api/channels",
      headers: { cookie: pending.cookie },
    });
    expect(gated.statusCode).toBe(403);
    expect((gated.json() as { code?: string }).code).toBe("awaiting_approval");

    // Channel-posting policy: an admins-only channel rejects a member's post with a code.
    await app.server.inject({
      method: "POST",
      url: `/api/access/users/${pending.userId}/approve`,
      headers: { cookie: admin.cookie },
    });
    const created = await app.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie: admin.cookie },
      payload: { name: "Announce", allowPosting: "admins" },
    });
    const channelId = (created.json() as { id: string }).id;
    const post = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: pending.cookie },
      payload: { type: "channelPost", channelId, body: "hi" },
    });
    expect(post.statusCode).toBe(400);
    expect((post.json() as { code?: string }).code).toBe("channel_admins_post_only");
  });

  it("surfaces the node version in /api/config", async () => {
    // makeApp builds with no version option, so it reports the "dev" fallback.
    const app = await makeApp();
    const dev = (await app.server.inject({ method: "GET", url: "/api/config" })).json() as { version: string };
    expect(dev.version).toBe("dev");

    // An explicit version (as server.ts / the npm CLI inject) is echoed back verbatim.
    const dataDir = mkdtempSync(join(tmpdir(), "loam-app-test-"));
    const versioned = await buildApp({ dataDir, logger: false, version: "9.9.9" });
    cleanups.push(async () => {
      await versioned.close();
      rmSync(dataDir, { recursive: true, force: true });
    });
    const reported = (await versioned.server.inject({ method: "GET", url: "/api/config" })).json() as { version: string };
    expect(reported.version).toBe("9.9.9");
  });

  it("lets an admin promote a member, but not non-admins, bots, or pending users", async () => {
    const app = await makeApp({
      access: { joinPolicy: "approval" },
      // Enable the LLM so the bot user exists, to exercise the type !== "human" guard below.
      llm: { ollama: { enabled: true, baseUrl: "http://localhost:11434", model: "m", botId: "bot.test", botDisplayName: "Bot" } },
    });
    const admin = await newSession(app);
    const member = await newSession(app);
    const pendingUser = await newSession(app);

    await app.server.inject({
      method: "POST",
      url: `/api/access/users/${member.userId}/approve`,
      headers: { cookie: admin.cookie },
    });

    // A bot can never be promoted to admin (only people can be admins).
    const bot = await app.server.inject({
      method: "POST",
      url: "/api/admin/users/bot.test/promote",
      headers: { cookie: admin.cookie },
    });
    expect(bot.statusCode).toBe(400);

    // A plain member cannot promote anyone.
    const forbidden = await app.server.inject({
      method: "POST",
      url: `/api/admin/users/${admin.userId}/promote`,
      headers: { cookie: member.cookie },
    });
    expect(forbidden.statusCode).toBe(403);

    // Pending users must be approved first.
    const early = await app.server.inject({
      method: "POST",
      url: `/api/admin/users/${pendingUser.userId}/promote`,
      headers: { cookie: admin.cookie },
    });
    expect(early.statusCode).toBe(400);

    const promoted = await app.server.inject({
      method: "POST",
      url: `/api/admin/users/${member.userId}/promote`,
      headers: { cookie: admin.cookie },
    });
    expect(promoted.statusCode).toBe(200);
    expect((promoted.json() as { isAdmin: boolean }).isAdmin).toBe(true);

    // The promotion persisted and the new admin has admin powers.
    const config = await app.server.inject({
      method: "GET",
      url: "/api/admin/config",
      headers: { cookie: member.cookie },
    });
    expect(config.statusCode).toBe(200);
  });

  it("broadcasts presence on connect/disconnect and stays silent when disabled", async () => {
    const app = await makeApp();
    const alice = await newSession(app);
    const bob = await newSession(app);
    const baseUrl = await app.server.listen({ port: 0, host: "127.0.0.1" });

    const connect = (cookie: string) =>
      new Promise<{ socket: WebSocket; events: { type?: string; onlineUserIds?: string[] }[] }>((resolve, reject) => {
        const socket = new (WebSocket as unknown as new (url: string, opts: unknown) => WebSocket)(
          `${baseUrl.replace("http", "ws")}/ws`,
          { headers: { cookie } },
        );
        const events: { type?: string; onlineUserIds?: string[] }[] = [];
        socket.addEventListener("message", (event) =>
          events.push(JSON.parse(String((event as MessageEvent).data)) as { type?: string }),
        );
        socket.addEventListener("open", () => resolve({ socket, events }));
        socket.addEventListener("error", () => reject(new Error("connect failed")));
      });

    const waitUntil = async (check: () => boolean) => {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline && !check()) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return check();
    };

    const aliceSocket = await connect(alice.cookie);
    const bobSocket = await connect(bob.cookie);

    // Alice hears that Bob came online (a presence event listing both ids).
    expect(
      await waitUntil(() =>
        aliceSocket.events.some(
          (event) =>
            event.type === "presence" &&
            !!event.onlineUserIds?.includes(alice.userId) &&
            !!event.onlineUserIds?.includes(bob.userId),
        ),
      ),
    ).toBe(true);

    // Presence lists visible users only: a banned user is excluded. Bring Dana online, confirm she
    // shows, then have admin-Alice ban her — Alice's next presence event drops her.
    const dana = await newSession(app);
    const danaSocket = await connect(dana.cookie);
    expect(
      await waitUntil(() =>
        aliceSocket.events.some(
          (event) => event.type === "presence" && !!event.onlineUserIds?.includes(dana.userId),
        ),
      ),
    ).toBe(true);
    await app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${dana.userId}`,
      headers: { cookie: alice.cookie },
      payload: { banned: true },
    });
    expect(
      await waitUntil(() => {
        const last = [...aliceSocket.events].reverse().find((event) => event.type === "presence");
        return !!last && !last.onlineUserIds?.includes(dana.userId);
      }),
    ).toBe(true);
    danaSocket.socket.close();

    // Bob disconnects; Alice's next presence event no longer lists him.
    bobSocket.socket.close();
    expect(
      await waitUntil(() => {
        const last = [...aliceSocket.events].reverse().find((event) => event.type === "presence");
        return !!last && !last.onlineUserIds?.includes(bob.userId);
      }),
    ).toBe(true);
    aliceSocket.socket.close();

    // With the flag off, no presence events are emitted at all.
    const silent = await makeApp({ features: { enablePresence: false } });
    const carol = await newSession(silent);
    const silentUrl = await silent.server.listen({ port: 0, host: "127.0.0.1" });
    const carolSocket = await new Promise<{ socket: WebSocket; events: { type?: string }[] }>((resolve, reject) => {
      const socket = new (WebSocket as unknown as new (url: string, opts: unknown) => WebSocket)(
        `${silentUrl.replace("http", "ws")}/ws`,
        { headers: { cookie: carol.cookie } },
      );
      const events: { type?: string }[] = [];
      socket.addEventListener("message", (event) => events.push(JSON.parse(String((event as MessageEvent).data)) as { type?: string }));
      socket.addEventListener("open", () => resolve({ socket, events }));
      socket.addEventListener("error", () => reject(new Error("connect failed")));
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(carolSocket.events.some((event) => event.type === "presence")).toBe(false);
    carolSocket.socket.close();
  });
});

describe("security hardening", () => {
  it("GET /api/health returns ok without minting a session or consuming firstUser admin", async () => {
    const app = await makeApp();

    const health = await app.server.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ ok: true });
    expect(health.headers["set-cookie"]).toBeUndefined();

    const first = await newSession(app);
    expect(first.isAdmin).toBe(true);
  });

  it("sets security headers (nosniff always, CSP on the app shell only)", async () => {
    const app = await makeApp();

    const api = await app.server.inject({ method: "GET", url: "/api/health" });
    expect(api.headers["x-content-type-options"]).toBe("nosniff");
    expect(api.headers["content-security-policy"]).toBeUndefined();

    const shell = await app.server.inject({ method: "GET", url: "/" });
    expect(shell.headers["x-content-type-options"]).toBe("nosniff");
    expect(String(shell.headers["content-security-policy"])).toContain("frame-ancestors 'none'");
  });

  it("blocks a banned user from editing their profile", async () => {
    const app = await makeApp({ identity: { allowUserDisplayNameEdit: true } });
    const admin = await newSession(app);
    const target = await newSession(app);

    await app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${target.userId}`,
      headers: { cookie: admin.cookie },
      payload: { banned: true },
    });

    const edit = await app.server.inject({
      method: "PATCH",
      url: "/api/users/me",
      headers: { cookie: target.cookie },
      payload: { displayName: "Ban Evader" },
    });
    expect(edit.statusCode).toBe(403);
  });

  it("rejects an over-long message body but keeps normal ones", async () => {
    const app = await makeApp();
    const session = await newSession(app);

    const huge = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: session.cookie },
      payload: { type: "channelPost", channelId: "general", body: "x".repeat(8001) },
    });
    expect(huge.statusCode).toBe(400);

    const ok = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: session.cookie },
      payload: { type: "channelPost", channelId: "general", body: "x".repeat(8000) },
    });
    expect(ok.statusCode).toBe(201);
  });

  it("does not mark the session cookie Secure on the plain-http LAN", async () => {
    // The injected request is plain http (no TLS socket, trustProxy off), so the cookie must NOT be
    // Secure — a Secure cookie would be dropped by the browser and break the session. The flag
    // flips only when request.protocol is genuinely https (a self-hoster behind a TLS proxy enables
    // trustProxy for that); we deliberately don't trust a spoofable x-forwarded-proto header.
    const app = await makeApp();

    const plain = await app.server.inject({ method: "GET", url: "/api/config" });
    expect(String(plain.headers["set-cookie"])).toContain("loam_session=");
    expect(String(plain.headers["set-cookie"])).not.toContain("Secure");
  });
});

describe("sync peer authentication (shared token)", () => {
  const TOKEN = "mesh-shared-secret-token-01";

  function digest(app: LoamApp, token?: string): Promise<InjectResponse> {
    return app.server.inject({
      method: "GET",
      url: "/api/sync/digest",
      headers: token ? { "x-loam-sync-token": token } : {},
    });
  }

  it("serves the digest openly when no token is configured", async () => {
    const app = await makeApp({ sync: { enabled: true } });
    expect((await digest(app)).statusCode).toBe(200);
  });

  it("404s an unauthenticated or wrong-token peer, 200s the right token", async () => {
    const app = await makeApp({ sync: { enabled: true, token: TOKEN } });

    // Missing token and wrong token both look exactly like sync being disabled (404) — a prober
    // can't tell a token-guarded node from one without the feature.
    expect((await digest(app)).statusCode).toBe(404);
    expect((await digest(app, "not-the-token-xxxxxxxxxx")).statusCode).toBe(404);
    expect((await digest(app, TOKEN)).statusCode).toBe(200);
  });

  it("gates the messages endpoint on the same token", async () => {
    const app = await makeApp({ sync: { enabled: true, token: TOKEN } });

    const unauth = await app.server.inject({
      method: "POST",
      url: "/api/sync/messages",
      payload: { ids: ["message.unknown"] },
    });
    expect(unauth.statusCode).toBe(404);

    const authed = await app.server.inject({
      method: "POST",
      url: "/api/sync/messages",
      headers: { "x-loam-sync-token": TOKEN },
      payload: { ids: ["message.unknown"] },
    });
    expect(authed.statusCode).toBe(200);
    expect((authed.json() as { messages: unknown[] }).messages).toEqual([]);
  });

  it("clears the token when an admin PATCHes it to an empty string", async () => {
    const app = await makeApp({ sync: { enabled: true, token: TOKEN } });
    const admin = await newSession(app);

    // Confirmed guarded first.
    expect((await digest(app)).statusCode).toBe(404);

    const patch = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { sync: { token: "" } },
    });
    expect(patch.statusCode).toBe(200);

    // Token cleared → open again.
    expect((await digest(app)).statusCode).toBe(200);
  });

  it("attaches the configured token to outbound pulls (two-node end-to-end)", async () => {
    const meshToken = "mesh-shared-secret-token-02";

    // Peer node: token-guarded, offering one public channel + message.
    const peer = await makeApp({ sync: { enabled: true, token: meshToken } });
    const peerAdmin = await newSession(peer);
    const channel = (
      await peer.server.inject({
        method: "POST",
        url: "/api/channels",
        headers: { cookie: peerAdmin.cookie },
        payload: { name: "Mesh News" },
      })
    ).json() as { id: string };
    await peer.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: peerAdmin.cookie },
      payload: { type: "channelPost", channelId: channel.id, body: "hello from the peer" },
    });
    const peerUrl = await peer.server.listen({ host: "127.0.0.1", port: 0 });

    // A puller with the MATCHING token imports the peer's message — only possible if the pull loop
    // attached x-loam-sync-token (the peer 404s the digest otherwise).
    const puller = await makeApp({ sync: { enabled: true, token: meshToken, peers: [{ url: peerUrl }] } });
    const pullerAdmin = await newSession(puller);
    const run = await puller.server.inject({
      method: "POST",
      url: "/api/admin/sync/run",
      headers: { cookie: pullerAdmin.cookie },
    });
    expect(run.statusCode).toBe(200);
    const pulled = (
      await puller.server.inject({
        method: "GET",
        url: `/api/messages/${channel.id}`,
        headers: { cookie: pullerAdmin.cookie },
      })
    ).json() as { body: string }[];
    expect(pulled.some((message) => message.body === "hello from the peer")).toBe(true);

    // A puller with the WRONG token gets nothing — the peer really gates on the exact token, so the
    // channel is never imported and its messages 404 (existence is not leaked).
    const badPuller = await makeApp({
      sync: { enabled: true, token: "wrong-token-abcdefghij", peers: [{ url: peerUrl }] },
    });
    const badAdmin = await newSession(badPuller);
    await badPuller.server.inject({
      method: "POST",
      url: "/api/admin/sync/run",
      headers: { cookie: badAdmin.cookie },
    });
    const none = await badPuller.server.inject({
      method: "GET",
      url: `/api/messages/${channel.id}`,
      headers: { cookie: badAdmin.cookie },
    });
    expect(none.statusCode).toBe(404);
  });

  it("refuses to import messages attributed to a locally-authoritative identity (anti-impersonation)", async () => {
    const peer = await makeApp({ sync: { enabled: true } });
    const peerAdmin = await newSession(peer);
    const channel = (
      await peer.server.inject({
        method: "POST",
        url: "/api/channels",
        headers: { cookie: peerAdmin.cookie },
        payload: { name: "Mesh" },
      })
    ).json() as { id: string };
    const post = (body: string) =>
      peer.server.inject({
        method: "POST",
        url: "/api/messages",
        headers: { cookie: peerAdmin.cookie },
        payload: { type: "channelPost", channelId: channel.id, body },
      });
    await post("m1");
    const peerUrl = await peer.server.listen({ host: "127.0.0.1", port: 0 });

    const puller = await makeApp({ sync: { enabled: true, peers: [{ url: peerUrl }] } });
    const pullerAdmin = await newSession(puller);
    const sync = () =>
      puller.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie: pullerAdmin.cookie } });
    const bodies = async (): Promise<string[]> =>
      (
        (
          await puller.server.inject({
            method: "GET",
            url: `/api/messages/${channel.id}`,
            headers: { cookie: pullerAdmin.cookie },
          })
        ).json() as { body?: string }[]
      ).map((message) => message.body ?? "");

    // First sync imports m1 and creates a local (authority-stripped) copy of the peer's author.
    await sync();
    expect(await bodies()).toContain("m1");

    // Promote that imported identity to a LOCAL admin — its id is now locally authoritative.
    const promote = await puller.server.inject({
      method: "POST",
      url: `/api/admin/users/${peerAdmin.userId}/promote`,
      headers: { cookie: pullerAdmin.cookie },
    });
    expect(promote.statusCode).toBe(200);

    // A further message the peer serves under that same id is now refused — a peer can't inject
    // content that renders as authored by an identity this node treats as an authority.
    await post("m2");
    await sync();
    const seen = await bodies();
    expect(seen).toContain("m1"); // the pre-promotion import stays
    expect(seen).not.toContain("m2"); // the impersonating message is dropped
  });
});

describe("anonymous identity minting limit", () => {
  it("429s new identities from one IP past the cap but lets cookie'd requests through", async () => {
    const app = await makeApp(undefined, { maxNewIdentitiesPerWindow: 3 });

    const first = await app.server.inject({ method: "GET", url: "/api/config" });
    expect(first.statusCode).toBe(200);
    const cookie = sessionCookie(first);

    // Two more fresh mints (count 2, 3) are allowed; the 4th cookieless request exceeds the cap.
    expect((await app.server.inject({ method: "GET", url: "/api/config" })).statusCode).toBe(200);
    expect((await app.server.inject({ method: "GET", url: "/api/config" })).statusCode).toBe(200);
    expect((await app.server.inject({ method: "GET", url: "/api/config" })).statusCode).toBe(429);

    // A request that carries an existing session cookie mints nothing, so it's unaffected.
    const returning = await app.server.inject({ method: "GET", url: "/api/config", headers: { cookie } });
    expect(returning.statusCode).toBe(200);
  });
});

describe("on-device LLM provider", () => {
  const BOT_ID = "llm.ollama.gemma4"; // shared bot identity, default botId

  afterEach(() => {
    delete (globalThis as { __loamOnDeviceChat?: unknown }).__loamOnDeviceChat;
  });

  async function assistantReply(app: LoamApp, cookie: string): Promise<string | undefined> {
    // The bot reply is created + streamed asynchronously after the DM POST returns; poll the thread.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const thread = (
        await app.server.inject({ method: "GET", url: `/api/dms/${BOT_ID}`, headers: { cookie } })
      ).json() as { authorId: string; body?: string }[];
      const reply = thread.find((message) => message.authorId === BOT_ID && (message.body ?? "").length > 0);
      if (reply) {
        return reply.body;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return undefined;
  }

  it("streams a reply from the on-device hook, persists it, and shows the bot when enabled", async () => {
    (globalThis as { __loamOnDeviceChat?: unknown }).__loamOnDeviceChat = (
      _messages: unknown,
      callbacks: { onDelta: (t: string) => void; onEnd: () => void; onError: (m: string) => void },
    ) => {
      callbacks.onDelta("Hello ");
      callbacks.onDelta("from the phone");
      callbacks.onEnd();
    };

    const app = await makeApp({ llm: { onDevice: { enabled: true, model: "gemma-test" } } });
    const user = await newSession(app);

    // The bot DM contact appears once a backend is enabled (here: on-device, with Ollama still off).
    const users = (
      await app.server.inject({ method: "GET", url: "/api/users", headers: { cookie: user.cookie } })
    ).json() as { id: string; type: string }[];
    expect(users.some((entry) => entry.id === BOT_ID && entry.type === "bot")).toBe(true);

    const dm = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: user.cookie },
      payload: { type: "dm", recipientUserId: BOT_ID, body: "hi" },
    });
    expect(dm.statusCode).toBe(201);

    expect(await assistantReply(app, user.cookie)).toBe("Hello from the phone");
  });

  it("degrades to a graceful error when no on-device hook is present (e.g. desktop/CI)", async () => {
    // No globalThis.__loamOnDeviceChat installed — every non-Android host.
    const app = await makeApp({ llm: { onDevice: { enabled: true, model: "gemma-test" } } });
    const user = await newSession(app);

    await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: user.cookie },
      payload: { type: "dm", recipientUserId: BOT_ID, body: "hi" },
    });

    const reply = await assistantReply(app, user.cookie);
    expect(reply).toMatch(/LLM error/i);
    expect(reply).toMatch(/not available/i);
  });

  it("keeps the bot hidden and does not respond when no backend is enabled (default)", async () => {
    const app = await makeApp();
    const user = await newSession(app);

    const users = (
      await app.server.inject({ method: "GET", url: "/api/users", headers: { cookie: user.cookie } })
    ).json() as { id: string }[];
    expect(users.some((entry) => entry.id === BOT_ID)).toBe(false);
  });
});

describe("Ollama LLM streaming (docs/15 #15)", () => {
  const BOT_ID = "llm.ollama.gemma4"; // shared bot identity, default botId

  /** The bot reply is created + streamed asynchronously after the DM POST returns; poll for it to
   * settle (a body present and no longer marked `streaming`), mirroring the on-device helper above. */
  async function settledAssistantReply(
    app: LoamApp,
    cookie: string,
  ): Promise<{ body?: string; streaming?: boolean } | undefined> {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const thread = (
        await app.server.inject({ method: "GET", url: `/api/dms/${BOT_ID}`, headers: { cookie } })
      ).json() as { authorId: string; body?: string; meta?: { streaming?: boolean } }[];
      const reply = thread.find((message) => message.authorId === BOT_ID && (message.body ?? "").length > 0);
      if (reply && reply.meta?.streaming !== true) {
        return { body: reply.body, streaming: reply.meta?.streaming };
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return undefined;
  }

  it("degrades to a graceful assistant error when Ollama is unreachable, without crashing the server", async () => {
    const app = await makeApp({ llm: { ollama: { enabled: true, baseUrl: await unusedLocalUrl() } } });
    const user = await newSession(app);

    const dm = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: user.cookie },
      payload: { type: "dm", recipientUserId: BOT_ID, body: "hi" },
    });
    // The POST itself never fails because of a bad LLM backend — the failure surfaces async, in the
    // assistant's own reply, exactly like an on-device hook failure.
    expect(dm.statusCode).toBe(201);

    const reply = await settledAssistantReply(app, user.cookie);
    expect(reply?.body).toMatch(/LLM error/i);

    // The server itself stayed healthy — an unrelated request right after still succeeds.
    expect((await app.server.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
  });

  it("gates the bot contact and enableLLMChat/enableLLMStreaming on llm.ollama.enabled", async () => {
    const disabledApp = await makeApp();
    const disabledUser = await newSession(disabledApp);

    const disabledConfig = (
      await disabledApp.server.inject({
        method: "GET",
        url: "/api/config",
        headers: { cookie: disabledUser.cookie },
      })
    ).json() as { networkConfig: { enableLLMChat: boolean; enableLLMStreaming: boolean } };
    expect(disabledConfig.networkConfig.enableLLMChat).toBe(false);
    expect(disabledConfig.networkConfig.enableLLMStreaming).toBe(false);

    const disabledUsers = (
      await disabledApp.server.inject({ method: "GET", url: "/api/users", headers: { cookie: disabledUser.cookie } })
    ).json() as { id: string }[];
    expect(disabledUsers.some((entry) => entry.id === BOT_ID)).toBe(false);

    // With no backend enabled the bot doesn't exist at all, so a DM "to" its id is just a DM to a
    // nonexistent recipient — no assistant reply is ever triggered.
    const blindDm = await disabledApp.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: disabledUser.cookie },
      payload: { type: "dm", recipientUserId: BOT_ID, body: "hi" },
    });
    expect(blindDm.statusCode).toBe(400);

    const ollama = startMockOllama(["hi there"]);
    cleanups.push(ollama.close);
    const enabledApp = await makeApp({ llm: { ollama: { enabled: true, baseUrl: await ollama.url } } });
    const enabledUser = await newSession(enabledApp);

    const enabledConfig = (
      await enabledApp.server.inject({ method: "GET", url: "/api/config", headers: { cookie: enabledUser.cookie } })
    ).json() as { networkConfig: { enableLLMChat: boolean; enableLLMStreaming: boolean } };
    expect(enabledConfig.networkConfig.enableLLMChat).toBe(true);
    expect(enabledConfig.networkConfig.enableLLMStreaming).toBe(true);

    const enabledUsers = (
      await enabledApp.server.inject({ method: "GET", url: "/api/users", headers: { cookie: enabledUser.cookie } })
    ).json() as { id: string; type: string }[];
    expect(enabledUsers.some((entry) => entry.id === BOT_ID && entry.type === "bot")).toBe(true);
  });
});

describe("opportunistic mesh: sealed mailbox (docs/16)", () => {
  const MESH = { enabled: true, relay: true, ttlMs: 3_600_000, hopLimit: 6, maxCarried: 1000, maxContacts: 1000 };

  function listen(app: LoamApp): Promise<string> {
    return app.server.listen({ host: "127.0.0.1", port: 0 });
  }
  async function adminOf(app: LoamApp): Promise<{ cookie: string; userId: string }> {
    const session = await newSession(app);
    return { cookie: session.cookie, userId: session.userId };
  }
  function setPeers(app: LoamApp, cookie: string, urls: string[]): Promise<InjectResponse> {
    return app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie },
      payload: { sync: { peers: urls.map((url) => ({ url })) } },
    });
  }
  function syncNow(app: LoamApp, cookie: string): Promise<InjectResponse> {
    return app.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie } });
  }
  async function roster(app: LoamApp, cookie: string): Promise<{ id: string }[]> {
    return (await app.server.inject({ method: "GET", url: "/api/users", headers: { cookie } })).json() as {
      id: string;
    }[];
  }
  async function dmBodies(app: LoamApp, cookie: string, peerId: string): Promise<string[]> {
    return (
      (
        await app.server.inject({ method: "GET", url: `/api/dms/${peerId}`, headers: { cookie } })
      ).json() as { body?: string }[]
    ).map((message) => message.body ?? "");
  }
  /** Fetch a user's shareable mesh identity card (the out-of-band contact exchange). */
  async function meshCard(app: LoamApp, cookie: string): Promise<MeshIdentityCard> {
    const res = await app.server.inject({ method: "GET", url: "/api/mesh/identity", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    return MeshIdentityCardSchema.parse(res.json());
  }
  /** Add a mesh card to the caller's address book (POST /api/mesh/contacts). */
  function addContact(app: LoamApp, cookie: string, card: MeshIdentityCard): Promise<InjectResponse> {
    return app.server.inject({ method: "POST", url: "/api/mesh/contacts", headers: { cookie }, payload: card });
  }

  it("404s /api/mesh/messages when mesh is disabled", async () => {
    const app = await makeApp();
    const user = await newSession(app);
    const res = await app.server.inject({
      method: "POST",
      url: "/api/mesh/messages",
      headers: { cookie: user.cookie },
      payload: { toMeshId: "mesh.absent", body: "hi" },
    });
    expect(res.statusCode).toBe(404);
    // The whole mesh surface is absent when disabled — identity + contacts too.
    expect((await app.server.inject({ method: "GET", url: "/api/mesh/identity", headers: { cookie: user.cookie } })).statusCode).toBe(404);
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: "/api/mesh/contacts",
          headers: { cookie: user.cookie },
          payload: { meshId: "mesh.absent", alg: "ed25519", sign: "AA", kx: "AA", kxSig: "AA", mailboxToken: "AA" },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("delivers sealed mail to a contact as a DM (card exchange + seal + open on one node)", async () => {
    const app = await makeApp({ mesh: MESH });
    const alice = await newSession(app);
    const bob = await newSession(app); // both get mesh identities via the session hook

    // Alice adds Bob out-of-band (his card), then seals to his self-certifying mesh id.
    const bobCard = await meshCard(app, bob.cookie);
    expect((await addContact(app, alice.cookie, bobCard)).statusCode).toBe(200);

    const send = await app.server.inject({
      method: "POST",
      url: "/api/mesh/messages",
      headers: { cookie: alice.cookie },
      payload: { toMeshId: bobCard.meshId, body: "meet at the old bridge" },
    });
    expect(send.statusCode).toBe(200);

    // Delivery creates a "mesh.<sender>" contact and a DM to Bob from it.
    const contact = (await roster(app, bob.cookie)).find((entry) => entry.id.startsWith("mesh."));
    expect(contact).toBeDefined();
    expect(await dmBodies(app, bob.cookie, contact!.id)).toContain("meet at the old bridge");
  });

  it("keeps a mesh sender off the shared roster — visible only to the recipient it mailed", async () => {
    const app = await makeApp({ mesh: MESH });
    const alice = await newSession(app);
    const bob = await newSession(app);
    const carol = await newSession(app); // uninvolved third party on the same node

    const bobCard = await meshCard(app, bob.cookie);
    expect((await addContact(app, alice.cookie, bobCard)).statusCode).toBe(200);
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: "/api/mesh/messages",
          headers: { cookie: alice.cookie },
          payload: { toMeshId: bobCard.meshId, body: "quiet word" },
        })
      ).statusCode,
    ).toBe(200);

    // Bob (the recipient) resolves the mesh sender in his roster...
    expect((await roster(app, bob.cookie)).some((entry) => entry.id.startsWith("mesh."))).toBe(true);
    // ...but Carol never learns a mesh sender appeared (no leak that Bob received sealed mail).
    expect((await roster(app, carol.cookie)).some((entry) => entry.id.startsWith("mesh."))).toBe(false);
  });

  it("404s a send to a mesh id that isn't a contact (sealing requires an added card)", async () => {
    const app = await makeApp({ mesh: MESH });
    const alice = await newSession(app);
    const bob = await newSession(app);
    const bobCard = await meshCard(app, bob.cookie);
    // Alice never added Bob → cannot seal to him even though his id self-certifies.
    const send = await app.server.inject({
      method: "POST",
      url: "/api/mesh/messages",
      headers: { cookie: alice.cookie },
      payload: { toMeshId: bobCard.meshId, body: "hi" },
    });
    expect(send.statusCode).toBe(404);
  });

  it("rejects a forged mesh card (id/key mismatch and bad kx binding) so it can't be sealed to", async () => {
    const app = await makeApp({ mesh: MESH });
    const alice = await newSession(app);
    const bob = await newSession(app);
    const mallory = await newSession(app);
    const bobCard = await meshCard(app, bob.cookie);
    const malloryCard = await meshCard(app, mallory.cookie);

    // Substitution attempt: Bob's id but Mallory's keys — meshId no longer derives from `sign`.
    const forgedId = { ...malloryCard, meshId: bobCard.meshId };
    expect((await addContact(app, alice.cookie, forgedId)).statusCode).toBe(400);

    // Tampered binding: valid id/sign, but kx swapped for Mallory's (kxSig no longer binds).
    const forgedKx = { ...bobCard, kx: malloryCard.kx };
    expect((await addContact(app, alice.cookie, forgedKx)).statusCode).toBe(400);

    // Neither forgery was stored, so a send to Bob's id 404s (no contact).
    const send = await app.server.inject({
      method: "POST",
      url: "/api/mesh/messages",
      headers: { cookie: alice.cookie },
      payload: { toMeshId: bobCard.meshId, body: "hijack" },
    });
    expect(send.statusCode).toBe(404);
  });

  it("rejects a malformed mesh card (non-base64url key field) with 400, never a 500", async () => {
    const app = await makeApp({ mesh: MESH });
    const alice = await newSession(app);
    const bob = await newSession(app);
    const bobCard = await meshCard(app, bob.cookie);

    // A garbage `sign`/`mailboxToken` would otherwise reach the crypto's base64url decoder (which
    // throws) — the schema must reject it at the boundary as a clean 400.
    for (const bad of [
      { ...bobCard, sign: "!!!not-base64!!!" },
      { ...bobCard, mailboxToken: "has spaces" },
    ]) {
      expect((await addContact(app, alice.cookie, bad)).statusCode).toBe(400);
    }
    // And no forged card was stored, so a later send to Bob's id still 404s (no 500 anywhere).
    const send = await app.server.inject({
      method: "POST",
      url: "/api/mesh/messages",
      headers: { cookie: alice.cookie },
      payload: { toMeshId: bobCard.meshId, body: "hi" },
    });
    expect(send.statusCode).toBe(404);
  });

  it("caps the mesh address book at mesh.maxContacts (new ids blocked, refreshes allowed)", async () => {
    const app = await makeApp({ mesh: { ...MESH, maxContacts: 1 } });
    const alice = await newSession(app);
    const bob = await newSession(app);
    const mallory = await newSession(app);
    const bobCard = await meshCard(app, bob.cookie);
    const malloryCard = await meshCard(app, mallory.cookie);

    expect((await addContact(app, alice.cookie, bobCard)).statusCode).toBe(200);
    // A second DISTINCT contact exceeds the cap of 1.
    expect((await addContact(app, alice.cookie, malloryCard)).statusCode).toBe(400);
    // Re-adding an existing contact (a key/name refresh) is still allowed at the cap.
    expect((await addContact(app, alice.cookie, bobCard)).statusCode).toBe(200);
  });

  it("silently drops a shadow-banned sender's sealed mail (200, but nothing delivered)", async () => {
    const app = await makeApp({ mesh: MESH });
    const admin = await newSession(app); // firstUser → admin (can moderate)
    const spammer = await newSession(app);
    const bob = await newSession(app);

    const bobCard = await meshCard(app, bob.cookie);
    expect((await addContact(app, spammer.cookie, bobCard)).statusCode).toBe(200);

    await app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${spammer.userId}`,
      headers: { cookie: admin.cookie },
      payload: { shadowBanned: true },
    });

    // The send looks successful to the shadow-banned sender...
    const send = await app.server.inject({
      method: "POST",
      url: "/api/mesh/messages",
      headers: { cookie: spammer.cookie },
      payload: { toMeshId: bobCard.meshId, body: "spam spam spam" },
    });
    expect(send.statusCode).toBe(200);

    // ...but nothing was sealed or delivered — Bob has no mesh contact / DM.
    expect((await roster(app, bob.cookie)).some((entry) => entry.id.startsWith("mesh."))).toBe(false);
  });

  it("carries A→C→B: an intermediary relays sealed mail it cannot read", async () => {
    const nodeA = await makeApp({ sync: { enabled: true }, mesh: MESH });
    const nodeB = await makeApp({ sync: { enabled: true }, mesh: MESH });
    const nodeC = await makeApp({ sync: { enabled: true }, mesh: MESH });
    const aAdmin = await adminOf(nodeA);
    const bob = await adminOf(nodeB); // Bob is node B's real (admin) session user, not a seed
    const cAdmin = await adminOf(nodeC);

    const [aUrl, bUrl, cUrl] = await Promise.all([listen(nodeA), listen(nodeB), listen(nodeC)]);
    // Pull topology: C carries from A; B receives from C — A and B never meet directly.
    expect((await setPeers(nodeA, aAdmin.cookie, [bUrl])).statusCode).toBe(200);
    expect((await setPeers(nodeC, cAdmin.cookie, [aUrl])).statusCode).toBe(200);
    expect((await setPeers(nodeB, bob.cookie, [cUrl])).statusCode).toBe(200);

    // Alice and Bob exchange cards out-of-band (no reliance on public-post sync); Alice adds Bob.
    const bobCard = await meshCard(nodeB, bob.cookie);
    expect((await addContact(nodeA, aAdmin.cookie, bobCard)).statusCode).toBe(200);

    // Alice (node A) seals a message to Bob's mesh id.
    const send = await nodeA.server.inject({
      method: "POST",
      url: "/api/mesh/messages",
      headers: { cookie: aAdmin.cookie },
      payload: { toMeshId: bobCard.meshId, body: "the rendezvous is at dawn" },
    });
    expect(send.statusCode).toBe(200);

    await syncNow(nodeC, cAdmin.cookie); // C carries the sealed blob from A (cannot open it)
    await syncNow(nodeB, bob.cookie); // B pulls from C, recognises the tag, decrypts, delivers

    // Bob received the plaintext.
    const contact = (await roster(nodeB, bob.cookie)).find((entry) => entry.id.startsWith("mesh."));
    expect(contact).toBeDefined();
    expect(await dmBodies(nodeB, bob.cookie, contact!.id)).toContain("the rendezvous is at dawn");

    // The carrier C holds the sealed blob but never learned the plaintext — no DM anywhere on C
    // contains the secret, and its stored copy is opaque ciphertext.
    const cMessages = (
      await nodeC.server.inject({ method: "GET", url: "/api/messages/general", headers: { cookie: cAdmin.cookie } })
    ).json() as { body?: string }[];
    expect(cMessages.some((m) => (m.body ?? "").includes("dawn"))).toBe(false);
    // C carried it: its store holds a sealed-type message whose serialized form doesn't contain the plaintext.
    const cStored = nodeC.store.loadMessages();
    const sealed = cStored.find((m) => m.type === "sealed");
    expect(sealed).toBeDefined();
    expect(JSON.stringify(sealed)).not.toContain("dawn");

    // Metadata privacy: the routing tag is derived from Bob's SECRET mailbox token, not his public kx —
    // so a carrier holding only public key material (as v1 leaked) cannot recompute it. The sealer
    // stamped `ttlExpiresAt = sendTime + ttlMs`, so we recover the exact send-time epoch.
    const sealedMsg = sealed as { ttlExpiresAt: number; toTag: string };
    const epoch = currentEpoch(sealedMsg.ttlExpiresAt - MESH.ttlMs, 24 * 3_600_000);
    expect(sealedMsg.toTag).toBe(mailboxTag(bobCard.mailboxToken, epoch));
    expect(sealedMsg.toTag).not.toBe(mailboxTag(bobCard.kx, epoch));
  });

  describe("group/broadcast fan-out (POST /api/mesh/broadcast)", () => {
    /** Broadcast one sealed message to several contacts in one call. */
    function broadcast(app: LoamApp, cookie: string, toMeshIds: string[], body: string): Promise<InjectResponse> {
      return app.server.inject({
        method: "POST",
        url: "/api/mesh/broadcast",
        headers: { cookie },
        payload: { toMeshIds, body },
      });
    }

    it("404s /api/mesh/broadcast when mesh is disabled", async () => {
      const app = await makeApp();
      const user = await newSession(app);
      const res = await broadcast(app, user.cookie, ["mesh.absent"], "hi");
      expect(res.statusCode).toBe(404);
    });

    it("seals an independent copy to each of 3 contacts, with distinct tags/ciphertext, and delivers to all", async () => {
      // Bob, Carol, and Dave live on node B; Alice (the sender) is on node A, so their sealed copies
      // are stored (not delivered in-process) until sync carries them — letting us inspect the
      // per-recipient blobs before they're opened.
      const nodeA = await makeApp({ sync: { enabled: true }, mesh: MESH });
      const nodeB = await makeApp({ sync: { enabled: true }, mesh: MESH });
      const alice = await adminOf(nodeA);
      const bob = await adminOf(nodeB);
      const carol = await newSession(nodeB);
      const dave = await newSession(nodeB);

      const [aUrl] = await Promise.all([listen(nodeA), listen(nodeB)]);
      // B pulls from A (the courier direction: A holds the sealed blobs after sending).
      expect((await setPeers(nodeB, bob.cookie, [aUrl])).statusCode).toBe(200);

      const bobCard = await meshCard(nodeB, bob.cookie);
      const carolCard = await meshCard(nodeB, carol.cookie);
      const daveCard = await meshCard(nodeB, dave.cookie);
      for (const card of [bobCard, carolCard, daveCard]) {
        expect((await addContact(nodeA, alice.cookie, card)).statusCode).toBe(200);
      }

      const res = await broadcast(
        nodeA,
        alice.cookie,
        [bobCard.meshId, carolCard.meshId, daveCard.meshId],
        "assemble at noon",
      );
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, sent: 3, skipped: [] });

      // Node A stored 3 independently-sealed copies — one per recipient, each with its own routing
      // tag (derived from that recipient's secret mailbox token) and its own ciphertext (fresh
      // ephemeral key per seal), never a shared key across recipients.
      const sealedRows = nodeA.store.loadMessages().filter((message) => message.type === "sealed") as {
        toTag: string;
        sealed: string;
      }[];
      expect(sealedRows).toHaveLength(3);
      expect(new Set(sealedRows.map((row) => row.toTag)).size).toBe(3);
      expect(new Set(sealedRows.map((row) => row.sealed)).size).toBe(3);

      // Sync carries all 3 blobs to node B, which recognises each tag against its local recipient and
      // decrypts+delivers independently.
      await syncNow(nodeB, bob.cookie);

      for (const recipient of [
        { session: bob, card: bobCard },
        { session: carol, card: carolCard },
        { session: dave, card: daveCard },
      ]) {
        const contact = (await roster(nodeB, recipient.session.cookie)).find((entry) => entry.id.startsWith("mesh."));
        expect(contact).toBeDefined();
        expect(await dmBodies(nodeB, recipient.session.cookie, contact!.id)).toContain("assemble at noon");
      }
    });

    it("reports a toMeshId that isn't a contact in `skipped`, without sending to it", async () => {
      const app = await makeApp({ mesh: MESH });
      const alice = await newSession(app);
      const bob = await newSession(app);
      const carol = await newSession(app);
      const bobCard = await meshCard(app, bob.cookie);
      const carolCard = await meshCard(app, carol.cookie);
      // Alice adds Bob but never adds Carol.
      expect((await addContact(app, alice.cookie, bobCard)).statusCode).toBe(200);

      const res = await broadcast(app, alice.cookie, [bobCard.meshId, carolCard.meshId], "hi");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, sent: 1, skipped: [carolCard.meshId] });

      expect((await roster(app, bob.cookie)).some((entry) => entry.id.startsWith("mesh."))).toBe(true);
      expect((await roster(app, carol.cookie)).some((entry) => entry.id.startsWith("mesh."))).toBe(false);
    });

    it("silently drops a shadow-banned sender's broadcast (200, nothing delivered)", async () => {
      const app = await makeApp({ mesh: MESH });
      const admin = await newSession(app); // firstUser → admin (can moderate)
      const spammer = await newSession(app);
      const bob = await newSession(app);
      const carol = await newSession(app);

      const bobCard = await meshCard(app, bob.cookie);
      const carolCard = await meshCard(app, carol.cookie);
      expect((await addContact(app, spammer.cookie, bobCard)).statusCode).toBe(200);
      expect((await addContact(app, spammer.cookie, carolCard)).statusCode).toBe(200);

      await app.server.inject({
        method: "PATCH",
        url: `/api/moderation/users/${spammer.userId}`,
        headers: { cookie: admin.cookie },
        payload: { shadowBanned: true },
      });

      const res = await broadcast(app, spammer.cookie, [bobCard.meshId, carolCard.meshId], "spam spam spam");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, sent: 0, skipped: [] });

      expect((await roster(app, bob.cookie)).some((entry) => entry.id.startsWith("mesh."))).toBe(false);
      expect((await roster(app, carol.cookie)).some((entry) => entry.id.startsWith("mesh."))).toBe(false);
    });

    it("de-duplicates repeated toMeshIds so a contact is mailed only once", async () => {
      const app = await makeApp({ mesh: MESH });
      const alice = await newSession(app);
      const bob = await newSession(app);
      const bobCard = await meshCard(app, bob.cookie);
      expect((await addContact(app, alice.cookie, bobCard)).statusCode).toBe(200);

      const res = await broadcast(app, alice.cookie, [bobCard.meshId, bobCard.meshId, bobCard.meshId], "hi bob");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, sent: 1, skipped: [] });

      const contact = (await roster(app, bob.cookie)).find((entry) => entry.id.startsWith("mesh."));
      expect(contact).toBeDefined();
      const bodies = await dmBodies(app, bob.cookie, contact!.id);
      expect(bodies.filter((entry) => entry === "hi bob")).toHaveLength(1);
    });
  });

  // ---- Opportunistic-mesh transport bridge (Phase 3 — docs/16 §5, docs/17) ----------------------
  // The loopback endpoints the Android launcher uses to shuttle sealed blobs over the native BLE/
  // Wi-Fi-Aware radio. They are a radio-fed mirror of the /api/sync/* sealed path.
  describe("transport bridge (GET /api/mesh/outbound + POST /api/mesh/inbound)", () => {
    it("404s both endpoints when mesh is disabled", async () => {
      const app = await makeApp(); // mesh off by default
      const out = await app.server.inject({ method: "GET", url: "/api/mesh/outbound" });
      expect(out.statusCode).toBe(404);
      const inbound = await app.server.inject({
        method: "POST",
        url: "/api/mesh/inbound",
        payload: { messages: [] },
      });
      // Empty batch also fails the min(1) schema, but the 404 gate short-circuits before validation.
      expect(inbound.statusCode).toBe(404);
    });

    it("hands a sealed blob A→B over the bridge without the sync loop", async () => {
      // Two mesh nodes with NO sync peers configured — delivery rides only the transport bridge.
      const nodeA = await makeApp({ mesh: MESH });
      const nodeB = await makeApp({ mesh: MESH });
      const alice = await adminOf(nodeA);
      const bob = await adminOf(nodeB);

      // Alice adds Bob's card (out-of-band) and seals a message to him. It has no local recipient on
      // A, so it sits in A's outbound queue waiting for a carrier.
      const bobCard = await meshCard(nodeB, bob.cookie);
      expect((await addContact(nodeA, alice.cookie, bobCard)).statusCode).toBe(200);
      const send = await nodeA.server.inject({
        method: "POST",
        url: "/api/mesh/messages",
        headers: { cookie: alice.cookie },
        payload: { toMeshId: bobCard.meshId, body: "carry me over the mesh" },
      });
      expect(send.statusCode).toBe(200);

      // The courier reads A's outbound queue (what it would push over the radio).
      const out = await nodeA.server.inject({ method: "GET", url: "/api/mesh/outbound" });
      expect(out.statusCode).toBe(200);
      const outbound = out.json() as { messages: { type: string; sealed: string }[] };
      expect(outbound.messages).toHaveLength(1);
      expect(outbound.messages[0].type).toBe("sealed");
      // Opaque on the wire — the plaintext is nowhere in the blob the radio would carry.
      expect(JSON.stringify(outbound.messages)).not.toContain("carry me over the mesh");

      // The receiving node's courier POSTs the received blob to its inbound endpoint → delivered.
      const inbound = await nodeB.server.inject({
        method: "POST",
        url: "/api/mesh/inbound",
        payload: { messages: outbound.messages },
      });
      expect(inbound.statusCode).toBe(200);
      expect((inbound.json() as { accepted: number }).accepted).toBe(1);

      const contact = (await roster(nodeB, bob.cookie)).find((entry) => entry.id.startsWith("mesh."));
      expect(contact).toBeDefined();
      expect(await dmBodies(nodeB, bob.cookie, contact!.id)).toContain("carry me over the mesh");

      // Idempotent: re-delivering the same blob is a no-op (dedup by id + tombstone), not a dupe DM.
      const again = await nodeB.server.inject({
        method: "POST",
        url: "/api/mesh/inbound",
        payload: { messages: outbound.messages },
      });
      expect((again.json() as { accepted: number }).accepted).toBe(0);
      expect((await dmBodies(nodeB, bob.cookie, contact!.id)).filter((b) => b === "carry me over the mesh")).toHaveLength(1);
    });

    it("relays through a carrier that cannot read the blob (bridge A→C→B)", async () => {
      const nodeA = await makeApp({ mesh: MESH });
      const nodeB = await makeApp({ mesh: MESH });
      const nodeC = await makeApp({ mesh: MESH });
      const alice = await adminOf(nodeA);
      const bob = await adminOf(nodeB);
      const carol = await adminOf(nodeC);

      const bobCard = await meshCard(nodeB, bob.cookie);
      expect((await addContact(nodeA, alice.cookie, bobCard)).statusCode).toBe(200);
      expect(
        (
          await nodeA.server.inject({
            method: "POST",
            url: "/api/mesh/messages",
            headers: { cookie: alice.cookie },
            payload: { toMeshId: bobCard.meshId, body: "meet at the docks" },
          })
        ).statusCode,
      ).toBe(200);

      // A → C: the carrier takes it on (not for a local user → relayed, hop-decremented).
      const fromA = (await nodeA.server.inject({ method: "GET", url: "/api/mesh/outbound" })).json() as {
        messages: unknown[];
      };
      expect(
        (
          (
            await nodeC.server.inject({ method: "POST", url: "/api/mesh/inbound", payload: { messages: fromA.messages } })
          ).json() as { accepted: number }
        ).accepted,
      ).toBe(1);
      // Carol cannot read it.
      const cSealed = nodeC.store.loadMessages().find((m) => m.type === "sealed");
      expect(cSealed).toBeDefined();
      expect(JSON.stringify(cSealed)).not.toContain("docks");

      // C → B: the carrier re-offers it (still on its outbound), B decrypts + delivers.
      const fromC = (await nodeC.server.inject({ method: "GET", url: "/api/mesh/outbound" })).json() as {
        messages: unknown[];
      };
      expect(fromC.messages).toHaveLength(1);
      expect(
        (
          (
            await nodeB.server.inject({ method: "POST", url: "/api/mesh/inbound", payload: { messages: fromC.messages } })
          ).json() as { accepted: number }
        ).accepted,
      ).toBe(1);
      const contact = (await roster(nodeB, bob.cookie)).find((entry) => entry.id.startsWith("mesh."));
      expect(await dmBodies(nodeB, bob.cookie, contact!.id)).toContain("meet at the docks");
    });
  });
});

describe("transport encryption foundation (docs/08)", () => {
  it("404s the handshake and advertises no host key when transport encryption is off", async () => {
    const app = await makeApp(); // default: off
    const hello = transportClientHello();
    const res = await app.server.inject({
      method: "POST",
      url: "/api/transport/handshake",
      payload: { clientEphemeralPublic: hello.ephemeralPublic },
    });
    expect(res.statusCode).toBe(404);

    const cfg = (await app.server.inject({ method: "GET", url: "/api/config" })).json() as {
      networkConfig: { transportEncryption: string; transportPublicKey?: string };
    };
    expect(cfg.networkConfig.transportEncryption).toBe("off");
    expect(cfg.networkConfig.transportPublicKey).toBeUndefined();
  });

  it("completes a handshake and matches the host key advertised in /api/config", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const hello = transportClientHello();
    const res = await app.server.inject({
      method: "POST",
      url: "/api/transport/handshake",
      payload: { clientEphemeralPublic: hello.ephemeralPublic },
    });
    expect(res.statusCode).toBe(200);
    const body = TransportHandshakeResponseSchema.parse(res.json());

    const cfg = (await app.server.inject({ method: "GET", url: "/api/config" })).json() as {
      networkConfig: { transportEncryption: string; transportPublicKey?: string };
    };
    expect(cfg.networkConfig.transportEncryption).toBe("optional");
    expect(cfg.networkConfig.transportPublicKey).toBe(body.hostPublicKey);

    // The client can finish the handshake to a 32-byte session key.
    const key = transportClientDerive({
      clientEphemeralSecret: hello.ephemeralSecret,
      hostPublic: body.hostPublicKey,
      hostEphemeralPublic: body.hostEphemeralPublic,
    });
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // A malformed client key is a clean 400, never a 500.
    const bad = await app.server.inject({
      method: "POST",
      url: "/api/transport/handshake",
      payload: { clientEphemeralPublic: "!!!not-base64!!!" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("persists the host transport key across a restart (stable join QR)", async () => {
    const { app, dataDir } = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const keyOf = async (target: LoamApp) =>
      (
        (await target.server.inject({ method: "GET", url: "/api/config" })).json() as {
          networkConfig: { transportPublicKey?: string };
        }
      ).networkConfig.transportPublicKey;

    const before = await keyOf(app);
    expect(before).toBeTruthy();
    const reopened = await reopenApp(app, dataDir);
    expect(await keyOf(reopened)).toBe(before);
  });

  it("a named profile forces the transport axis (hardened → required)", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    expect(
      (
        await app.server.inject({
          method: "PATCH",
          url: "/api/admin/config",
          headers: { cookie: admin.cookie },
          payload: { security: { profile: "hardened" } },
        })
      ).statusCode,
    ).toBe(200);
    // After the switch to `required`, `/api/config` is tunnel-only content (docs/20) — the forced axis
    // is read from the public, cookie-free bootstrap instead.
    const cfg = (
      await app.server.inject({ method: "GET", url: "/api/bootstrap" })
    ).json() as { networkConfig: { transportEncryption: string; transportPublicKey?: string } };
    expect(cfg.networkConfig.transportEncryption).toBe("required");
    expect(cfg.networkConfig.transportPublicKey).toBeTruthy(); // now advertised
  });

  const keyOf = async (target: LoamApp) =>
    (
      (await target.server.inject({ method: "GET", url: "/api/config" })).json() as {
        networkConfig: { transportPublicKey?: string };
      }
    ).networkConfig.transportPublicKey;

  it("regenerates the transport identity if the persisted record is unparsable JSON (docs/08)", async () => {
    const { app, dataDir } = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const before = await keyOf(app);
    expect(before).toBeTruthy();

    app.store.setConfigValue("transportIdentity", "{ this is not json");

    const reopened = await reopenApp(app, dataDir);
    const after = await keyOf(reopened);
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
    // The regenerated identity is actually usable for a real handshake, not just non-empty.
    const hello = transportClientHello();
    const hs = await reopened.server.inject({
      method: "POST",
      url: "/api/transport/handshake",
      payload: { clientEphemeralPublic: hello.ephemeralPublic },
    });
    expect(hs.statusCode).toBe(200);
  });

  it("regenerates the transport identity if the persisted record parses but has the wrong shape (docs/08)", async () => {
    const { app, dataDir } = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const before = await keyOf(app);

    // Valid JSON, but not `{ publicKey, secretKey }` — e.g. a truncated write, or an empty key.
    app.store.setConfigValue("transportIdentity", JSON.stringify({ publicKey: "", secretKey: "" }));
    const reopenedA = await reopenApp(app, dataDir);
    const afterA = await keyOf(reopenedA);
    expect(afterA).toBeTruthy();
    expect(afterA).not.toBe(before);

    reopenedA.store.setConfigValue("transportIdentity", JSON.stringify({ unrelated: "shape" }));
    const reopenedB = await reopenApp(reopenedA, dataDir);
    const afterB = await keyOf(reopenedB);
    expect(afterB).toBeTruthy();
    expect(afterB).not.toBe(afterA);
  });

  it("bounds the live transport session map: the oldest sessions are evicted once at the cap (docs/08)", async () => {
    // A real 5,000-session cap would make this test slow, so it's configured down via
    // `transportSessionCap` (mirrors the existing `maxNewIdentitiesPerWindow` testability pattern).
    const dataDir = mkdtempSync(join(tmpdir(), "loam-app-test-"));
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({ security: { profile: "custom", transportEncryption: "optional" } }),
    );
    const app = await buildApp({ dataDir, logger: false, maxNewIdentitiesPerWindow: 1_000_000, transportSessionCap: 3 });
    cleanups.push(async () => {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    });

    async function handshake(): Promise<{ sessionId: string; key: string }> {
      const hello = transportClientHello();
      const res = await app.server.inject({
        method: "POST",
        url: "/api/transport/handshake",
        payload: { clientEphemeralPublic: hello.ephemeralPublic },
      });
      const body = TransportHandshakeResponseSchema.parse(res.json());
      return {
        sessionId: body.sessionId,
        key: transportClientDerive({
          clientEphemeralSecret: hello.ephemeralSecret,
          hostPublic: body.hostPublicKey,
          hostEphemeralPublic: body.hostEphemeralPublic,
        }),
      };
    }

    const first = await handshake();
    await handshake();
    await handshake();
    // The map is now at the cap (3). A 4th handshake must evict the oldest (`first`) to make room.
    await handshake();

    const user = await newSession(app);
    const usingFirst = await app.server.inject({
      method: "GET",
      url: "/api/users",
      headers: { cookie: user.cookie, "x-loam-enc": first.sessionId },
    });
    // The oldest session was evicted: its id is now unknown, refused exactly like any expired session.
    expect(usingFirst.statusCode).toBe(401);
  });
});

describe("transport encryption transparent round-trip (docs/08)", () => {
  /** Establish a transport session and return { sessionId, key } for encrypting requests. */
  async function openSession(app: LoamApp): Promise<{ sessionId: string; key: string }> {
    const hello = transportClientHello();
    const res = await app.server.inject({
      method: "POST",
      url: "/api/transport/handshake",
      payload: { clientEphemeralPublic: hello.ephemeralPublic },
    });
    const body = TransportHandshakeResponseSchema.parse(res.json());
    return {
      sessionId: body.sessionId,
      key: transportClientDerive({
        clientEphemeralSecret: hello.ephemeralSecret,
        hostPublic: body.hostPublicKey,
        hostEphemeralPublic: body.hostEphemeralPublic,
      }),
    };
  }

  /** Seal a request into the `{ s, b? }` envelope the server expects (docs/08), at an explicit
   * sequence number so replay/ordering tests can control it. `body` omitted → a bodyless envelope. */
  function sealRequest(key: string, seq: number, aad: string, body?: unknown): string {
    return sealTransport(key, JSON.stringify(body === undefined ? { s: seq } : { s: seq, b: body }), aad);
  }

  it("encrypts request bodies and responses transparently (content never on the wire)", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const user = await newSession(app);
    const session = await openSession(app);

    const method = "POST";
    const url = "/api/messages";
    const aad = `${method} ${url}`;
    const secret = "rendezvous at the old mill at dawn";
    const res = await app.server.inject({
      method,
      url,
      headers: { cookie: user.cookie, "x-loam-enc": session.sessionId, "content-type": "application/json" },
      payload: { enc: sealRequest(session.key, 1, aad, { type: "channelPost", channelId: "general", body: secret }) },
    });

    expect(res.statusCode).toBe(201);
    expect(res.headers["x-loam-enc"]).toBe("1");
    // The plaintext is NOWHERE in the raw response...
    expect(res.body).not.toContain("rendezvous");
    // ...but decrypts to the created message.
    const opened = openTransport(session.key, (res.json() as { enc: string }).enc, aad);
    expect(opened).not.toBeNull();
    expect((JSON.parse(opened as string) as { message: { body: string } }).message.body).toBe(secret);
  });

  it("required mode: only the public bootstrap is directly reachable; all content is tunnel-only", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });

    // The public, cookie-free bootstrap + health are the ONLY directly-reachable routes (docs/20).
    expect((await app.server.inject({ method: "GET", url: "/api/bootstrap" })).statusCode).toBe(200);
    expect((await app.server.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);

    // `/api/config` is now CONTENT (returns `currentUser`), so a direct hit is refused — a bound client
    // reads it through the tunnel. This is the docs/20 tightening over docs/08.
    expect((await app.server.inject({ method: "GET", url: "/api/config" })).statusCode).toBe(401);

    // A content endpoint without a transport session is refused.
    const bare = await app.server.inject({ method: "GET", url: "/api/users" });
    expect(bare.statusCode).toBe(401);

    // A percent-encoded `/api/` prefix must NOT bypass enforcement: `/%61pi/users` routes to
    // `/api/users`, so matching the RESOLVED route (not the raw URL) still refuses it (regression).
    const encodedBypass = await app.server.inject({ method: "GET", url: "/%61pi/users" });
    expect(encodedBypass.statusCode).toBe(401);

    // Image endpoints are NOT exempt (docs/08 v2 / docs/20): a direct image GET is 401'd so the client
    // must fetch images through the tunnel (bytes come back sealed) instead of serving them in clear.
    const avatar = await app.server.inject({ method: "GET", url: "/api/avatars/avt_deadbeefdeadbeef.webp" });
    expect(avatar.statusCode).toBe(401);

    // A presented-but-unknown/expired transport session id is refused (both modes) so the client
    // re-handshakes rather than the wire silently downgrading to plaintext.
    const staleSession = await app.server.inject({
      method: "GET",
      url: "/api/users",
      headers: { "x-loam-enc": "unknown-or-expired-session-id" },
    });
    expect(staleSession.statusCode).toBe(401);

    // KEY docs/20 invariant: a DIRECT sealed content request is refused EVEN WITH a live session — a
    // captured session id can't reach content off the tunnel. Content is reachable ONLY via the tunnel.
    const session = await openTransport08(app);
    const direct = await app.server.inject({
      method: "GET",
      url: "/api/users",
      headers: { "x-loam-enc": session.sessionId },
    });
    expect(direct.statusCode).toBe(401);

    // Bind an identity over the sealed channel, then reach the same route through the tunnel: it works.
    const bound = await resumeIdentity(app, session, 1);
    expect(bound.status).toBe(200);
    const inner = await tunnelInner(app, session, 2, { m: "GET", p: "/api/users" });
    expect(inner.status).toBe(200);
    const users = JSON.parse(inner.body.toString("utf8")) as { id: string }[];
    expect(users.some((u) => u.id === bound.currentUser.id)).toBe(true);
  });

  it("rejects a frame sealed for a different route (aad binding)", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const user = await newSession(app);
    const session = await openSession(app);
    // Seal a body under the WRONG route's aad; the server opens against the real route → 400.
    const res = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: user.cookie, "x-loam-enc": session.sessionId, "content-type": "application/json" },
      payload: { enc: sealTransport(session.key, JSON.stringify({ type: "channelPost", channelId: "general", body: "x" }), "POST /api/admin/kill-switch") },
    });
    expect(res.statusCode).toBe(400);
  });

  it("fails closed: rejects a mutation with a PLAINTEXT body under a presented transport session (docs/08)", async () => {
    // A valid session id (visible in the `x-loam-enc` header on the wire) does not by itself prove the
    // body was actually sealed — before this fix, a request that presented a real session id but a
    // plain, attacker-supplied JSON body would just run as-is, letting an active network attacker
    // inject/rewrite a mutation without ever needing the session key. This is the regression test.
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const user = await newSession(app);
    const session = await openSession(app);

    const res = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: user.cookie, "x-loam-enc": session.sessionId, "content-type": "application/json" },
      // Plaintext, not `{ enc: "..." }` — must be refused, never processed as-is.
      payload: { type: "channelPost", channelId: "general", body: "injected in the clear" },
    });
    expect(res.statusCode).toBe(400);

    // Nothing was created: the plaintext body was never allowed to reach the route handler.
    expect(app.store.loadMessages().some((message) => "body" in message && message.body === "injected in the clear")).toBe(false);
  });

  it("fails closed: rejects a mutation with NO body at all under a presented transport session", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const user = await newSession(app);
    const session = await openSession(app);

    const res = await app.server.inject({
      method: "DELETE",
      url: "/api/channels/general/members/ghost",
      headers: { cookie: user.cookie, "x-loam-enc": session.sessionId },
    });
    expect(res.statusCode).toBe(400);
  });

  it("still allows a bodyless mutation once it carries a sealed EMPTY envelope (the client always seals mutations)", async () => {
    // The client-side fix pairs with the server's fail-closed check: a mutation with no logical
    // payload is sealed as an empty string rather than sent with no envelope at all, so legitimate
    // bodyless mutations (e.g. `POST /api/admin/users/:id/promote`) keep working under a session.
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const admin = await newSession(app);
    const member = await newSession(app);
    const session = await openSession(app);
    const aad = `POST /api/admin/users/${member.userId}/promote`;

    const res = await app.server.inject({
      method: "POST",
      url: `/api/admin/users/${member.userId}/promote`,
      headers: { cookie: admin.cookie, "x-loam-enc": session.sessionId, "content-type": "application/json" },
      payload: { enc: sealRequest(session.key, 1, aad) },
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects a replayed sealed request within the session window (anti-replay, docs/08)", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const user = await newSession(app);
    const session = await openSession(app);
    const aad = "POST /api/messages";
    const headers = { cookie: user.cookie, "x-loam-enc": session.sessionId, "content-type": "application/json" };
    // A captured ciphertext (fixed bytes) replayed verbatim reuses sequence 1.
    const enc = sealRequest(session.key, 1, aad, { type: "channelPost", channelId: "general", body: "once" });

    const first = await app.server.inject({ method: "POST", url: "/api/messages", headers, payload: { enc } });
    expect(first.statusCode).toBe(201);
    const replay = await app.server.inject({ method: "POST", url: "/api/messages", headers, payload: { enc } });
    expect(replay.statusCode).toBe(409);
    // The handler never ran the second time — exactly one message exists.
    expect(app.store.loadMessages().filter((message) => "body" in message && message.body === "once")).toHaveLength(1);
  });

  it("accepts reordered sequences inside the window but refuses a duplicate (docs/08)", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const user = await newSession(app);
    const session = await openSession(app);
    const aad = "POST /api/messages";
    const headers = { cookie: user.cookie, "x-loam-enc": session.sessionId, "content-type": "application/json" };
    const send = (seq: number, body: string) =>
      app.server.inject({
        method: "POST",
        url: "/api/messages",
        headers,
        payload: { enc: sealRequest(session.key, seq, aad, { type: "channelPost", channelId: "general", body }) },
      });

    expect((await send(3, "c")).statusCode).toBe(201); // advances the window to 3
    expect((await send(1, "a")).statusCode).toBe(201); // older but unseen + within window → accepted
    expect((await send(2, "b")).statusCode).toBe(201); // ditto
    expect((await send(2, "again")).statusCode).toBe(409); // a now-seen sequence → refused
  });

  it("refuses a sealed request that carries no sequence number (docs/08)", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const user = await newSession(app);
    const session = await openSession(app);
    const aad = "POST /api/messages";
    // A pre-anti-replay envelope (the raw body, no `s`) must be refused, not run.
    const enc = sealTransport(session.key, JSON.stringify({ type: "channelPost", channelId: "general", body: "no seq" }), aad);
    const res = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: user.cookie, "x-loam-enc": session.sessionId, "content-type": "application/json" },
      payload: { enc },
    });
    expect(res.statusCode).toBe(409);
  });

  it("refuses a sealed request with a non-positive or non-integer sequence (docs/08)", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const user = await newSession(app);
    const session = await openSession(app);
    const aad = "POST /api/messages";
    const headers = { cookie: user.cookie, "x-loam-enc": session.sessionId, "content-type": "application/json" };
    // 0, negative, and fractional sequences are all outside a valid monotonic window → refused.
    for (const s of [0, -1, 1.5]) {
      const enc = sealTransport(session.key, JSON.stringify({ s, b: { type: "channelPost", channelId: "general", body: "x" } }), aad);
      const res = await app.server.inject({ method: "POST", url: "/api/messages", headers, payload: { enc } });
      expect(res.statusCode).toBe(409);
    }
  });

  // --- Transport tunnel (docs/08 v2: path + response fully hidden) ---
  const TUNNEL_AAD = "POST /api/transport/tunnel";

  /** Send a request through the tunnel on a BOUND session (docs/20): seal `{ s, b: { m, p, body } }`
   * to /api/transport/tunnel. No cookie — a bound session authenticates via its session key alone. */
  function tunnel(
    app: LoamApp,
    session: { sessionId: string; key: string },
    seq: number,
    inner: { m: string; p: string; body?: unknown },
  ): Promise<InjectResponse> {
    return app.server.inject({
      method: "POST",
      url: "/api/transport/tunnel",
      headers: {
        "x-loam-enc": session.sessionId,
        "content-type": "application/json",
      },
      payload: { enc: sealRequest(session.key, seq, TUNNEL_AAD, inner) },
    });
  }

  /** Unseal a tunnel response into its `{ status, contentType, body }` descriptor (body = raw bytes). */
  function openTunnel(session: { key: string }, res: InjectResponse): { status: number; contentType: string; body: Buffer } {
    const opened = openTransport(session.key, (res.json() as { enc: string }).enc, TUNNEL_AAD);
    expect(opened).not.toBeNull();
    const desc = JSON.parse(opened as string) as { status: number; contentType: string; bodyB64: string };
    return { status: desc.status, contentType: desc.contentType, body: Buffer.from(desc.bodyB64, "base64") };
  }

  it("tunnels a GET so the real path and response never appear on the wire (docs/08)", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });
    const session = await openSession(app);
    const bound = await resumeIdentity(app, session, 1); // bind identity before touching content

    const res = await tunnel(app, session, 2, { m: "GET", p: "/api/users" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-loam-enc"]).toBe("1");
    // Neither the real target nor the response content is anywhere in the cleartext wire body.
    expect(res.body).not.toContain("displayName");
    expect(res.body).not.toContain("/api/users");

    const inner = openTunnel(session, res);
    expect(inner.status).toBe(200);
    const users = JSON.parse(inner.body.toString("utf8")) as { id: string }[];
    expect(users.some((u) => u.id === bound.currentUser.id)).toBe(true);
  });

  it("tunnels a POST mutation end-to-end (creates a message; response tunnelled back)", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });
    const session = await openSession(app);
    await resumeIdentity(app, session, 1);

    const res = await tunnel(app, session, 2, {
      m: "POST",
      p: "/api/messages",
      body: { type: "channelPost", channelId: "general", body: "via tunnel" },
    });
    expect(res.statusCode).toBe(200); // outer tunnel status; inner status is in the sealed descriptor
    const inner = openTunnel(session, res);
    expect(inner.status).toBe(201);
    expect(app.store.loadMessages().some((m) => "body" in m && m.body === "via tunnel")).toBe(true);
  });

  it("carries response bytes losslessly (base64 body → binary images tunnel intact)", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });
    const session = await openSession(app);
    await resumeIdentity(app, session, 1);
    // A JSON response proves the base64 body is byte-exact; the same path carries image bytes.
    const res = await tunnel(app, session, 2, { m: "GET", p: "/api/config" });
    const inner = openTunnel(session, res);
    expect(inner.status).toBe(200);
    const parsed = JSON.parse(inner.body.toString("utf8")) as { nodeName: string };
    expect(typeof parsed.nodeName).toBe("string");
  });

  it("refuses to tunnel the transport bootstrap or non-API paths — including percent-encoded evasions", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });
    const session = await openSession(app);
    await resumeIdentity(app, session, 1);

    const refused = [
      "/api/transport/handshake",
      "/api/transport/tunnel",
      "/",
      "/index.html",
      "/api/../admin",
      // Percent-encoded evasions: a raw string check would pass these, but they decode-and-route to
      // the transport bootstrap (recursion) or a traversal. The check now validates the DECODED path.
      "/api/transp%6frt/tunnel", // %6f = 'o' → /api/transport/tunnel
      "/api/transport%2ftunnel", // encoded slash → refused outright
      "/api/%2e%2e/admin", // %2e%2e = '..' → traversal
      "/%61pi/transport/handshake", // %61 = 'a' → /api/transport/handshake
    ];
    for (const [i, p] of refused.entries()) {
      const res = await tunnel(app, session, i + 2, { m: "GET", p }); // seq 1 consumed by resume
      expect(res.statusCode, `expected 400 for tunnel target ${p}`).toBe(400);
    }
  });

  it("does not let a forged internal-token header bypass required-mode enforcement (docs/08)", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });
    // A real client that guesses/sets x-loam-internal must NOT gain the internal bypass — the token is
    // a per-boot secret it can't know (and onRequest strips a client-supplied one), so a content request
    // without a session is still refused.
    const forged = await app.server.inject({
      method: "GET",
      url: "/api/users",
      headers: { "x-loam-internal": "not-the-real-token" },
    });
    expect(forged.statusCode).toBe(401);
  });

  it("does not let a forged x-loam-user header impersonate an identity (docs/20)", async () => {
    // The internal tunnel sets `x-loam-user`, trusted only behind the unforgeable `x-loam-internal`.
    // A client that sets `x-loam-user` (with or without a guessed internal token) on an EXTERNAL request
    // must gain nothing — onRequest strips both, so this is just an unauthenticated content hit → 401.
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });
    const forged = await app.server.inject({
      method: "GET",
      url: "/api/users",
      headers: { "x-loam-user": "user.deadbeef", "x-loam-internal": "not-the-real-token" },
    });
    expect(forged.statusCode).toBe(401);
  });

  it("binds a fresh identity through the sealed resume — no cookie is ever minted (docs/20)", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });
    const session = await openSession(app);
    // First contact with no token: resume mints a new identity + a 256-bit secure token, sealed. The
    // secure token replaces the cookie entirely — the resume response must NOT set a session cookie.
    const res = await app.server.inject({
      method: "POST",
      url: "/api/session/resume",
      headers: { "x-loam-enc": session.sessionId, "content-type": "application/json" },
      payload: { enc: sealRequest(session.key, 1, "POST /api/session/resume", {}) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["set-cookie"]).toBeUndefined();
    const opened = openTransport(session.key, (res.json() as { enc: string }).enc, "POST /api/session/resume");
    const body = JSON.parse(opened as string) as { currentUser: { id: string }; token: string };
    expect(body.currentUser.id).toMatch(/^user\./);
    expect(body.token.length).toBeGreaterThanOrEqual(43); // 256-bit base64url
  });

  it("serves images only through the tunnel in required mode (image encryption, docs/08 v2)", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });
    const session = await openSession(app);
    await resumeIdentity(app, session, 1);
    // A direct <img>-style GET can't carry the session header → refused, so bytes never serve in clear.
    const direct = await app.server.inject({
      method: "GET",
      url: "/api/avatars/avt_missing.webp",
    });
    expect(direct.statusCode).toBe(401);
    // Through the tunnel it reaches the avatar route internally (404 for a missing file, NOT 401) —
    // i.e. a real image would come back as sealed bytes.
    const res = await tunnel(app, session, 2, { m: "GET", p: "/api/avatars/avt_missing.webp" });
    expect(res.statusCode).toBe(200);
    expect(openTunnel(session, res).status).toBe(404);
  });
});

describe("transport encryption WebSocket frames (docs/08 + docs/20 §7)", () => {
  // Wire constants for the reflection-safe key-confirmation (docs/20 §7). Hardcoded here (not imported)
  // so the test pins the on-the-wire AADs — a server-side rename must break these deliberately.
  const WS_CHALLENGE_AAD = "loam.ws.challenge.v1";
  const WS_PROOF_AAD = "loam.ws.proof.v1";
  const wsFrameAad = (connectionId: string) => `loam.ws.frame.v1 ${connectionId}`;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  type RawWebSocket = {
    addEventListener: (event: string, listener: (event: unknown) => void) => void;
    send: (data: string) => void;
    close: () => void;
  };
  const openWs = (url: string, cookie?: string): RawWebSocket =>
    new (WebSocket as unknown as new (url: string, opts?: unknown) => RawWebSocket)(
      url,
      cookie ? { headers: { cookie } } : undefined,
    );

  /** Connect an encrypted WS, auto-answer the docs/20 §7 challenge, and collect decoded application
   *  frames (the inner `f` of each `{ q, f }` connection-bound envelope) plus their sequences. */
  async function connectConfirmed(
    baseUrl: string,
    sessionId: string,
    key: string,
    cookie?: string,
  ): Promise<{ socket: RawWebSocket; connectionId(): string; payloads: string[]; seqs: number[]; raw: string[] }> {
    const raw: string[] = [];
    const payloads: string[] = [];
    const seqs: number[] = [];
    let connectionId = "";
    const socket = openWs(`${baseUrl.replace("http", "ws")}/ws?enc=${sessionId}`, cookie);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () => reject(new Error("ws failed to connect")));
    });
    socket.addEventListener("message", (event) => {
      const text = String((event as MessageEvent).data);
      raw.push(text);
      if (!connectionId) {
        const challenge = openTransport(key, text, WS_CHALLENGE_AAD);
        if (challenge) {
          const c = JSON.parse(challenge) as { connectionId: string; nonce: string };
          connectionId = c.connectionId;
          socket.send(sealTransport(key, JSON.stringify({ type: "proof", connectionId: c.connectionId, nonce: c.nonce }), WS_PROOF_AAD));
          return;
        }
      }
      const frame = openTransport(key, text, wsFrameAad(connectionId));
      if (frame) {
        const env = JSON.parse(frame) as { q: number; f: string };
        seqs.push(env.q);
        payloads.push(env.f);
      }
    });
    const deadline = Date.now() + 3_000;
    while (!connectionId && Date.now() < deadline) {
      await sleep(25);
    }
    return { socket, connectionId: () => connectionId, payloads, seqs, raw };
  }

  it("seals outbound WS frames, connection-bound, only after the client confirms the key", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });
    const baseUrl = await app.server.listen({ port: 0, host: "127.0.0.1" });
    const session = await openTransport08(app);
    const bound = await resumeIdentity(app, session, 1); // bind identity → WS uses session.userId

    const client = await connectConfirmed(baseUrl, session.sessionId, session.key);
    try {
      expect(client.connectionId()).not.toBe(""); // the challenge was answered

      // Post through the tunnel as the bound user; the broadcast should reach the confirmed socket.
      await tunnelInner(app, session, 2, {
        m: "POST",
        p: "/api/messages",
        body: { type: "channelPost", channelId: "general", body: "over-the-wire secret" },
      });

      const deadline = Date.now() + 3_000;
      while (!client.payloads.some((f) => f.includes("over-the-wire secret")) && Date.now() < deadline) {
        await sleep(25);
      }
    } finally {
      client.socket.close();
    }

    expect(bound.currentUser.id).toMatch(/^user\./);
    // No frame is plaintext...
    for (const frame of client.raw) {
      expect(frame).not.toContain("over-the-wire secret");
    }
    // ...but an application frame decrypts (connection-bound aad) to the broadcast event.
    expect(client.payloads.some((value) => value.includes("over-the-wire secret"))).toBe(true);
    // Frame sequences are monotonic per connection (docs/20 §7 replay window).
    expect(client.seqs).toEqual([...client.seqs].sort((a, b) => a - b));
  });

  it("withholds all frames until the challenge is answered; a reflected challenge never confirms (docs/20 §7)", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });
    const baseUrl = await app.server.listen({ port: 0, host: "127.0.0.1" });
    const session = await openTransport08(app);
    await resumeIdentity(app, session, 1);

    const raw: string[] = [];
    let appFrames = 0;
    const socket = openWs(`${baseUrl.replace("http", "ws")}/ws?enc=${session.sessionId}`);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve());
        socket.addEventListener("error", () => reject(new Error("ws failed to connect")));
      });
      socket.addEventListener("message", (event) => {
        const text = String((event as MessageEvent).data);
        raw.push(text);
        // REFLECTION ATTACK: bounce the challenge ciphertext straight back as the "proof". A keyless
        // attacker can only echo bytes; the server opens it under the proof aad → fails → never confirms.
        socket.send(text);
        // Any frame that opens under a frame aad would be an application frame leaking pre-confirmation.
        // We can't know the connectionId (never revealed to a keyless attacker), but the challenge is the
        // only thing that opens under the challenge aad — count anything that ISN'T the challenge.
        if (!openTransport(session.key, text, WS_CHALLENGE_AAD)) {
          appFrames += 1;
        }
      });

      // Give the reflection a moment, then trigger a broadcast: a confirmed socket would receive it.
      await sleep(100);
      await tunnelInner(app, session, 2, {
        m: "POST",
        p: "/api/messages",
        body: { type: "channelPost", channelId: "general", body: "must-not-arrive" },
      });
      await sleep(300);
    } finally {
      socket.close();
    }

    // Exactly the challenge was ever sent; no application frame arrived (the socket was never admitted).
    expect(raw.length).toBe(1);
    expect(appFrames).toBe(0);
    expect(raw.every((f) => !f.includes("must-not-arrive"))).toBe(true);
  });

  it("binds application frames to the connection: two sockets get distinct connection ids (docs/20 §7)", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });
    const baseUrl = await app.server.listen({ port: 0, host: "127.0.0.1" });
    const session = await openTransport08(app);
    await resumeIdentity(app, session, 1);

    const a = await connectConfirmed(baseUrl, session.sessionId, session.key);
    const b = await connectConfirmed(baseUrl, session.sessionId, session.key);
    try {
      expect(a.connectionId()).not.toBe("");
      expect(b.connectionId()).not.toBe("");
      // Same transport session, but a fresh, distinct connection id per socket — so a frame sealed for A
      // cannot be opened under B's connection-bound aad (aad binding is already proven in the crypto
      // suite; here we prove the SERVER issues a distinct id per connection).
      expect(a.connectionId()).not.toBe(b.connectionId());

      await tunnelInner(app, session, 2, {
        m: "POST",
        p: "/api/messages",
        body: { type: "channelPost", channelId: "general", body: "fan-out" },
      });
      const deadline = Date.now() + 3_000;
      while (
        (!a.payloads.some((f) => f.includes("fan-out")) || !b.payloads.some((f) => f.includes("fan-out"))) &&
        Date.now() < deadline
      ) {
        await sleep(25);
      }
      // A raw frame captured on A does not open under B's connection-bound aad.
      const aFrame = a.raw.find((f) => openTransport(session.key, f, wsFrameAad(a.connectionId()))?.includes("fan-out"));
      expect(aFrame).toBeDefined();
      expect(openTransport(session.key, aFrame as string, wsFrameAad(b.connectionId()))).toBeNull();
    } finally {
      a.socket.close();
      b.socket.close();
    }
  });

  it("a ban closes a socket that is still mid-challenge (docs/20 §7/§8 revocation reaches pending sockets)", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });
    const baseUrl = await app.server.listen({ port: 0, host: "127.0.0.1" });
    const adminS = await openTransport08(app);
    const admin = await resumeIdentity(app, adminS, 1);
    expect(admin.currentUser.isAdmin).toBe(true);
    const memberS = await openTransport08(app);
    const member = await resumeIdentity(app, memberS, 1);

    // Open the member's WS but DELIBERATELY do NOT answer the challenge — it stays mid-confirmation.
    let closed = false;
    let received = 0;
    const socket = openWs(`${baseUrl.replace("http", "ws")}/ws?enc=${memberS.sessionId}`);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve());
        socket.addEventListener("error", () => reject(new Error("ws failed to connect")));
      });
      socket.addEventListener("message", () => (received += 1)); // only the challenge should ever arrive
      socket.addEventListener("close", () => (closed = true));
      await sleep(50); // let the challenge arrive; we never answer it

      // Admin bans the member while their socket is still unconfirmed.
      const banned = await tunnelInner(app, adminS, 2, {
        m: "PATCH",
        p: `/api/moderation/users/${member.currentUser.id}`,
        body: { banned: true },
      });
      expect(banned.status).toBe(200);

      const deadline = Date.now() + 2_000;
      while (!closed && Date.now() < deadline) {
        await sleep(25);
      }
    } finally {
      socket.close();
    }

    // The ban reached the mid-challenge socket and closed it — it never got a chance to confirm and be
    // admitted post-ban. Only the challenge frame was ever delivered (no events).
    expect(closed).toBe(true);
    expect(received).toBe(1);
  });

  it("rejects a WebSocket presenting an unknown/expired enc — no silent plaintext downgrade (docs/20 H1)", async () => {
    // A stale QR-bound client keeps its `?enc=`; if it no longer resolves, the socket must be REFUSED, not
    // downgraded to a plaintext cookie socket (which would attribute the connection to a cookie user and
    // send events in the clear). Optional mode is the exposed case (required would refuse anyway).
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const user = await newSession(app); // a cookie identity exists — the tempting fallback
    const baseUrl = await app.server.listen({ port: 0, host: "127.0.0.1" });

    let closed = false;
    let sawExpired = false;
    let appFrames = 0;
    const socket = openWs(`${baseUrl.replace("http", "ws")}/ws?enc=nonexistent-session-id`, user.cookie);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve());
        socket.addEventListener("error", () => reject(new Error("ws failed to connect")));
      });
      socket.addEventListener("message", (event) => {
        const text = String((event as MessageEvent).data);
        if (text.includes("expired")) sawExpired = true;
        else appFrames += 1;
      });
      socket.addEventListener("close", () => (closed = true));

      // Trigger a broadcast: a wrongly-admitted plaintext socket would receive this in the clear.
      await sleep(50);
      await app.server.inject({
        method: "POST",
        url: "/api/messages",
        headers: { cookie: user.cookie },
        payload: { type: "channelPost", channelId: "general", body: "must-not-leak" },
      });
      const deadline = Date.now() + 2_000;
      while (!closed && Date.now() < deadline) {
        await sleep(25);
      }
    } finally {
      socket.close();
    }

    expect(sawExpired).toBe(true); // told to re-handshake
    expect(closed).toBe(true); // refused, not admitted
    expect(appFrames).toBe(0); // never received the broadcast in the clear
  });

  it("closes a confirmed socket when its transport session is evicted (docs/20 §7/M5)", async () => {
    // A confirmed socket must not outlive its session key. Drive the session cap low, confirm a socket,
    // then open enough fresh handshakes to evict its (oldest) session — the socket should be closed.
    const app = await makeApp(
      { security: { profile: "custom", transportEncryption: "required" } },
      { transportSessionCap: 2 },
    );
    const baseUrl = await app.server.listen({ port: 0, host: "127.0.0.1" });
    const session = await openTransport08(app);
    await resumeIdentity(app, session, 1);

    const client = await connectConfirmed(baseUrl, session.sessionId, session.key);
    let closed = false;
    client.socket.addEventListener("close", () => (closed = true));
    try {
      expect(client.connectionId()).not.toBe(""); // confirmed and admitted

      // Each new handshake prunes+evicts; with cap 2 the socket's (oldest) session is evicted quickly.
      for (let i = 0; i < 4; i += 1) {
        await openTransport08(app);
      }
      const deadline = Date.now() + 2_000;
      while (!closed && Date.now() < deadline) {
        await sleep(25);
      }
    } finally {
      client.socket.close();
    }

    expect(closed).toBe(true); // the confirmed socket was torn down with its evicted session
  });

  it("fails closed on a presented enc even on an OFF node, and on a bare ?enc= (docs/20 #1)", async () => {
    // A node switched to `off` still must refuse a stale key-pinned client's `?enc=` rather than admit a
    // plaintext downgrade; and a bare `?enc=` (present but empty) is refused too (keyed on param presence).
    const app = await makeApp(); // default: transport encryption OFF
    const user = await newSession(app); // a cookie identity for the legitimate plaintext socket
    const baseUrl = await app.server.listen({ port: 0, host: "127.0.0.1" });

    async function expectRefused(query: string): Promise<void> {
      let closed = false;
      let admitted = 0;
      const socket = openWs(`${baseUrl.replace("http", "ws")}/ws${query}`);
      try {
        await new Promise<void>((resolve, reject) => {
          socket.addEventListener("open", () => resolve());
          socket.addEventListener("error", () => reject(new Error("ws failed to connect")));
        });
        socket.addEventListener("message", (event) => {
          if (!String((event as MessageEvent).data).includes("expired")) admitted += 1;
        });
        socket.addEventListener("close", () => (closed = true));
        const deadline = Date.now() + 1_500;
        while (!closed && Date.now() < deadline) {
          await sleep(25);
        }
      } finally {
        socket.close();
      }
      expect(closed).toBe(true);
      expect(admitted).toBe(0);
    }

    await expectRefused("?enc=stale-session-id"); // off node + presented enc → refused
    await expectRefused("?enc="); // bare, empty enc → refused (param presence, not value length)

    // Sanity: a plaintext client with a cookie identity and NO ?enc= is still admitted on an off node.
    const plain = openWs(`${baseUrl.replace("http", "ws")}/ws`, user.cookie);
    let plainClosed = false;
    try {
      await new Promise<void>((resolve, reject) => {
        plain.addEventListener("open", () => resolve());
        plain.addEventListener("error", () => reject(new Error("ws failed to connect")));
      });
      plain.addEventListener("close", () => (plainClosed = true));
      await sleep(100);
    } finally {
      plain.close();
    }
    expect(plainClosed).toBe(false); // admitted (not refused) — legitimate off-node plaintext socket
  });
});

describe("transport auth-binding (docs/20)", () => {
  const RESUME_AAD = "POST /api/session/resume";
  const TUNNEL_AAD = "POST /api/transport/tunnel";

  it("impersonation defeated: a captured session id without the key can't tunnel, resume, or rebind", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });
    const victim = await openTransport08(app);
    const bound = await resumeIdentity(app, victim, 1); // victim binds an identity on session `victim`
    expect(bound.status).toBe(200);

    // An attacker sniffs the victim's SESSION ID but not the key. Their own handshake yields a different
    // key; sealing a tunnel request under it while presenting the victim's session id fails AEAD open.
    const attacker = await openTransport08(app);
    const forgedTunnel = await app.server.inject({
      method: "POST",
      url: "/api/transport/tunnel",
      headers: { "x-loam-enc": victim.sessionId, "content-type": "application/json" },
      payload: { enc: sealTransport(attacker.key, JSON.stringify({ s: 2, b: { m: "GET", p: "/api/users" } }), TUNNEL_AAD) },
    });
    expect(forgedTunnel.statusCode).toBe(400); // undecryptable under the victim session's real key

    // The attacker can't resume as the victim either: the victim's session is already bound, so a resume
    // attempt returns the victim's own cached identity (never the attacker's), and never rebinds.
    const rebindAttempt = await resumeIdentity(app, victim, 3);
    expect(rebindAttempt.status).toBe(200);
    expect(rebindAttempt.currentUser.id).toBe(bound.currentUser.id); // unchanged — no rebind
  });

  it("legacy-token separation: a cookie session token is rejected at resume", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const user = await newSession(app); // optional mode → a real cookie session token exists
    const cookieToken = user.cookie.replace(/^loam_session=/, "");

    const session = await openTransport08(app);
    const res = await resumeIdentity(app, session, 1, cookieToken);
    // The cookie namespace and the identity-token namespace never mix (docs/20 §3) → hard 401.
    expect(res.status).toBe(401);
  });

  it("resume semantics: mint, resume-on-fresh-session, invalid→401, idempotent no-rebind", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });

    // MINT: no token → a new identity + a fresh secure token.
    const s1 = await openTransport08(app);
    const minted = await resumeIdentity(app, s1, 1);
    expect(minted.status).toBe(200);
    expect(minted.token.length).toBeGreaterThanOrEqual(43);

    // RESUME on a brand-new session with that token → the SAME user.
    const s2 = await openTransport08(app);
    const resumed = await resumeIdentity(app, s2, 1, minted.token);
    expect(resumed.status).toBe(200);
    expect(resumed.currentUser.id).toBe(minted.currentUser.id);

    // INVALID token → 401, never a silent mint.
    const s3 = await openTransport08(app);
    const invalid = await resumeIdentity(app, s3, 1, "not-a-real-token");
    expect(invalid.status).toBe(401);

    // IDEMPOTENT no-rebind: a fresh-sequence resume on the already-bound s2, presenting a DIFFERENT
    // token, must NOT rebind — it returns the cached identity from the first bind.
    const other = await resumeIdentity(app, s2, 2, minted.token);
    expect(other.currentUser.id).toBe(resumed.currentUser.id);
  });

  it("response binding: the tunnel descriptor echoes the exact { s, m, p } it answers (docs/20 §9)", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });
    const session = await openTransport08(app);
    await resumeIdentity(app, session, 1);

    const res = await app.server.inject({
      method: "POST",
      url: "/api/transport/tunnel",
      headers: { "x-loam-enc": session.sessionId, "content-type": "application/json" },
      payload: { enc: sealSeq(session.key, 2, TUNNEL_AAD, { m: "GET", p: "/api/users" }) },
    });
    expect(res.statusCode).toBe(200);
    const opened = openTransport(session.key, (res.json() as { enc: string }).enc, TUNNEL_AAD);
    const desc = JSON.parse(opened as string) as { s: number; m: string; p: string; status: number };
    expect(desc.s).toBe(2);
    expect(desc.m).toBe("GET");
    expect(desc.p).toBe("/api/users");
  });

  it("logout revokes the secure token: a later resume with it fails (docs/20 §8)", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });
    const session = await openTransport08(app);
    const bound = await resumeIdentity(app, session, 1);

    const logout = await app.server.inject({
      method: "POST",
      url: "/api/session/logout",
      headers: { "x-loam-enc": session.sessionId, "content-type": "application/json" },
      payload: { enc: sealSeq(session.key, 2, "POST /api/session/logout", {}) },
    });
    expect(logout.statusCode).toBe(200);

    // The token is gone: a fresh session presenting it is refused (never rehydrates the identity).
    const fresh = await openTransport08(app);
    const afterLogout = await resumeIdentity(app, fresh, 1, bound.token);
    expect(afterLogout.status).toBe(401);
  });

  it("device wipe clears a LEGACY COOKIE independently of the secure token, even in required mode (docs/20 #3)", async () => {
    // A browser can hold BOTH a bound secure identity AND a legacy `loam_session` cookie. The sealed logout
    // uses `credentials:"omit"`, so it revokes only the token — the cookie must be cleared independently via
    // the DIRECT `session/end`, which is reachable in required mode and clears the presented cookie's
    // server-side row (otherwise the cookie could rehydrate the wiped identity on an optional/off node).
    const app = await makeApp(); // off by default → firstUser admin + a mintable cookie
    const admin = await newSession(app);
    const cookieToken = admin.cookie.replace(/^loam_session=/, "");
    expect(app.store.loadSessions().some((s) => s.token === cookieToken)).toBe(true);

    // Switch the node to `required` (the mode where the cookie couldn't be cleared before).
    const patch = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { security: { profile: "custom", transportEncryption: "required" } },
    });
    expect(patch.statusCode).toBe(200);

    // A bare, direct `session/end` carrying the cookie is REACHABLE in required mode (not tunnel-only) and
    // clears the cookie — both the Set-Cookie deletion header and the server-side session row.
    const end = await app.server.inject({
      method: "POST",
      url: "/api/session/end",
      headers: { cookie: admin.cookie },
    });
    expect(end.statusCode).toBe(200);
    expect(String(end.headers["set-cookie"])).toContain("Max-Age=0");
    expect(app.store.loadSessions().some((s) => s.token === cookieToken)).toBe(false); // row gone
  });

  it("kill switch clears secure tokens: none can be resumed afterwards (docs/20 §8)", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" }, killSwitch: { enabled: true } });
    const session = await openTransport08(app);
    const bound = await resumeIdentity(app, session, 1);
    expect(bound.currentUser.isAdmin).toBe(true); // first user → admin, so it may fire the kill switch

    // Fire the kill switch through the tunnel (the bound admin authorises it).
    const fired = await tunnelInner(app, session, 2, {
      m: "POST",
      p: "/api/admin/kill-switch",
      body: { confirm: "wipe" },
    });
    expect(fired.status).toBe(200);

    // Every secure token is gone; the old one can't be resumed on a fresh (post-rotation) session.
    const fresh = await openTransport08(app);
    const afterWipe = await resumeIdentity(app, fresh, 1, bound.token);
    expect(afterWipe.status).toBe(401);
  });

  it("ban tears down the banned user's bound transport session (docs/20 §8)", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });
    const adminS = await openTransport08(app);
    const admin = await resumeIdentity(app, adminS, 1);
    expect(admin.currentUser.isAdmin).toBe(true);

    const memberS = await openTransport08(app);
    const member = await resumeIdentity(app, memberS, 1);
    expect(member.currentUser.isAdmin).toBe(false);

    // Admin bans the member through the tunnel.
    const banned = await tunnelInner(app, adminS, 2, {
      m: "PATCH",
      p: `/api/moderation/users/${member.currentUser.id}`,
      body: { banned: true },
    });
    expect(banned.status).toBe(200);

    // The member's bound transport session was torn down: presenting its (now-unknown) id is refused, so
    // they can't keep tunnelling as the banned identity.
    const afterBan = await app.server.inject({
      method: "POST",
      url: "/api/transport/tunnel",
      headers: { "x-loam-enc": memberS.sessionId, "content-type": "application/json" },
      payload: { enc: sealSeq(memberS.key, 3, TUNNEL_AAD, { m: "GET", p: "/api/users" }) },
    });
    expect(afterBan.statusCode).toBe(401); // transport session expired/gone
  });

  it("session-state binding: a bound session on an OPTIONAL node still enforces the secure rules", async () => {
    // Global mode is `optional`, but a client that completes a sealed resume is `bound` — so it must
    // reach content through the tunnel and its cookie is not a credential (docs/20 §2).
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const session = await openTransport08(app);
    const bound = await resumeIdentity(app, session, 1);
    expect(bound.status).toBe(200);

    // Content via the tunnel on the bound session works and is the bound identity.
    const inner = await tunnelInner(app, session, 2, { m: "GET", p: "/api/config" });
    expect(inner.status).toBe(200);
    const cfg = JSON.parse(inner.body.toString("utf8")) as { currentUser: { id: string } };
    expect(cfg.currentUser.id).toBe(bound.currentUser.id);

    // NEGATIVE case (docs/20 §2): the SAME bound session hitting a content route DIRECTLY (sealed, not
    // via the tunnel) is refused — the secure rules key off session `authMode`, not the node's global
    // mode, so a bound session is tunnel-only even on an `optional` node.
    const direct = await app.server.inject({
      method: "GET",
      url: "/api/users",
      headers: { "x-loam-enc": session.sessionId },
    });
    expect(direct.statusCode).toBe(401);
  });

  it("empty-string resume token mints a fresh identity (treated as no token, not invalid)", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });
    const session = await openTransport08(app);
    // `{ token: "" }` is not a real 256-bit token — the server treats it as "mint", not a 401.
    const res = await resumeIdentity(app, session, 1, "");
    expect(res.status).toBe(200);
    expect(res.currentUser.id).toMatch(/^user\./);
    expect(res.token.length).toBeGreaterThanOrEqual(43);
  });

  it("rejects a malformed (non-string) resume token with 400, not a silent mint (docs/20 L7)", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });
    const session = await openTransport08(app);
    const res = await app.server.inject({
      method: "POST",
      url: "/api/session/resume",
      headers: { "x-loam-enc": session.sessionId, "content-type": "application/json" },
      payload: { enc: sealSeq(session.key, 1, "POST /api/session/resume", { token: 123 }) },
    });
    expect(res.statusCode).toBe(400);
    // The session was NOT bound — a subsequent well-formed resume still mints (not the idempotent path).
    const after = await resumeIdentity(app, session, 2);
    expect(after.status).toBe(200);
    expect(after.currentUser.id).toMatch(/^user\./);
  });
});

describe("deploy hardening (docs/15)", () => {
  it("ends the caller's session so the next request mints a fresh identity (#4)", async () => {
    const app = await makeApp();
    const user = await newSession(app);

    const end = await app.server.inject({
      method: "POST",
      url: "/api/session/end",
      headers: { cookie: user.cookie },
    });
    expect(end.statusCode).toBe(200);
    // The Set-Cookie clears the session cookie (Max-Age=0).
    expect(String(end.headers["set-cookie"])).toContain("Max-Age=0");

    // Reusing the now-invalidated cookie mints a brand-new identity rather than the wiped one.
    const after = await app.server.inject({ method: "GET", url: "/api/config", headers: { cookie: user.cookie } });
    const newId = (after.json() as { currentUser: { id: string } }).currentUser.id;
    expect(newId).not.toBe(user.userId);
  });

  it("session/end is a safe no-op on an absent/unknown cookie and never mints a session (#4)", async () => {
    const app = await makeApp();
    const usersBefore = app.store.loadUsers().length;

    // No cookie at all.
    const none = await app.server.inject({ method: "POST", url: "/api/session/end" });
    expect(none.statusCode).toBe(200);
    // An unknown token.
    const unknown = await app.server.inject({
      method: "POST",
      url: "/api/session/end",
      headers: { cookie: "loam_session=deadbeef" },
    });
    expect(unknown.statusCode).toBe(200);

    // Crucially, ending a session must not itself create an identity.
    expect(app.store.loadUsers().length).toBe(usersBefore);
  });

  it("mints a setup code when a PATCH switches bootstrap into setupCode, enabling claims (#8)", async () => {
    const app = await makeApp(); // firstUser bootstrap: the first session becomes admin
    const admin = await newSession(app);

    const before = (
      await app.server.inject({ method: "GET", url: "/api/config", headers: { cookie: admin.cookie } })
    ).json() as { networkConfig: { allowAdminClaim: boolean } };
    expect(before.networkConfig.allowAdminClaim).toBe(false);

    const patch = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { admin: { bootstrap: "setupCode" } },
    });
    expect(patch.statusCode).toBe(200);

    const after = (
      await app.server.inject({ method: "GET", url: "/api/config", headers: { cookie: admin.cookie } })
    ).json() as { networkConfig: { allowAdminClaim: boolean } };
    expect(after.networkConfig.allowAdminClaim).toBe(true);
    expect(app.getAdminSetupCode()).toBeTruthy(); // a usable single-use code was actually minted
  });

  it("clears the setup code when bootstrap switches away, re-minting a fresh one on switching back (#8)", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const setBootstrap = (bootstrap: string) =>
      app.server.inject({
        method: "PATCH",
        url: "/api/admin/config",
        headers: { cookie: admin.cookie },
        payload: { admin: { bootstrap } },
      });

    await setBootstrap("setupCode");
    const code1 = app.getAdminSetupCode();
    expect(code1).toBeTruthy();

    // Switching away invalidates the outstanding code immediately.
    await setBootstrap("firstUser");
    expect(app.getAdminSetupCode()).toBeUndefined();

    // Switching back mints a FRESH code, not the abandoned one.
    await setBootstrap("setupCode");
    expect(app.getAdminSetupCode()).toBeTruthy();
    expect(app.getAdminSetupCode()).not.toBe(code1);
  });

  it("prunes peerSyncStatus when a peer is removed via config PATCH (#9)", async () => {
    const app = await makeApp({ sync: { enabled: true, peers: [{ url: "http://peer-a.invalid" }] } });
    const admin = await newSession(app);

    // Force a sync attempt so the peer gets a live status entry, then confirm it's reported.
    await app.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie: admin.cookie } });
    const before = (
      await app.server.inject({ method: "GET", url: "/api/admin/sync", headers: { cookie: admin.cookie } })
    ).json() as { peers: { url: string; status?: unknown }[] };
    expect(before.peers.some((peer) => peer.url === "http://peer-a.invalid" && peer.status)).toBe(true);

    // Remove the peer; its status must be pruned, not linger.
    await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { sync: { peers: [] } },
    });
    const after = (
      await app.server.inject({ method: "GET", url: "/api/admin/sync", headers: { cookie: admin.cookie } })
    ).json() as { peers: { url: string }[] };
    expect(after.peers.some((peer) => peer.url === "http://peer-a.invalid")).toBe(false);

    // Re-adding the same peer creates a fresh status entry — the prune cleared the slot, it didn't
    // just filter the report.
    await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { sync: { peers: [{ url: "http://peer-a.invalid" }] } },
    });
    await app.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie: admin.cookie } });
    const readded = (
      await app.server.inject({ method: "GET", url: "/api/admin/sync", headers: { cookie: admin.cookie } })
    ).json() as { peers: { url: string; status?: unknown }[] };
    expect(readded.peers.some((peer) => peer.url === "http://peer-a.invalid" && peer.status)).toBe(true);
  });

  it("prunes expired per-IP rate-limiter entries so the maps stay bounded (#9)", async () => {
    // setupCode bootstrap so a claim attempt populates the claim limiter; minting a session
    // populates the identity budget. Both key on the caller IP.
    const app = await makeApp({ admin: { bootstrap: "setupCode" } });
    await newSession(app);
    const rejected = await app.server.inject({
      method: "POST",
      url: "/api/admin/claim",
      payload: { secret: "wrong" },
    });
    expect(rejected.statusCode).toBe(403);

    const before = app.rateLimiterEntryCounts();
    expect(before.identity).toBeGreaterThan(0);
    expect(before.claim).toBeGreaterThan(0);

    // Advance the clock past both windows (claim 5 min, identity 10 min), then prune. Expired entries
    // must be dropped, not linger one-per-IP forever.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 11 * 60_000);
      app.pruneExpiredRateLimiters();
    } finally {
      vi.useRealTimers();
    }

    const after = app.rateLimiterEntryCounts();
    expect(after.identity).toBe(0);
    expect(after.claim).toBe(0);
  });
});

describe("location sharing (docs/10)", () => {
  it("rejects a shared location when the feature is off (default), accepts it when on", async () => {
    const off = await makeApp();
    const offUser = await newSession(off);
    const rejected = await off.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: offUser.cookie },
      payload: { type: "channelPost", channelId: "general", body: "meet here", location: { label: "north gate" } },
    });
    expect(rejected.statusCode).toBe(400);

    const on = await makeApp({ features: { enableLocationSharing: true } });
    const onUser = await newSession(on);
    const accepted = await on.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: onUser.cookie },
      payload: {
        type: "channelPost",
        channelId: "general",
        body: "",
        location: { label: "north gate", lat: 51.5, lng: -0.12 },
      },
    });
    expect(accepted.statusCode).toBe(201);
    const stored = (accepted.json() as { message: { location?: { label?: string; lat?: number; lng?: number } } }).message;
    expect(stored.location).toEqual({ label: "north gate", lat: 51.5, lng: -0.12 });

    // Config advertises the flag to the client.
    const cfg = (await on.server.inject({ method: "GET", url: "/api/config", headers: { cookie: onUser.cookie } }))
      .json() as { networkConfig: { enableLocationSharing: boolean } };
    expect(cfg.networkConfig.enableLocationSharing).toBe(true);
  });

  it("rejects a location with neither a label nor coordinates", async () => {
    const app = await makeApp({ features: { enableLocationSharing: true } });
    const user = await newSession(app);
    const res = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: user.cookie },
      payload: { type: "channelPost", channelId: "general", body: "x", location: { lat: 51.5 } },
    });
    expect(res.statusCode).toBe(400);
  });
});
