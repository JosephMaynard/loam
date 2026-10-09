import { afterEach, describe, expect, it, vi } from "vitest";

import { saveThroughHost, toBase64 } from "./host-files";

afterEach(() => {
  delete (window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView;
  vi.unstubAllGlobals();
});

describe("host file saving", () => {
  it("encodes bytes as base64, including large files", () => {
    expect(toBase64(new TextEncoder().encode("hello"))).toBe("aGVsbG8=");
    const big = new Uint8Array(200_000).fill(65);
    expect(atob(toBase64(big))).toHaveLength(200_000);
  });

  it("posts the file to the host app, and does nothing in a plain browser", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new TextEncoder().encode("hello"))));
    await saveThroughHost("blob:x", "notes.txt", "text/plain");
    expect(fetch).not.toHaveBeenCalled();

    const postMessage = vi.fn();
    (window as unknown as { ReactNativeWebView: unknown }).ReactNativeWebView = { postMessage };
    await saveThroughHost("blob:x", "notes.txt", "text/plain");
    expect(JSON.parse(postMessage.mock.calls[0]![0] as string)).toEqual({
      type: "loam-save-file",
      name: "notes.txt",
      mimeType: "text/plain",
      data: "aGVsbG8=",
    });
  });

  it("never hands the host an error page in place of the file", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Not found", { status: 404 })));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const postMessage = vi.fn();
    (window as unknown as { ReactNativeWebView: unknown }).ReactNativeWebView = { postMessage };
    await saveThroughHost("blob:x", "notes.txt", "text/plain");
    expect(postMessage).not.toHaveBeenCalled();
  });
});
