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

export type LinkCodes = {
  /** A new code, and the last moment it can be used. */
  mint(): { code: string; expiresAt: number };
  /** Use a code up: true once for a live code, false for anything else (constant time per candidate). */
  consume(code: string): boolean;
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
  let codes: { code: Buffer; expiresAt: number }[] = [];

  function prune(): void {
    codes = codes.filter((entry) => entry.expiresAt > now());
  }

  return {
    mint() {
      prune();
      const code = randomBytes(LINK_CODE_BYTES);
      const expiresAt = now() + LINK_CODE_TTL_MS;
      codes.push({ code, expiresAt });
      while (codes.length > MAX_LINK_CODES) {
        codes.shift();
      }
      return { code: code.toString("base64url"), expiresAt };
    },
    consume(code) {
      prune();
      if (!LINK_CODE_PATTERN.test(code)) {
        return false;
      }
      const presented = Buffer.from(code, "base64url");
      if (presented.length !== LINK_CODE_BYTES) {
        return false;
      }
      // Compare against every live code (so timing doesn't say which matched), then use up the match.
      let match = -1;
      codes.forEach((entry, index) => {
        if (timingSafeEqual(presented, entry.code) && match === -1) {
          match = index;
        }
      });
      if (match === -1) {
        return false;
      }
      codes.splice(match, 1);
      return true;
    },
    clear() {
      codes = [];
    },
  };
}
