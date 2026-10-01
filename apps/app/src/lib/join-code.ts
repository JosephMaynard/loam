/**
 * Reading a code scanned in setup when this phone joins another LOAM network as a node: the other node's
 * join QR (`http://<address>:<port>/#k=<key>[&i=<invite>]`) gives its sync address and the transport key to
 * pin, the same key its joiners pin. Its hotspot's Wi-Fi code (`WIFI:S:…`) is recognised too, so setup can
 * say "join that Wi-Fi first" instead of "not a LOAM code". Pure, no React Native.
 */

export type ScannedCode =
  | { kind: 'loam'; url: string; transportKey?: string }
  | { kind: 'wifi'; ssid: string }
  | { kind: 'other' };

const KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** The parts of a WIFI: payload's `S:` field (escaped `\;` `\,` `\:` `\\` `\"` per the de facto format). */
function wifiSsid(data: string): string | undefined {
  const match = /(?:^WIFI:|;)S:((?:\\.|[^;])*)/.exec(data);
  return match ? match[1]!.replace(/\\(.)/g, '$1') : undefined;
}

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
  const key = url.hash
    .replace(/^#/, '')
    .split('&')
    .find((part) => part.startsWith('k='))
    ?.slice(2);
  return {
    kind: 'loam',
    // Only the node's origin is its sync address; a path or query from the QR means nothing to sync.
    url: `${url.protocol}//${url.host}`,
    ...(key && KEY_PATTERN.test(key) ? { transportKey: key } : {}),
  };
}

/**
 * A typed address, for when the camera isn't available: `192.168.4.1:3000` or a full URL. No key can be
 * typed, so the peer is unpinned (the sync falls back to the key it advertises, docs/11).
 */
export function parseTypedAddress(text: string): { url: string } | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  const withScheme = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const parsed = parseScannedCode(withScheme);
  if (parsed.kind !== 'loam') {
    return undefined;
  }
  // A bare address means the default LOAM port.
  const url = new URL(parsed.url);
  return { url: url.port ? parsed.url : `${url.protocol}//${url.hostname.includes(':') ? `[${url.hostname}]` : url.hostname}:3000` };
}
