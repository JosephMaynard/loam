import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  THEME_STORAGE_KEY,
  applyThemePreference,
  installTheme,
  parseThemePreference,
  readThemePreference,
  setThemePreference,
} from "./theme";

type Bridge = { postMessage: ReturnType<typeof vi.fn> };

function addThemeMetas(): HTMLMetaElement[] {
  // The same pair index.html ships: one per prefers-color-scheme.
  return [
    ["#f3f0e8", "(prefers-color-scheme: light)"],
    ["#111412", "(prefers-color-scheme: dark)"],
  ].map(([content, media]) => {
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    meta.content = content!;
    meta.media = media!;
    document.head.appendChild(meta);
    return meta;
  });
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((meta) => meta.remove());
});

afterEach(() => {
  delete (window as unknown as { ReactNativeWebView?: Bridge }).ReactNativeWebView;
});

describe("parseThemePreference", () => {
  it("accepts light and dark, and treats anything else as system", () => {
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("dark")).toBe("dark");
    for (const value of [null, undefined, "", "system", "blue", 1]) {
      expect(parseThemePreference(value)).toBe("system");
    }
  });
});

describe("readThemePreference / setThemePreference", () => {
  it("round-trips through localStorage, and system removes the key", () => {
    expect(readThemePreference()).toBe("system");
    setThemePreference("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(readThemePreference()).toBe("dark");
    setThemePreference("system");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("falls back to system when storage throws", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readThemePreference()).toBe("system");
    spy.mockRestore();
  });
});

describe("applyThemePreference", () => {
  it("pins and releases data-theme on <html>", () => {
    applyThemePreference("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    applyThemePreference("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    applyThemePreference("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("points both theme-color metas at a pinned palette, and back at their own for system", () => {
    const [light, dark] = addThemeMetas();
    applyThemePreference("dark");
    expect([light!.content, dark!.content]).toEqual(["#111412", "#111412"]);
    applyThemePreference("light");
    expect([light!.content, dark!.content]).toEqual(["#f3f0e8", "#f3f0e8"]);
    applyThemePreference("system");
    expect([light!.content, dark!.content]).toEqual(["#f3f0e8", "#111412"]);
  });

  it("tells the Android host, when there is one", () => {
    const bridge: Bridge = { postMessage: vi.fn() };
    (window as unknown as { ReactNativeWebView?: Bridge }).ReactNativeWebView = bridge;
    applyThemePreference("light");
    expect(bridge.postMessage).toHaveBeenCalledWith(JSON.stringify({ type: "loam-theme", theme: "light" }));
  });
});

describe("installTheme", () => {
  it("applies the saved preference, and follows a change made in another tab", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    const stop = installTheme();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    localStorage.setItem(THEME_STORAGE_KEY, "light");
    window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    stop();
    localStorage.removeItem(THEME_STORAGE_KEY);
    window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});
