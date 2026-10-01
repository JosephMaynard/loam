// Linking another node (docs/11 "Linking nodes"). An admin of this node chooses to show a "Link a node"
// code: the join URL plus `#k=<transport key>&l=<link code>`. The new node scans it and presents the code
// in a sealed `POST /api/sync/link` (sealed to the key it just scanned, so nobody on the network can read
// or alter it). A valid code links both ways at once: this node adds the new one as a sync peer with its
// key pinned and switches sync on, and answers with its name and its mesh token (if it has one), so the new
// node can pull too. No request queue, nothing to judge from a self-chosen name: showing the code is the
// approval, and the ordinary join QR (on a poster, in a photo) can never link a node.
//
// Codes are random, single-use, short-lived and held in memory only; a restart or the kill switch forgets
// them. The new node's address is the one its request came from (the tunnel forwards the real caller's
// address), plus the port it reports, so it never has to guess which interface the other side can reach.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

/** How long a shown code stays usable. */
export const LINK_CODE_TTL_MS = 10 * 60_000;
/** Codes outstanding at once; minting past this retires the oldest. */
export const MAX_LINK_CODES = 4;
/** 12 random bytes, base64url: 96 bits for a single-use, rate-limited, 10-minute code, short enough to keep
 *  the link URL inside the QR encoder's size limit. */
const LINK_CODE_BYTES = 12;
export const LINK_CODE_PATTERN = /^[A-Za-z0-9_-]{16}$/;

/**
 * What a presented code is: "fresh" (live and unused), "repeat" (already used by this same node, whose
 * answer was lost on the way back: answer it again), or "invalid" (unknown, expired, malformed, or used by
 * a different node).
 */
export type LinkCodeState = "fresh" | "repeat" | "invalid";

export type LinkCodes = {
  /** A new code, and the last moment it can be used. */
  mint(): { code: string; expiresAt: number };
  /** Look a code up for the node identified by `binding` (its URL and key), in constant time per entry. */
  check(code: string, binding: string): LinkCodeState;
  /** Spend a fresh code on `binding`, once the link it made is saved. Until it expires, the same node may
   *  repeat the request (a lost answer) and anyone else is refused. */
  spend(code: string, binding: string): void;
  clear(): void;
};

/** `http://<address>:<port>` for a linking node's request address, or undefined for loopback / unspecified. */
export function peerUrlFor(address: string, port: number): string | undefined {
  const plain = address.startsWith("::ffff:") && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
  const family = isIP(plain);
  if (!family || plain === "0.0.0.0" || plain === "::" || plain.startsWith("127.") || plain === "::1") {
    return undefined;
  }
  return `http://${family === 6 ? `[${plain}]` : plain}:${port}`;
}

export function createLinkCodes(now: () => number = Date.now): LinkCodes {
  let codes: { code: Buffer; expiresAt: number; usedBy?: string }[] = [];

  function prune(): void {
    codes = codes.filter((entry) => entry.expiresAt > now());
  }

  /** The live entry matching `code`, comparing against every entry so timing doesn't say which matched. */
  function find(code: string): (typeof codes)[number] | undefined {
    prune();
    if (!LINK_CODE_PATTERN.test(code)) {
      return undefined;
    }
    const presented = Buffer.from(code, "base64url");
    if (presented.length !== LINK_CODE_BYTES) {
      return undefined;
    }
    let match: (typeof codes)[number] | undefined;
    for (const entry of codes) {
      if (timingSafeEqual(presented, entry.code) && !match) {
        match = entry;
      }
    }
    return match;
  }

  return {
    mint() {
      prune();
      const code = randomBytes(LINK_CODE_BYTES);
      const expiresAt = now() + LINK_CODE_TTL_MS;
      codes.push({ code, expiresAt });
      // Retire the oldest unused codes past the cap; spent ones are kept only to answer a repeat.
      while (codes.filter((entry) => !entry.usedBy).length > MAX_LINK_CODES) {
        codes.splice(codes.findIndex((entry) => !entry.usedBy), 1);
      }
      return { code: code.toString("base64url"), expiresAt };
    },
    check(code, binding) {
      const entry = find(code);
      if (!entry) {
        return "invalid";
      }
      if (!entry.usedBy) {
        return "fresh";
      }
      return entry.usedBy === binding ? "repeat" : "invalid";
    },
    spend(code, binding) {
      const entry = find(code);
      if (entry && !entry.usedBy) {
        entry.usedBy = binding;
      }
    },
    clear() {
      codes = [];
    },
  };
}
