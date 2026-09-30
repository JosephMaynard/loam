import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { contentTypeFor, resolveClientPath } from "./static-files.js";
import type { LoamApp } from "./types.js";

const SHELL = "<!doctype html><title>shell</title>";

describe("resolveClientPath", () => {
  const root = "/srv/client";

  it("maps a request path to a file under the root, ignoring the query and fragment", () => {
    expect(resolveClientPath(root, "/")).toBe("/srv/client/");
    expect(resolveClientPath(root, "/assets/index-abc.js?v=2#x")).toBe("/srv/client/assets/index-abc.js");
    expect(resolveClientPath(root, "/caf%C3%A9.png")).toBe("/srv/client/café.png");
  });

  it("never climbs out of the root", () => {
    for (const url of ["/../secret", "/%2e%2e/secret", "/assets/..%2f..%2fsecret", "/a/b/../../../secret"]) {
      const file = resolveClientPath(root, url);
      expect(file === undefined || file.startsWith("/srv/client/") || file === "/srv/client").toBe(true);
      expect(file).not.toBe("/srv/secret");
    }
  });

  it("refuses dotfiles, null bytes, backslashes and undecodable paths", () => {
    for (const url of ["/.env", "/.git/config", "/assets/.hidden", "/%00", "/a%5c..%5csecret", "/%E0%A4%A"]) {
      expect(resolveClientPath(root, url), url).toBeUndefined();
    }
  });
});

describe("contentTypeFor", () => {
  it("covers the build's file types, falling back to opaque bytes", () => {
    expect(contentTypeFor("index.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("a.JS")).toBe("application/javascript; charset=utf-8");
    expect(contentTypeFor("manifest.webmanifest")).toBe("application/manifest+json");
    expect(contentTypeFor("loam.svg")).toBe("image/svg+xml");
    expect(contentTypeFor("archive.zip")).toBe("application/octet-stream");
  });
});

describe("serving the client build (buildApp)", () => {
  let base: string;
  let app: LoamApp;

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), "loam-static-"));
    const dist = join(base, "dist");
    mkdirSync(join(dist, "assets"), { recursive: true });
    writeFileSync(join(dist, "index.html"), SHELL);
    writeFileSync(join(dist, "assets", "index-abc.js"), "console.log(1);");
    writeFileSync(join(dist, "manifest.webmanifest"), "{}");
    writeFileSync(join(dist, ".env"), "SECRET=dotfile");
    writeFileSync(join(base, "secret.txt"), "outside the root");
    app = await buildApp({ dataDir: join(base, "data"), clientDistDir: dist, logStream: { write() {} } });
  });

  afterAll(async () => {
    await app.close();
    rmSync(base, { recursive: true, force: true });
  });

  it("serves a file with its type and revalidation headers", async () => {
    const response = await app.server.inject({ method: "GET", url: "/assets/index-abc.js" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("console.log(1);");
    expect(response.headers["content-type"]).toBe("application/javascript; charset=utf-8");
    expect(response.headers["content-length"]).toBe("15");
    expect(response.headers["cache-control"]).toBe("public, max-age=0");
    expect(response.headers.etag).toMatch(/^W\/"/);
    expect(response.headers["last-modified"]).toBeDefined();
  });

  it("answers / and SPA routes with the shell, under the CSP", async () => {
    for (const url of ["/", "/channels", "/channel/general/thread/x", "/assets/missing.js"]) {
      const response = await app.server.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(200);
      expect(response.body, url).toBe(SHELL);
      expect(response.headers["content-security-policy"], url).toContain("default-src 'self'");
    }
  });

  it("keeps unknown /api/ paths a JSON 404", async () => {
    const response = await app.server.inject({ method: "GET", url: "/api/nope" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "Not found" });
  });

  it("never serves a file outside the root, or a dotfile", async () => {
    for (const url of ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt", "/.env", "/%00"]) {
      const response = await app.server.inject({ method: "GET", url });
      expect(response.body, url).not.toContain("outside the root");
      expect(response.body, url).not.toContain("SECRET=");
    }
  });

  it("answers HEAD with the real length and no body", async () => {
    const response = await app.server.inject({ method: "HEAD", url: "/assets/index-abc.js" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-length"]).toBe("15");
    expect(response.body).toBe("");
  });

  it("answers a matching conditional request with 304", async () => {
    const first = await app.server.inject({ method: "GET", url: "/manifest.webmanifest" });
    const byTag = await app.server.inject({
      method: "GET",
      url: "/manifest.webmanifest",
      headers: { "if-none-match": String(first.headers.etag) },
    });
    const byDate = await app.server.inject({
      method: "GET",
      url: "/manifest.webmanifest",
      headers: { "if-modified-since": String(first.headers["last-modified"]) },
    });
    const stale = await app.server.inject({
      method: "GET",
      url: "/manifest.webmanifest",
      headers: { "if-none-match": 'W/"0-0"' },
    });
    expect([byTag.statusCode, byDate.statusCode, stale.statusCode]).toEqual([304, 304, 200]);
    expect(byTag.body).toBe("");
  });

  it("parses If-None-Match as quoted tags, with * only as the whole header", async () => {
    const first = await app.server.inject({ method: "GET", url: "/manifest.webmanifest" });
    const etag = String(first.headers.etag);
    const status = async (ifNoneMatch: string) =>
      (await app.server.inject({ method: "GET", url: "/manifest.webmanifest", headers: { "if-none-match": ifNoneMatch } }))
        .statusCode;
    // A single opaque tag whose value contains commas and a star is one non-matching tag.
    expect(await status('"a,*,b"')).toBe(200);
    expect(await status("*")).toBe(304);
    // The current tag inside a list, strong or weak, still matches.
    expect(await status(`"other", ${etag}`)).toBe(304);
    expect(await status(`"other", ${etag.replace(/^W\//, "")}`)).toBe(304);
  });

  it("is rate-limited by the global limiter like every other route", async () => {
    // CodeQL's missing-rate-limiting query can't see the limiter, which attaches in an onRoute hook
    // (rate-limit.ts). The shell route counts against the global 300/min per-IP budget.
    const statuses: number[] = [];
    for (let index = 0; index < 305; index += 1) {
      statuses.push(
        (await app.server.inject({ method: "GET", url: "/assets/index-abc.js", remoteAddress: "10.9.9.9" })).statusCode,
      );
    }
    expect(statuses.slice(0, 300).every((code) => code === 200)).toBe(true);
    expect(statuses.slice(300)).toEqual([429, 429, 429, 429, 429]);
  });
});
