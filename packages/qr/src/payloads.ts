function escapeWifiValue(value: string): string {
  return value.replace(/([\\;,:"])/g, "\\$1");
}

function normalizeBase(base: string): URL {
  return new URL(base.endsWith("/") ? base : `${base}/`);
}

export function wifiPayload(
  ssid: string,
  password: string,
  auth: "WPA" | "WEP" | "nopass" = "WPA",
): string {
  return `WIFI:T:${auth};S:${escapeWifiValue(ssid)};P:${escapeWifiValue(password)};;`;
}

export function userLink(base: string, userId: string): string {
  return new URL(`/user/${encodeURIComponent(userId)}`, normalizeBase(base)).toString();
}

export function channelLink(base: string, channelId: string): string {
  return new URL(`/channel/${encodeURIComponent(channelId)}`, normalizeBase(base)).toString();
}
