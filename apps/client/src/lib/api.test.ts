import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, fetchJson, requestJson } from "./api";
import { resetTransportStateForTests } from "./transport";

beforeEach(() => {
  resetTransportStateForTests(); // no session → encryptedFetch is a plain passthrough
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ApiError carries the status and server code (review 2026-09-25)", () => {
  it("fetchJson throws an ApiError with status 404 and the server's code, not just localized text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "Channel does not exist", code: "channel_not_found" }), { status: 404 })),
    );

    const failure = await fetchJson("/api/messages/ghost").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(404);
    expect((failure as ApiError).code).toBe("channel_not_found");
    // The message is the (localized) server text — which is exactly why callers must not string-match it.
    expect((failure as ApiError).message).not.toMatch(/404$/);
  });

  it("falls back to a status message when the body isn't JSON, and requestJson throws the same type", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));

    const failure = await requestJson("POST", "/api/reports", {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(500);
    expect((failure as ApiError).code).toBeUndefined();
    expect((failure as ApiError).message).toBe("Request failed: 500");
  });
});
