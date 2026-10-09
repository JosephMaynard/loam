import { describe, expect, it } from "vitest";

import {
  cacheNameFor,
  precachePaths,
  routeRequest,
  staleCacheNames,
  type RequestFacts,
  type ServiceWorkerBuild,
} from "./service-worker-routing";

const ORIGIN = "http://10.0.0.1:3000";
const BUILD: ServiceWorkerBuild = {
  shellPath: "/",
  assetPaths: new Set(["/assets/index-abc123.js", "/assets/index-abc123.css", "/manifest.webmanifest", "/loam.svg"]),
};

function navigation(path: string): RequestFacts {
  return { method: "GET", url: `${ORIGIN}${path}`, mode: "navigate", destination: "document" };
}

function subresource(path: string, destination = "script"): RequestFacts {
  return { method: "GET", url: `${ORIGIN}${path}`, mode: "no-cors", destination };
}

describe("routeRequest", () => {
  it("answers every navigation from the one shell path, so a route never reaches the wire or the cache", () => {
    for (const path of ["/", "/channels", "/dm/user.0123456789abcdef", "/channel/general/thread/msg.1", "/search?q=secret%20plans", "/index.html"]) {
      expect(routeRequest(navigation(path), ORIGIN, BUILD)).toEqual({ kind: "shell" });
    }
  });

  it("serves a build file cache first under its own path, even when it is opened directly", () => {
    expect(routeRequest(subresource("/assets/index-abc123.js"), ORIGIN, BUILD)).toEqual({ kind: "asset", path: "/assets/index-abc123.js" });
    expect(routeRequest(subresource("/manifest.webmanifest", "manifest"), ORIGIN, BUILD)).toEqual({ kind: "asset", path: "/manifest.webmanifest" });
    expect(routeRequest(navigation("/loam.svg"), ORIGIN, BUILD)).toEqual({ kind: "asset", path: "/loam.svg" });
  });

  it("leaves the API, the socket and anything that isn't a build file to the network", () => {
    expect(routeRequest(subresource("/api/attachments/att_1.webp", "image"), ORIGIN, BUILD)).toEqual({ kind: "network" });
    expect(routeRequest(navigation("/api/config"), ORIGIN, BUILD)).toEqual({ kind: "network" });
    expect(routeRequest(subresource("/ws?enc=abc", ""), ORIGIN, BUILD)).toEqual({ kind: "network" });
    // A same-origin GET for a path this build didn't emit is not cached either: a stale worker must not
    // store a newer deploy's chunk (or anything a page fetches) under its own cache.
    expect(routeRequest(subresource("/assets/index-newer.js"), ORIGIN, BUILD)).toEqual({ kind: "network" });
    expect(routeRequest(subresource("/dm/user.0123456789abcdef", ""), ORIGIN, BUILD)).toEqual({ kind: "network" });
  });

  it("never answers for another origin, a non-GET, or an unparseable URL", () => {
    expect(routeRequest({ ...navigation("/channels"), url: "http://evil.example/channels" }, ORIGIN, BUILD)).toEqual({ kind: "network" });
    expect(routeRequest({ ...subresource("/assets/index-abc123.js"), method: "POST" }, ORIGIN, BUILD)).toEqual({ kind: "network" });
    expect(routeRequest({ ...navigation("/"), url: "not a url" }, ORIGIN, BUILD)).toEqual({ kind: "network" });
  });
});

describe("precachePaths", () => {
  it("lists the shell first, then every build file", () => {
    expect(precachePaths(BUILD)).toEqual(["/", "/assets/index-abc123.js", "/assets/index-abc123.css", "/manifest.webmanifest", "/loam.svg"]);
  });
});

describe("cache names", () => {
  it("are per build, and an activating worker drops every other cache", () => {
    const current = cacheNameFor("0123abcd4567");
    expect(current).toBe("loam-shell-0123abcd4567");
    expect(cacheNameFor("ffff")).not.toBe(current);
    expect(staleCacheNames(["loam-poc-v2", current, cacheNameFor("ffff")], current)).toEqual(["loam-poc-v2", "loam-shell-ffff"]);
  });
});
