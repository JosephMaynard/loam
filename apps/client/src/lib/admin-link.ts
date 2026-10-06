/**
 * The host's "open as admin" link. The `loamnet` terminal UI opens the browser on its own machine at
 * `http://localhost:<port>/#k=<key>&a=<code>`, where the code is single-use and lasts 10 minutes (server
 * `admin-links.ts`). It is read and stripped from the address bar at start-up, like an invite code, so it
 * never lingers in history, and kept in memory only: a reload before boot finishes just means opening the
 * link again from the terminal.
 */
import { splitFragmentParam } from "./invite";

const ADMIN_CODE_PATTERN = /^[A-Za-z0-9_-]{22}$/;

let memoryCode: string | undefined;

/** Split `a=<code>` out of a fragment, keeping its other parameters in order. Pure. */
export function splitAdminFragment(hash: string): { hash: string; code?: string } {
  const { hash: rest, value } = splitFragmentParam(hash, "a", ADMIN_CODE_PATTERN);
  return { hash: rest, code: value };
}

/** Take an admin code out of the current URL, if there is one. Call once at start-up. */
export function captureAdminClaimCode(): void {
  const { hash, code } = splitAdminFragment(window.location.hash);
  if (hash === window.location.hash) {
    return;
  }
  const url = new URL(window.location.href);
  url.hash = hash;
  window.history.replaceState(window.history.state, "", url.toString());
  memoryCode = code;
}

/** The captured code, removed so it's presented at most once. */
export function takeAdminClaimCode(): string | undefined {
  const code = memoryCode;
  memoryCode = undefined;
  return code;
}
