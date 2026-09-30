// Serves the built web client (`clientDistDir`) — a small, fixed set of files — and replaces
// `@fastify/static` (and its `glob` / `minimatch` / `@fastify/send` / `mime` tree) with what LOAM uses:
//
//   - `GET|HEAD /*`: a file under the root, with a directory answered by its `index.html`. Anything that
//     isn't a file under the root (missing, a traversal attempt, a dotfile, a null byte) goes to the
//     not-found handler, which answers the SPA shell (or a JSON 404 under `/api/`).
//   - The same caching the plugin sent: `Cache-Control: public, max-age=0` plus a weak ETag and
//     Last-Modified, so a revisit revalidates with a 304. (The service worker, not HTTP caching, is what
//     keeps the shell available offline.)
//   - No Range support: every asset is small, and a Range request just gets the whole file (a 200, which
//     HTTP allows). Dotfiles are never served (the plugin allowed them; the build has none).
import { createReadStream, type Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, posix, resolve, sep } from "node:path";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/** Content types for what a Vite build emits; anything else is served as opaque bytes. */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

/** The content type for a file name (by extension, case-insensitive). */
export function contentTypeFor(fileName: string): string {
  return CONTENT_TYPES[extname(fileName).toLowerCase()] ?? "application/octet-stream";
}

/**
 * The file a request path names under `root`, or undefined when it names nothing servable: undecodable,
 * a null byte or backslash, a dotfile/dot-directory segment, or a path that resolves outside `root`.
 * `root` must be absolute and normalised (see {@link registerClientFiles}).
 */
export function resolveClientPath(root: string, rawUrl: string): string | undefined {
  const pathOnly = rawUrl.split(/[?#]/, 1)[0]!;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathOnly);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) {
    return undefined;
  }
  // Normalising against "/" folds every ".." at or above the root back to the root, so the join below
  // can't climb out; the prefix check after it is a second guard, not the only one.
  const normalised = posix.normalize(`/${decoded}`);
  if (normalised.split("/").some((segment) => segment.startsWith("."))) {
    return undefined;
  }
  const file = join(root, normalised);
  return file === root || file.startsWith(root + sep) ? file : undefined;
}

/** A weak validator from size + mtime, the same shape `send` used. */
function entityTag(stats: Stats): string {
  return `W/"${stats.size.toString(16)}-${stats.mtimeMs.toString(16)}"`;
}

/** Whether the request's conditional headers say the client's copy is current. */
function notModified(request: FastifyRequest, etag: string, stats: Stats): boolean {
  const ifNoneMatch = request.headers["if-none-match"];
  if (ifNoneMatch !== undefined) {
    // `*` / a list of entity tags. A tag's quoted value may itself contain commas (`"a,*,b"`), so match
    // whole quoted tags rather than splitting on commas; `*` counts only as the entire header. Weak
    // comparison: the W/ prefix is ignored.
    if (ifNoneMatch.trim() === "*") {
      return true;
    }
    const tags = [...ifNoneMatch.matchAll(/(?:W\/)?("[^"]*")/g)].map((match) => match[1]);
    return tags.includes(etag.replace(/^W\//, ""));
  }
  const ifModifiedSince = request.headers["if-modified-since"];
  if (ifModifiedSince !== undefined) {
    const since = Date.parse(ifModifiedSince);
    // HTTP dates have whole-second precision.
    return !Number.isNaN(since) && Math.floor(stats.mtimeMs / 1000) * 1000 <= since;
  }
  return false;
}

/** Send `file` (already stat'ed as a regular file) with the caching headers, or a 304. */
function sendFile(request: FastifyRequest, reply: FastifyReply, file: string, stats: Stats): FastifyReply {
  const etag = entityTag(stats);
  reply
    .header("cache-control", "public, max-age=0")
    .header("etag", etag)
    .header("last-modified", stats.mtime.toUTCString());
  if (notModified(request, etag, stats)) {
    return reply.code(304).send();
  }
  // A HEAD request gets the stream too: Fastify's HEAD handling drains it and keeps this content-length,
  // whereas an empty body would be reported as `content-length: 0`.
  return reply.code(200).type(contentTypeFor(file)).header("content-length", stats.size).send(createReadStream(file));
}

/** Stat `file` as a regular file, following a directory to its `index.html`; undefined when neither. */
async function servableFile(file: string): Promise<{ file: string; stats: Stats } | undefined> {
  try {
    let stats = await stat(file);
    if (stats.isDirectory()) {
      file = join(file, "index.html");
      stats = await stat(file);
    }
    return stats.isFile() ? { file, stats } : undefined;
  } catch {
    return undefined;
  }
}

/** What {@link registerClientFiles} gives the not-found handler. */
export interface ClientFiles {
  /** Answer with the SPA shell (`index.html`), status 200. */
  sendIndex(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply>;
}

/**
 * Register `GET|HEAD /*` serving files from `clientDistDir`. Unservable paths fall through to the
 * not-found handler (`reply.callNotFound()`), exactly as with the plugin.
 */
export function registerClientFiles(server: FastifyInstance, clientDistDir: string): ClientFiles {
  const root = resolve(clientDistDir);

  // Its own per-IP read cap, like the avatar/attachment routes, rather than the shared global budget:
  // a cold load fetches the shell plus a dozen-odd assets, which shouldn't eat into the API's allowance.
  // (Internal tunnel dispatches stay exempt via the inherited global allowList.)
  server.get("/*", { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } }, async (request, reply) => {
    const file = resolveClientPath(root, request.raw.url ?? "/");
    const found = file === undefined ? undefined : await servableFile(file);
    if (!found) {
      return reply.callNotFound();
    }
    return sendFile(request, reply, found.file, found.stats);
  });

  return {
    async sendIndex(request, reply) {
      const found = await servableFile(join(root, "index.html"));
      if (!found) {
        return reply.code(404).type("text/html; charset=utf-8").send("<h1>Not found</h1>");
      }
      return sendFile(request, reply, found.file, found.stats);
    },
  };
}
