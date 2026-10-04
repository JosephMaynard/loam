/**
 * Reading a code scanned in setup when this phone joins another LOAM network as a node. Only a "Link a
 * node" code works: the other network's host or admin shows it on purpose, and it carries that node's
 * sync address, its transport key (pinned, and what the code is sealed to) and a single-use code
 * (`http://<address>:<port>/#k=<key>&l=<code>`, server `sync-links.ts`). The ordinary join code and the
 * hotspot's Wi-Fi code are recognised too, so setup can say what to do instead. Pure, no React Native.
 */

export type ScannedCode =
  /** A "Link a node" code: the node's sync address, its key, and the single-use code. */
  | { kind: 'link'; url: string; transportKey: string; linkCode: string }
  /** An ordinary join code (for people): no link code in it. */
  | { kind: 'join' }
  | { kind: 'wifi'; ssid: string }
  | { kind: 'other' };

const KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const LINK_CODE_PATTERN = /^[A-Za-z0-9_-]{16}$/;

/** The parts of a WIFI: payload's `S:` field (escaped `\;` `\,` `\:` `\\` `\"` per the de facto format). */
function wifiSsid(data: string): string | undefined {
  const match = /(?:^WIFI:|;)S:((?:\\.|[^;])*)/.exec(data);
  return match ? match[1]!.replace(/\\(.)/g, '$1') : undefined;
}

/**
 * Read a scanned code. Only a link code (`#k=<key>&l=<code>`, shown on purpose by the other network's host
 * or admin) can link a node; an ordinary join code is recognised so setup can say where to find the link
 * code, and a link code without a key is refused, since the code must only ever travel sealed to that key.
 */
export function parseScannedCode(data: string): ScannedCode {
  const text = data.trim();
  if (/^WIFI:/i.test(text)) {
    const ssid = wifiSsid(text);
    return ssid ? { kind: 'wifi', ssid } : { kind: 'other' };
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { kind: 'other' };
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password) {
    return { kind: 'other' };
  }
  const params = new Map(
    url.hash
      .replace(/^#/, '')
      .split('&')
      .map((part) => [part.slice(0, part.indexOf('=')), part.slice(part.indexOf('=') + 1)] as const),
  );
  const key = params.get('k');
  const linkCode = params.get('l');
  if (!linkCode) {
    return { kind: 'join' };
  }
  if (!key || !KEY_PATTERN.test(key) || !LINK_CODE_PATTERN.test(linkCode)) {
    return { kind: 'other' };
  }
  // Only the node's origin is its sync address; a path or query in the QR means nothing to sync.
  return { kind: 'link', url: `${url.protocol}//${url.host}`, transportKey: key, linkCode };
}
