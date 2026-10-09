/**
 * A node-link QR opened in a browser. "Link another LOAM node" (the host phone's share screen, the web
 * admin's sync panel, the terminal UI) shows the join URL plus `&l=<code>` (server `sync-links.ts`): it
 * is meant for another node's setup screen, which presents the code sealed to the key it just scanned.
 * A person who scans it with a phone camera lands here instead. The code is of no use to a browser, so
 * it is stripped from the address bar like an invite code, before the transport reads the fragment: the
 * `#k=` key must still pin the join (the key pattern accepts nothing after the key, so left in place the
 * `&l=` lost the key, and a `required` node then asked for a scan that had just happened). Whether one
 * was there is remembered, so the app can say what the code was for; the code itself is not kept.
 */
import { splitFragmentParam } from "./invite";

/** The server's `LINK_CODE_PATTERN`: 12 random bytes, base64url. */
const LINK_CODE_PATTERN = /^[A-Za-z0-9_-]{16}$/;

let startupLinkCodePresent = false;

/** Split `l=<code>` out of a fragment, keeping its other parameters in order. Pure. */
export function splitLinkCodeFragment(hash: string): { hash: string; code?: string } {
  const { hash: rest, value } = splitFragmentParam(hash, "l", LINK_CODE_PATTERN);
  return { hash: rest, code: value };
}

/**
 * Take a link code out of the current URL, if there is one, and remember that it was there. Call once at
 * start-up, before the transport reads the fragment.
 */
export function captureLinkCodeFragment(): void {
  const { hash } = splitLinkCodeFragment(window.location.hash);
  startupLinkCodePresent = hash !== window.location.hash;
  if (!startupLinkCodePresent) {
    return;
  }
  const url = new URL(window.location.href);
  url.hash = hash;
  window.history.replaceState(window.history.state, "", url.toString());
}

/**
 * Whether this page load began with a node-link code in its fragment: the person opened a "link another
 * node" QR in a browser, not a join QR. The key it carried still pinned the join, so they are connected
 * as a member; the app can tell them the code was for another node's setup screen.
 */
export function linkCodePresentAtStartup(): boolean {
  return startupLinkCodePresent;
}
