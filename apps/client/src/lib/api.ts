/**
 * Small shared HTTP helpers for the client's REST calls: a JSON GET, a channel POST/PATCH that
 * validates the response, and a defensive user-list parser. Extracted from `app.tsx` so components
 * that do their own fetching can reuse them without reaching back into the app module.
 */
import { ChannelSchema, UserSchema, type Channel, type User } from "@loam/schema";

import { errorText, t } from "../i18n";
import { encryptedFetch } from "./transport";

/** Abort a request if the server hasn't answered within this many milliseconds. */
export const REQUEST_TIMEOUT_MS = 10_000;

/**
 * GET a JSON endpoint through the transport-encryption wrapper (a byte-for-byte passthrough when no
 * session is active — see `encryptedFetch`). Used for every content endpoint; `/api/config` is
 * deliberately NOT routed through this (see `fetchConfigJson`) — it must stay readable before any
 * transport session exists and must never be re-encrypted on a later refetch.
 */
export async function fetchJson<T>(path: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await encryptedFetch("GET", path, undefined, { signal: controller.signal });

    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => undefined);
      throw new Error(errorText(payload, t("common.requestFailed", { status: response.status })));
    }

    return response.json() as Promise<T>;
  } finally {
    window.clearTimeout(timeout);
  }
}

/**
 * POST/PATCH a channel endpoint and return the validated `Channel` from the response. Throws a
 * localized error when the request fails or the payload isn't a recognisable channel.
 */
export async function requestChannel(method: "POST" | "PATCH", path: string, body: unknown): Promise<Channel> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await encryptedFetch(method, path, body, { signal: controller.signal });
    const payload: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      const message = errorText(payload, t("common.requestFailed", { status: response.status }));
      throw new Error(message);
    }

    const parsed = ChannelSchema.safeParse(payload);

    if (!parsed.success) {
      throw new Error(t("admin.channelUnrecognised"));
    }

    return parsed.data;
  } finally {
    window.clearTimeout(timeout);
  }
}

/** Parse an unknown payload into a list of valid `User`s, dropping anything that doesn't validate. */
export function parseUserList(payload: unknown): User[] {
  return Array.isArray(payload)
    ? payload.flatMap((item) => {
        const parsed = UserSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
}
