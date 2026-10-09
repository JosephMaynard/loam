/**
 * The PWA service worker. Bundled by the `loam:service-worker` plugin in `vite.config.ts` into
 * `dist/service-worker.js` AFTER the app, with this build's file list and content hash defined in, so
 * the decisions in `lib/service-worker-routing.ts` (the tested part) see exactly what was emitted.
 * Registered by `main.tsx` in production only; `vite dev` never serves it.
 *
 * Install precaches the shell and every build file, one `add` each so a single missing file can't fail
 * the whole install. Activate drops every cache but this build's and takes over the open pages.
 * Navigations are network first from the single shell path (a deploy is never masked by a stale shell)
 * and fall back to the cached shell offline; build files are cache first.
 */
import { cacheNameFor, precachePaths, routeRequest, staleCacheNames, type ServiceWorkerBuild } from "./lib/service-worker-routing";

// Defined by the plugin per build (`define`); the declarations only exist for the type-check.
declare const __LOAM_SW_BUILD_ID__: string;
declare const __LOAM_SW_BASE__: string;
declare const __LOAM_SW_ASSETS__: readonly string[];

// The worker-global surface this file uses. The project's lib is DOM (the app), which has no worker
// scope; these structural types cover the three events and the two methods without pulling in the
// WebWorker lib, which can't coexist with DOM in one program.
interface ExtendableEventLike extends Event {
  waitUntil(promise: Promise<unknown>): void;
}

interface FetchEventLike extends ExtendableEventLike {
  readonly request: Request;
  respondWith(response: Promise<Response> | Response): void;
}

interface ServiceWorkerScopeLike {
  readonly location: Location;
  readonly clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: "install" | "activate", listener: (event: ExtendableEventLike) => void): void;
  addEventListener(type: "fetch", listener: (event: FetchEventLike) => void): void;
}

declare const self: ServiceWorkerScopeLike;

const CACHE_NAME = cacheNameFor(__LOAM_SW_BUILD_ID__);
const BUILD: ServiceWorkerBuild = { shellPath: __LOAM_SW_BASE__, assetPaths: new Set(__LOAM_SW_ASSETS__) };

/** Fetch every build file into this build's cache; a file that won't load is skipped, not fatal. */
async function precache(): Promise<void> {
  const cache = await caches.open(CACHE_NAME);
  await Promise.all(precachePaths(BUILD).map((path) => cache.add(path).catch(() => undefined)));
}

/** Delete the caches of every earlier build. */
async function dropStaleCaches(): Promise<void> {
  const names = await caches.keys();
  await Promise.all(staleCacheNames(names, CACHE_NAME).map((name) => caches.delete(name)));
}

/** Keep a fresh copy of `path` in this build's cache (best effort, off the response's critical path). */
function remember(event: ExtendableEventLike, path: string, response: Response): void {
  const copy = response.clone();
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(path, copy)));
}

/**
 * A navigation: the live shell when the node answers (so a deploy shows at once), else the cached one.
 * The request is for the shell path alone, whatever route the page is on; `no-cache` makes the browser
 * revalidate rather than trust its HTTP cache.
 */
async function serveShell(event: ExtendableEventLike): Promise<Response> {
  try {
    const response = await fetch(new Request(BUILD.shellPath, { cache: "no-cache" }));
    if (response.ok && !response.redirected) {
      remember(event, BUILD.shellPath, response);
    }
    return response;
  } catch {
    const cache = await caches.open(CACHE_NAME);
    // Always hand respondWith a Response: offline with no shell cached would otherwise resolve to
    // undefined and fail the navigation less clearly than a network error does.
    return (await cache.match(BUILD.shellPath)) ?? Response.error();
  }
}

/** A build file: the cached copy (hashed files are immutable), else the network, remembered on success. */
async function serveAsset(event: FetchEventLike, path: string): Promise<Response> {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(path);
  if (cached) {
    return cached;
  }
  try {
    const response = await fetch(event.request);
    if (response.ok) {
      remember(event, path, response);
    }
    return response;
  } catch {
    return Response.error();
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(dropStaleCaches().then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const route = routeRequest(event.request, self.location.origin, BUILD);
  if (route.kind === "shell") {
    event.respondWith(serveShell(event));
  } else if (route.kind === "asset") {
    event.respondWith(serveAsset(event, route.path));
  }
});
