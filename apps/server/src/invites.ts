// Rotating invite codes (docs/08 "rotating QR", docs/09): a code that lets someone who scanned the host's
// own screen skip the approval queue on a `joinPolicy: "approval"` node. The host app puts it in the join
// URL's fragment (`#k=…&i=<code>`) on its share screen and in display mode; the client redeems it with
// `POST /api/access/redeem`. A code proves the person saw the host's screen recently, nothing more: it is
// multi-use within its lifetime, so a phone left in a window admits everyone walking past.
//
// Codes are an HMAC of the current time window under a secret held only in memory. A new secret is drawn at
// boot and by the kill switch, so a restart or an Emergency Reset retires every code already shown.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** How long each code is current. A code is accepted for its own window and the next one. */
export const INVITE_WINDOW_MS = 10 * 60_000;

/** 16 bytes of HMAC, base64url: the same strength as the other bearer tokens, short enough for a QR. */
const INVITE_CODE_BYTES = 16;
export const INVITE_CODE_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export type InviteIssuer = {
  /** The code to show now, and when the last moment it will still be accepted. */
  current(): { code: string; expiresAt: number };
  /** Whether `code` is this window's or the previous window's code (constant time). */
  verify(code: string): boolean;
  /** Draw a new secret: every code already issued stops working. */
  rotate(): void;
};

export function createInviteIssuer(now: () => number = Date.now): InviteIssuer {
  let secret = randomBytes(32);

  function codeFor(window: number): Buffer {
    return createHmac("sha256", secret).update(`loam.invite.v1:${window}`).digest().subarray(0, INVITE_CODE_BYTES);
  }

  return {
    current() {
      const window = Math.floor(now() / INVITE_WINDOW_MS);
      return { code: codeFor(window).toString("base64url"), expiresAt: (window + 2) * INVITE_WINDOW_MS };
    },
    verify(code) {
      if (!INVITE_CODE_PATTERN.test(code)) {
        return false;
      }
      const presented = Buffer.from(code, "base64url");
      if (presented.length !== INVITE_CODE_BYTES) {
        return false;
      }
      const window = Math.floor(now() / INVITE_WINDOW_MS);
      // Check both windows unconditionally, so the time taken doesn't say which one matched.
      const matchesCurrent = timingSafeEqual(presented, codeFor(window));
      const matchesPrevious = timingSafeEqual(presented, codeFor(window - 1));
      return matchesCurrent || matchesPrevious;
    },
    rotate() {
      secret = randomBytes(32);
    },
  };
}
