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
 * A non-2xx reply from a LOAM endpoint. `message` is the localized, human-readable text (as before);
 * `status` and the server's stable error `code` (when it sent one) let callers branch on WHAT failed
 * without string-matching that text — which is localized and server-supplied, so it can never be relied
 * on (pre-release review 2026-09-25: a `message.endsWith("404")` check never matched).
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, payload: unknown, fallback: string) {
    super(errorText(payload, fallback));
    this.name = "ApiError";
    this.status = status;
    const code = payload && typeof payload === "object" ? (payload as { code?: unknown }).code : undefined;
    if (typeof code === "string") {
      this.code = code;
    }
  }
}

/** Build the `ApiError` for a failed response, reading its JSON error body if it has one. */
async function apiErrorFrom(response: Response): Promise<ApiError> {
  const payload: unknown = await response.json().catch(() => undefined);
  return new ApiError(response.status, payload, t("common.requestFailed", { status: response.status }));
}

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
      throw await apiErrorFrom(response);
    }

    return response.json() as Promise<T>;
  } finally {
    window.clearTimeout(timeout);
  }
}

/**
 * Permanently delete a channel (`DELETE /api/channels/:id`). Resolves on success; throws a
 * localized error otherwise. Distinct from archiving — delete is gone-for-good (server cascades
 * messages/attachments and tombstones the ids).
 */
export async function deleteChannelRequest(channelId: string): Promise<void> {
  await requestJson("DELETE", `/api/channels/${encodeURIComponent(channelId)}`);
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
      throw new ApiError(response.status, payload, t("common.requestFailed", { status: response.status }));
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

/**
 * POST/PUT/PATCH/DELETE a JSON endpoint through the transport wrapper and return the parsed body (unvalidated
 * — the caller narrows). Throws a localized error on a non-2xx. For endpoints whose response shape the
 * caller doesn't need to schema-validate (reports, moderation actions, resolves).
 */
export async function requestJson<T>(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await encryptedFetch(method, path, body, { signal: controller.signal });
    const payload: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      throw new ApiError(response.status, payload, t("common.requestFailed", { status: response.status }));
    }

    return payload as T;
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
