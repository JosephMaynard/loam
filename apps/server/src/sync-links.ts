// Link requests between nodes (docs/11 "Onboarding"). A node that lists a peer asks that peer, once per
// boot, to list it back (`POST /api/sync/link-request`, sealed like any sync request). The peer answers
// "linked" when it already pulls from the asker, otherwise it parks the request for its admins, who accept
// (the asker becomes a sync peer and sync is switched on) or decline it in the admin sync panel. Nothing is
// automatic on the receiving side: any device on the network can ask, so a person decides.
//
// The asker's address is the one its request came from (the tunnel forwards the real caller's address),
// plus the port it reports, so a node never has to work out which of its own interfaces the other side can
// reach. Pending requests live in memory only (capped, expiring), and the kill switch clears them.
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";

import type { SyncLinkRequest, SyncLinkRequestEntry } from "@loam/schema";

/** How many requests wait at once; the oldest is dropped past this. */
export const MAX_LINK_REQUESTS = 8;
/** A request no one answered is forgotten after a day (the asker asks again on its next start). */
export const LINK_REQUEST_TTL_MS = 24 * 60 * 60_000;

export type LinkRequests = {
  /** Record (or refresh) a request from `address`. Returns the entry, or undefined for an unusable address. */
  add(address: string, request: SyncLinkRequest): SyncLinkRequestEntry | undefined;
  list(): SyncLinkRequestEntry[];
  /** Remove and return a request by id. */
  take(id: string): SyncLinkRequestEntry | undefined;
  clear(): void;
};

/** `http://<address>:<port>` for a peer's request address, or undefined for loopback / unspecified. */
export function peerUrlFor(address: string, port: number): string | undefined {
  const plain = address.startsWith("::ffff:") && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
  const family = isIP(plain);
  if (!family || plain === "0.0.0.0" || plain === "::" || plain.startsWith("127.") || plain === "::1") {
    return undefined;
  }
  return `http://${family === 6 ? `[${plain}]` : plain}:${port}`;
}

export function createLinkRequests(now: () => number = Date.now): LinkRequests {
  const entries = new Map<string, SyncLinkRequestEntry>(); // keyed by url

  function prune(): void {
    for (const [url, entry] of entries) {
      if (now() - entry.requestedAt > LINK_REQUEST_TTL_MS) {
        entries.delete(url);
      }
    }
  }

  return {
    add(address, request) {
      const url = peerUrlFor(address, request.port);
      if (!url) {
        return undefined;
      }
      prune();
      const entry: SyncLinkRequestEntry = {
        // A repeat request from the same address keeps its id, so an admin's open panel stays valid.
        id: entries.get(url)?.id ?? randomBytes(8).toString("hex"),
        url,
        ...(request.name ? { name: request.name } : {}),
        ...(request.transportKey ? { transportKey: request.transportKey } : {}),
        requestedAt: now(),
      };
      entries.delete(url);
      entries.set(url, entry);
      while (entries.size > MAX_LINK_REQUESTS) {
        entries.delete(entries.keys().next().value!);
      }
      return entry;
    },
    list() {
      prune();
      return [...entries.values()].reverse();
    },
    take(id) {
      for (const [url, entry] of entries) {
        if (entry.id === id) {
          entries.delete(url);
          return entry;
        }
      }
      return undefined;
    },
    clear() {
      entries.clear();
    },
  };
}
