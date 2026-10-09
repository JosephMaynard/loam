/**
 * The service worker's decisions, kept pure so they are unit-testable here: the worker itself
 * (`src/service-worker.ts`) is bundled on its own at build time and runs where vitest's jsdom can't.
 *
 * What the worker is for, and what it must never do:
 *
 *  - The app shell works offline: the shell (`index.html`) and every file of this build are precached
 *    on install, so a device that joined once can open the app with no node in reach.
 *  - A navigation reveals nothing. The server answers every route with the same `index.html` (its SPA
 *    fallback), so the worker answers every navigation from ONE request for the shell path, whatever the
 *    address bar says. A reload of `/dm/<user id>` or `/search` therefore puts `/` on the wire, not the
 *    conversation, and Cache Storage holds one entry keyed `/`, never a route. (Cache Storage is cleared
 *    by name on a device wipe, but it outlives an identity change, so route keys must never land there.)
 *  - Only this build's own files are cached. Any other same-origin GET goes to the network untouched.
 *
 * A deploy is picked up because the worker script embeds the build id: new bytes mean a new worker,
 * which precaches under a new cache name and drops the old cache on activate.
 */

/** What the worker knows about the build it was generated for. */
export interface ServiceWorkerBuild {
  /** The shell's path (the app's `base`): every navigation is answered from this one request. */
  shellPath: string;
  /** This build's files, each cached under its own path: the hashed bundles and the public files. */
  assetPaths: ReadonlySet<string>;
}

/** The parts of a `Request` the decision looks at. */
export interface RequestFacts {
  method: string;
  url: string;
  mode: string;
  destination: string;
}

/**
 * Where a request goes: `network` is left to the browser entirely (the worker doesn't answer), `shell`
 * is answered from the shell path (network first, the cached shell when offline), `asset` is answered
 * cache first under `path` and fetched (then cached) on a miss.
 */
export type ServiceWorkerRoute = { kind: "network" } | { kind: "shell" } | { kind: "asset"; path: string };

/** Paths the worker never touches: the API (and its images) and the socket. */
const PASSTHROUGH_PREFIXES = ["/api", "/ws"];

/** Decide how the worker answers `request`; `origin` is the worker's own. */
export function routeRequest(request: RequestFacts, origin: string, build: ServiceWorkerBuild): ServiceWorkerRoute {
  if (request.method !== "GET") {
    return { kind: "network" };
  }
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return { kind: "network" };
  }
  if (url.origin !== origin || PASSTHROUGH_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) {
    return { kind: "network" };
  }
  // A build file is a build file however it was asked for (an icon opened in a tab is still the icon).
  if (build.assetPaths.has(url.pathname)) {
    return { kind: "asset", path: url.pathname };
  }
  if (request.mode === "navigate" || request.destination === "document") {
    return { kind: "shell" };
  }
  return { kind: "network" };
}

/** Everything to precache on install: the shell, then each build file. */
export function precachePaths(build: ServiceWorkerBuild): string[] {
  return [build.shellPath, ...build.assetPaths];
}

/** The cache for a build: a new name per build, so activating a new worker evicts the old files. */
export function cacheNameFor(buildId: string): string {
  return `loam-shell-${buildId}`;
}

/** The caches an activating worker deletes: every one that isn't its own. */
export function staleCacheNames(names: readonly string[], current: string): string[] {
  return names.filter((name) => name !== current);
}
