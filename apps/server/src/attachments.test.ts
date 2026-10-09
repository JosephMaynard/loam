import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type LoamApp } from "./app.js";
import { attachmentContentDisposition, sanitizeAttachmentName } from "./media.js";
import { cleanups, type InjectResponse, makeApp, newSession, teardownApps } from "./test-support/app-harness.js";
import { resetFsFaults, rmGate } from "./test-support/fs-faults.js";

// `node:fs` fault-injection seams (inert unless a test arms one): see test-support/fs-faults.ts.
vi.mock("node:fs", async (importOriginal) =>
  (await import("./test-support/fs-faults.js")).faultyFs(await importOriginal()),
);
vi.mock("node:fs/promises", async (importOriginal) =>
  (await import("./test-support/fs-faults.js")).faultyFsPromises(await importOriginal()),
);

afterEach(async () => {
  resetFsFaults();
  await teardownApps();
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

describe("avatar image ids", () => {
  const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const webp = Buffer.from("RIFF\0\0\0\0WEBP").toString("base64");

  async function uploadAvatar(app: LoamApp, cookie: string): Promise<string> {
    const res = await app.server.inject({
      method: "PUT",
      url: "/api/users/me/avatar-image",
      headers: { cookie },
      payload: { mimeType: "image/webp", data: webp },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { avatar: { imageId: string } }).avatar.imageId;
  }

  async function uploadPng(app: LoamApp, cookie: string): Promise<{ id: string; mimeType: string }> {
    const res = await app.server.inject({
      method: "POST",
      url: "/api/attachments",
      headers: { cookie },
      payload: { mimeType: "image/png", data: tinyPng },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; mimeType: string };
  }

  const avatarConfig = { identity: { allowUserAvatarEdit: true, allowUserAvatarUpload: true } };

  it("refuses a profile edit that points the avatar at ANOTHER user's image file (which survives)", async () => {
    const { app, dataDir } = await makeApp(avatarConfig);
    const alice = await newSession(app);
    const bob = await newSession(app);
    const bobImageId = await uploadAvatar(app, bob.cookie);
    const bobFile = join(dataDir, "avatars", `${bobImageId}.webp`);

    const hijack = await app.server.inject({
      method: "PATCH",
      url: "/api/users/me",
      headers: { cookie: alice.cookie },
      payload: { avatar: { kind: "image", imageId: bobImageId, mimeType: "image/webp" } },
    });
    expect(hijack.statusCode).toBe(400);
    expect(hijack.json()).toMatchObject({ code: "invalid_user_update" });

    // Alice's next upload replaces HER avatar — it must never remove Bob's file.
    await uploadAvatar(app, alice.cookie);
    expect(existsSync(bobFile)).toBe(true);
  });

  it("refuses a traversal imageId, so the next upload can't delete a message attachment", async () => {
    const { app, dataDir } = await makeApp(avatarConfig);
    const alice = await newSession(app);
    const attachment = await uploadPng(app, alice.cookie);
    const attachmentFile = join(dataDir, "attachments", `${attachment.id}.png`);
    expect(existsSync(attachmentFile)).toBe(true);

    const traversal = await app.server.inject({
      method: "PATCH",
      url: "/api/users/me",
      headers: { cookie: alice.cookie },
      payload: { avatar: { kind: "image", imageId: `../attachments/${attachment.id}`, mimeType: "image/png" } },
    });
    expect(traversal.statusCode).toBe(400);

    await uploadAvatar(app, alice.cookie);
    expect(existsSync(attachmentFile)).toBe(true);
  });

  it("applies the same rule to the admin user edit, but accepts an unchanged current image avatar", async () => {
    const { app, dataDir } = await makeApp(avatarConfig);
    const admin = await newSession(app);
    const member = await newSession(app);
    const adminImageId = await uploadAvatar(app, admin.cookie);
    const memberImageId = await uploadAvatar(app, member.cookie);

    const aimed = await app.server.inject({
      method: "PATCH",
      url: `/api/users/${member.userId}`,
      headers: { cookie: admin.cookie },
      payload: { avatar: { kind: "image", imageId: adminImageId, mimeType: "image/webp" } },
    });
    expect(aimed.statusCode).toBe(400);

    // Sending the member's own current image avatar back unchanged is a harmless no-op edit.
    const unchanged = await app.server.inject({
      method: "PATCH",
      url: "/api/users/me",
      headers: { cookie: member.cookie },
      payload: { avatar: { kind: "image", imageId: memberImageId, mimeType: "image/webp" } },
    });
    expect(unchanged.statusCode).toBe(200);
    expect(existsSync(join(dataDir, "avatars", `${adminImageId}.webp`))).toBe(true);
  });

  it("boots past a legacy user row whose stored avatar names a non-avatar path (the avatar is dropped)", async () => {
    const { app, dataDir } = await makeApp();
    const user = await newSession(app);
    // Write the row the pre-fix hole could have stored, bypassing today's schema.
    const raw = {
      id: user.userId,
      displayName: "Legacy",
      type: "human",
      isAdmin: false,
      createdAt: 1,
      ephemeral: false,
      avatar: { kind: "image", imageId: "../../x", mimeType: "image/png" },
    };
    await app.close();
    const { DatabaseSync } = await import("node:sqlite");
    const sqlite = new DatabaseSync(join(dataDir, "loam.db"));
    sqlite.prepare("UPDATE users SET data = ? WHERE id = ?").run(JSON.stringify(raw), user.userId);
    sqlite.close();

    const reopened = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false });
    cleanups.push(() => reopened.close());
    const loaded = reopened.store.loadUsers().find((candidate) => candidate.id === user.userId);
    expect(loaded?.displayName).toBe("Legacy");
    expect(loaded?.avatar).toBeUndefined();
  });
});

describe("avatar file sweep", () => {
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

  it("reaps avatar image files no user references (boot sweep) and keeps referenced ones", async () => {
    const { app, dataDir } = await makeApp({ identity: { allowUserAvatarEdit: true, allowUserAvatarUpload: true } });
    const session = await newSession(app);
    const webp = Buffer.from("RIFF\0\0\0\0WEBP").toString("base64");
    const upload = await app.server.inject({
      method: "PUT",
      url: "/api/users/me/avatar-image",
      headers: { cookie: session.cookie },
      payload: { mimeType: "image/webp", data: webp },
    });
    expect(upload.statusCode).toBe(200);
    const imageId = (upload.json() as { avatar: { imageId: string } }).avatar.imageId;
    const stray = join(dataDir, "avatars", "avt_0123456789abcdef.webp");
    writeFileSync(stray, "RIFF\0\0\0\0WEBP");
    // Files younger than the in-flight grace window are never swept (an upload writes its file before the
    // user record references it) — age both past it so the sweep's decision is about references alone.
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(stray, old, old);
    utimesSync(join(dataDir, "avatars", `${imageId}.webp`), old, old);

    await app.reapOrphanedAvatars();
    expect(existsSync(stray)).toBe(false);
    expect(existsSync(join(dataDir, "avatars", `${imageId}.webp`))).toBe(true);

    // An ephemeral-style restart: the database vanishes, the avatar file must not outlive it.
    await app.close();
    for (const name of ["loam.db", "loam.db-wal", "loam.db-shm"]) {
      rmSync(join(dataDir, name), { force: true });
    }
    utimesSync(join(dataDir, "avatars", `${imageId}.webp`), old, old);
    const reopened = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false });
    cleanups.push(() => reopened.close());
    expect(await waitFor(() => !existsSync(join(dataDir, "avatars", `${imageId}.webp`)))).toBe(true);
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

  it("keeps a lone surrogate in a file name from failing the download header", async () => {
    // The sanitiser drops an unpaired half of a UTF-16 pair (it has no UTF-8 form, so `encodeURIComponent`
    // throws on it), including one created by the length cut; the header builder never throws regardless.
    expect(sanitizeAttachmentName("bad\uD83Dname.txt")).toBe("bad_name.txt");
    expect(sanitizeAttachmentName("\uDE00start.txt")).toBe("_start.txt");
    expect(sanitizeAttachmentName("ok😀.txt")).toBe("ok😀.txt");
    expect(sanitizeAttachmentName(`${"a".repeat(254)}😀`)).toBe(`${"a".repeat(254)}_`);
    expect(() => attachmentContentDisposition("\uD83D")).not.toThrow();
    expect(attachmentContentDisposition("报告.txt")).toBe(`attachment; filename="__.txt"; filename*=UTF-8''${encodeURIComponent("报告.txt")}`);

    const app = await makeApp();
    const session = await newSession(app);
    const uploaded = await app.server.inject({
      method: "POST",
      url: "/api/attachments",
      headers: { cookie: session.cookie },
      payload: { mimeType: "text/plain", data: Buffer.from("hello").toString("base64"), name: "bad\uD83Dname.txt" },
    });
    expect(uploaded.statusCode).toBe(201);
    const attachment = uploaded.json() as { id: string; name?: string };
    expect(attachment.name).toBe("bad_name.txt");
    // The download name comes from the owning message's attachment record.
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: "/api/messages",
          headers: { cookie: session.cookie },
          payload: { type: "channelPost", channelId: "general", body: "a file", attachments: [attachment] },
        })
      ).statusCode,
    ).toBe(201);

    const served = await app.server.inject({
      method: "GET",
      url: `/api/attachments/${attachment.id}.bin`,
      headers: { cookie: session.cookie },
    });
    expect(served.statusCode).toBe(200);
    expect(String(served.headers["content-disposition"])).toContain("filename*=UTF-8''bad_name.txt");
  });

  it("uploads a non-image file, serves it as a forced download, and rejects a script/XSS type", async () => {
    const app = await makeApp();
    const session = await newSession(app);

    // A non-Latin1 filename (CJK/emoji) must not crash the download header (RFC 6266 filename*).
    const uploaded = await app.server.inject({
      method: "POST",
      url: "/api/attachments",
      headers: { cookie: session.cookie },
      payload: { mimeType: "text/plain", data: Buffer.from("hello, world").toString("base64"), name: "报告😀.txt" },
    });
    expect(uploaded.statusCode).toBe(201);
    const attachment = uploaded.json() as { id: string; mimeType: string; name?: string };
    expect(attachment.mimeType).toBe("text/plain");
    expect(attachment.name).toBe("报告😀.txt");

    // The uploader fetches their pending file — served as a FORCED DOWNLOAD (octet-stream + attachment),
    // never inline, so an uploaded HTML/SVG could not execute in a browser. The unicode name round-trips via
    // filename* (a bare filename="…" with those bytes would make Node throw ERR_INVALID_CHAR → 500).
    const served = await app.server.inject({
      method: "GET",
      url: `/api/attachments/${attachment.id}.bin`,
      headers: { cookie: session.cookie },
    });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toContain("application/octet-stream");
    expect(String(served.headers["content-disposition"])).toContain("attachment");
    expect(String(served.headers["content-disposition"])).toContain("filename*=UTF-8''");

    // A script-executable type is not in the allowlist → rejected at upload.
    const html = await app.server.inject({
      method: "POST",
      url: "/api/attachments",
      headers: { cookie: session.cookie },
      payload: { mimeType: "text/html", data: Buffer.from("<script>alert(1)</script>").toString("base64") },
    });
    expect(html.statusCode).toBe(400);
  });

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

