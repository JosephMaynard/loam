/**
 * The Android host app's per-boot token (`hostDevice` admin bootstrap), handed to the client running in the
 * host's own WebView in the URL fragment (`#k=<key>&h=<token>`). The host app used to inject it as a script,
 * but Android doesn't reliably run injected scripts before the first page load, so the host could end up
 * an ordinary (or, on an approval-only network, queued) member of its own network. A fragment is never sent
 * to the server and only this WebView ever loads it. Taken out of the address before the transport reads
 * `#k=`, and kept in `window.__loamHostDeviceToken`, where the boot pass claims admin with it.
 */
import { splitFragmentParam } from "./invite";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

declare global {
  interface Window {
    __loamHostDeviceToken?: string;
  }
}

/** Take the host token out of the current URL, if there is one. Call once at start-up. */
export function captureHostToken(): void {
  const { hash, value } = splitFragmentParam(window.location.hash, "h", TOKEN_PATTERN);
  if (hash === window.location.hash) {
    return;
  }
  const url = new URL(window.location.href);
  url.hash = hash;
  window.history.replaceState(window.history.state, "", url.toString());
  if (value) {
    window.__loamHostDeviceToken = value;
    // Only the host's own WebView carries a token, and its `#k=` is the launcher's own key for this node:
    // trust it as the launcher key (`__loamHostTransportKey`), which a new key every boot (ephemeral
    // storage) needs in order not to look like a changed key.
    const key = splitFragmentParam(hash, "k", /^[A-Za-z0-9_-]{1,128}$/).value;
    if (key) {
      (window as { __loamHostTransportKey?: string }).__loamHostTransportKey = key;
    }
  }
}
