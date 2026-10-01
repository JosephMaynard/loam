/**
 * Invite codes from the host's screen (server `invites.ts`). The host app adds `i=<code>` to the join URL's
 * fragment (`#k=<key>&i=<code>`); on an approval-only node, redeeming it admits this session without
 * waiting in the queue. The code is read and stripped from the address bar before anything else looks at
 * the fragment, so the `#k=` handling in transport.ts sees exactly what it always has, and the code never
 * lingers in history or gets passed on in a shared link.
 */

const INVITE_STORAGE_KEY = "loam.inviteCode";
const CODE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

let memoryCode: string | undefined;

/** Split `i=<code>` out of a fragment, keeping its other parameters in order. Pure. */
export function splitInviteFragment(hash: string): { hash: string; code?: string } {
  if (!hash.startsWith("#") || hash.length < 2) {
    return { hash };
  }
  let code: string | undefined;
  const kept: string[] = [];
  for (const part of hash.slice(1).split("&")) {
    if (part.startsWith("i=")) {
      const value = part.slice(2);
      if (CODE_PATTERN.test(value)) {
        code = value;
      }
      continue;
    }
    if (part) {
      kept.push(part);
    }
  }
  return { hash: kept.length ? `#${kept.join("&")}` : "", code };
}

/**
 * Take an invite code out of the current URL, if there is one, and keep it for this tab until it's used.
 * Call once at start-up, before the transport reads the fragment.
 */
export function captureInviteCode(): void {
  const { hash, code } = splitInviteFragment(window.location.hash);
  if (hash === window.location.hash) {
    return;
  }
  const url = new URL(window.location.href);
  url.hash = hash;
  window.history.replaceState(window.history.state, "", url.toString());
  if (!code) {
    return;
  }
  memoryCode = code;
  try {
    // Survives a reload before boot finishes (it's useless after its 10 to 20 minutes anyway).
    sessionStorage.setItem(INVITE_STORAGE_KEY, code);
  } catch {
    // The in-memory copy still covers this load.
  }
}

/** The captured code, removed so it's redeemed at most once. */
export function takeInviteCode(): string | undefined {
  let code = memoryCode;
  memoryCode = undefined;
  try {
    code ??= sessionStorage.getItem(INVITE_STORAGE_KEY) ?? undefined;
    sessionStorage.removeItem(INVITE_STORAGE_KEY);
  } catch {
    // Nothing stored.
  }
  return code && CODE_PATTERN.test(code) ? code : undefined;
}