describe("attachment size caps", () => {
  it("accepts a non-image attachment near the advertised 1 MiB cap; over-cap rejects semantically", async () => {
    const app = await makeApp();
    const admin = await newSession(app);

    // ~1 MiB raw → ≈1.37 MiB as a base64 JSON envelope: over Fastify's old 1 MiB default transport
    // cap (which made the advertised limit unreachable from ~790 KB), inside the new one.
    const nearCap = Buffer.alloc(1024 * 1024 - 16, 7);
    const ok = await app.server.inject({
      method: "POST",
      url: "/api/attachments",
      headers: { cookie: admin.cookie },
      payload: { mimeType: "application/pdf", data: nearCap.toString("base64") },
    });
    expect(ok.statusCode).toBe(201);

    // One byte over the DECODED cap: the semantic 400, never the transport 413.
    const overCap = Buffer.alloc(1024 * 1024 + 1, 7);
    const rejected = await app.server.inject({
      method: "POST",
      url: "/api/attachments",
      headers: { cookie: admin.cookie },
      payload: { mimeType: "application/pdf", data: overCap.toString("base64") },
    });
    expect(rejected.statusCode).toBe(400);
  });
});

describe("attachment access and the orphan sweep", () => {
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

  it("withholds a shadow-banned author's public attachment from others, still serves the author", async () => {
    const app = await makeApp();
    const admin = await newSession(app); // first session → admin (firstUser bootstrap)
    const author = await newSession(app);
    const viewer = await newSession(app);

    const attachment = await uploadAttachment(app, author.cookie);
    await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: author.cookie },
      payload: { type: "channelPost", channelId: "general", body: "", attachments: [attachment] },
    });
    const path = `/api/attachments/${attachment.id}.png`;

    // Baseline: a public-channel attachment is anonymously fetchable.
    expect((await app.server.inject({ method: "GET", url: path })).statusCode).toBe(200);

    const shadow = await app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${author.userId}`,
      headers: { cookie: admin.cookie },
      payload: { shadowBanned: true },
    });
    expect(shadow.statusCode).toBe(200);

    // After shadow-ban the message is withheld from everyone but the author — the attachment must follow.
    // (Author still 200; another authenticated user 404 — the defense-in-depth this covers; anon 404 too.)
    expect((await app.server.inject({ method: "GET", url: path, headers: { cookie: author.cookie } })).statusCode).toBe(200);
    expect((await app.server.inject({ method: "GET", url: path, headers: { cookie: viewer.cookie } })).statusCode).toBe(404);
    expect((await app.server.inject({ method: "GET", url: path })).statusCode).toBe(404);
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

    // Restart-orphan: a file on disk with no pending entry and no referencing message, older than the
    // grace window (a fresh owner-less file may be a sync import about to be referenced — see below).
    mkdirSync(attachmentsDir, { recursive: true });
    const strayPath = join(attachmentsDir, "att_00000000000000ff.png");
    writeFileSync(strayPath, Buffer.from(tinyPng, "base64"));
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(strayPath, old, old);

    await app.reapOrphanedAttachments();

    expect(existsSync(join(attachmentsDir, `${attached.id}.png`))).toBe(true);
    expect(existsSync(join(attachmentsDir, `${pending.id}.png`))).toBe(true);
    expect(existsSync(strayPath)).toBe(false);
  });
});

describe("orphan attachment sweep", () => {
  const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  async function uploadPng(app: LoamApp, cookie: string): Promise<{ id: string; mimeType: string }> {
    const res = await app.server.inject({
      method: "POST",
      url: "/api/attachments",
      headers: { cookie },
      payload: { mimeType: "image/png", data: tinyPng },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; mimeType: string };
  }

  async function post(app: LoamApp, cookie: string, payload: Record<string, unknown>): Promise<InjectResponse> {
    return app.server.inject({ method: "POST", url: "/api/messages", headers: { cookie }, payload });
  }

  it("keeps a fresh owner-less file (e.g. a sync import not yet referenced) until the grace passes", async () => {
    const { app, dataDir } = await makeApp();
    const attachmentsDir = join(dataDir, "attachments");
    mkdirSync(attachmentsDir, { recursive: true });
    const fresh = join(attachmentsDir, "att_00000000000000aa.png");
    writeFileSync(fresh, Buffer.from(tinyPng, "base64"));

    await app.reapOrphanedAttachments();
    expect(existsSync(fresh)).toBe(true);

    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(fresh, old, old);
    await app.reapOrphanedAttachments();
    expect(existsSync(fresh)).toBe(false);
  });

  it("never deletes an upload consumed by a message created while the sweep is mid-loop", async () => {
    const { app, dataDir } = await makeApp();
    const user = await newSession(app);
    const attachmentsDir = join(dataDir, "attachments");
    const upload = await uploadPng(app, user.cookie);
    const uploadPath = join(attachmentsDir, `${upload.id}.png`);
    // Sorted first, so the sweep parks in its rm BEFORE it reaches the upload.
    const stray = join(attachmentsDir, "att_0000000000000000.png");
    writeFileSync(stray, Buffer.from(tinyPng, "base64"));
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(stray, old, old);
    utimesSync(uploadPath, old, old);

    let release: () => void = () => undefined;
    rmGate.promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const parked = new Promise<void>((resolve) => {
      rmGate.entered = resolve;
    });
    const sweep = app.reapOrphanedAttachments();
    await parked;

    // While the sweep awaits the stray's rm, the upload is consumed by a new message.
    const created = await post(app, user.cookie, { type: "channelPost", channelId: "general", body: "", attachments: [upload] });
    expect(created.statusCode).toBe(201);

    rmGate.promise = undefined;
    release();
    await sweep;

    expect(existsSync(stray)).toBe(false);
    expect(existsSync(uploadPath)).toBe(true);
  });
});
