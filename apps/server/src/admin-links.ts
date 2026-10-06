// One-time admin claim codes for the host's own screen. The `loamnet` terminal UI (whoever runs the node's
// process owns the node) asks for one and opens the browser on `http://localhost:<port>/#…&a=<code>`; the
// client presents it to `POST /api/admin/claim`. The code rides the URL fragment, which a browser never
// sends, so it reaches no request log. It works once, for 10 minutes, under the `hostDevice` bootstrap that
// a launcher's host token forces, so no other session on the network can become admin first.
//
// Codes are random and held in memory only; a restart or the kill switch forgets them.
import { randomBytes, timingSafeEqual } from "node:crypto";

/** How long a code stays usable. */
export const ADMIN_CLAIM_CODE_TTL_MS = 10 * 60_000;
/** Codes outstanding at once; minting past this retires the oldest. */
export const MAX_ADMIN_CLAIM_CODES = 4;
/** 16 random bytes, base64url: the same strength as the other bearer tokens, short enough for a QR. */
const ADMIN_CLAIM_CODE_BYTES = 16;
export const ADMIN_CLAIM_CODE_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export type AdminClaimCodes = {
  /** A new code, and the last moment it can be used. */
  mint(): { code: string; expiresAt: number };
  /** Spend `code` if it is live and unused (constant time per entry). */
  consume(code: string): boolean;
  clear(): void;
};

export function createAdminClaimCodes(now: () => number = Date.now): AdminClaimCodes {
  let codes: { code: Buffer; expiresAt: number }[] = [];

  function prune(): void {
    codes = codes.filter((entry) => entry.expiresAt > now());
  }

  return {
    mint() {
      prune();
      const code = randomBytes(ADMIN_CLAIM_CODE_BYTES);
      const expiresAt = now() + ADMIN_CLAIM_CODE_TTL_MS;
      codes.push({ code, expiresAt });
      codes = codes.slice(-MAX_ADMIN_CLAIM_CODES);
      return { code: code.toString("base64url"), expiresAt };
    },
    consume(code) {
      prune();
      if (!ADMIN_CLAIM_CODE_PATTERN.test(code)) {
        return false;
      }
      const presented = Buffer.from(code, "base64url");
      if (presented.length !== ADMIN_CLAIM_CODE_BYTES) {
        return false;
      }
      // Compare against every entry, so the time taken doesn't say which one matched.
      let match = -1;
      codes.forEach((entry, index) => {
        if (timingSafeEqual(presented, entry.code) && match < 0) {
          match = index;
        }
      });
      if (match < 0) {
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
