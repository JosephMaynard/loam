/**
 * The user's colour theme: follow the device (`system`, the default) or pin `light` / `dark`.
 *
 * Both palettes live in `styles/tokens.css`. With no attribute the page follows `prefers-color-scheme`;
 * `data-theme="light"` / `"dark"` on `<html>` pins one. The choice is a per-browser convenience kept in
 * localStorage (synchronous, so it applies before the first render; IndexedDB would flash the wrong
 * palette), and it deliberately survives the identity-change purge and a wipe: it's display
 * preference, not content.
 */

export type ThemePreference = "system" | "light" | "dark";

export const THEME_PREFERENCES: readonly ThemePreference[] = ["system", "light", "dark"];

export const THEME_STORAGE_KEY = "loam.theme";

/** `--bg-app` per palette (tokens.css); the browser chrome colour when a theme is pinned. */
const THEME_CHROME_COLORS = { light: "#f3f0e8", dark: "#111412" } as const;

/** Parse a stored value; anything unknown (or nothing) means "follow the device". */
export function parseThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

/** The saved preference, or `system` when storage is empty, unreadable or blocked. */
export function readThemePreference(): ThemePreference {
  try {
    return parseThemePreference(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

/** Save the preference (`system` removes the key). Best-effort: blocked storage just won't remember it. */
export function storeThemePreference(preference: ThemePreference): void {
  try {
    if (preference === "system") {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      window.localStorage.setItem(THEME_STORAGE_KEY, preference);
    }
  } catch {
    // Private mode / blocked storage: the choice applies for this page only.
  }
}

/** The native Android host's WebView bridge, present only inside `apps/app`. */
function nativeBridge(): { postMessage: (message: string) => void } | undefined {
  return (window as unknown as { ReactNativeWebView?: { postMessage: (message: string) => void } }).ReactNativeWebView;
}

/**
 * Apply a preference to the document: pin or release `data-theme`, point the `theme-color` metas (one per
 * `prefers-color-scheme` in index.html) at the pinned palette or back at their own, and tell the Android
 * host so its native top bar and status bar match (it maps `system` to the device setting).
 */
export function applyThemePreference(preference: ThemePreference, root: Document = document): void {
  const html = root.documentElement;
  if (preference === "system") {
    html.removeAttribute("data-theme");
  } else {
    html.setAttribute("data-theme", preference);
  }

  for (const meta of root.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const own = meta.media.includes("dark") ? THEME_CHROME_COLORS.dark : THEME_CHROME_COLORS.light;
    meta.content = preference === "system" ? own : THEME_CHROME_COLORS[preference];
  }

  nativeBridge()?.postMessage(JSON.stringify({ type: "loam-theme", theme: preference }));
}

/** Save and apply a new preference. */
export function setThemePreference(preference: ThemePreference): void {
  storeThemePreference(preference);
  applyThemePreference(preference);
}

/**
 * Apply the saved preference before the first render, and follow changes made in another tab (a
 * `storage` event on the key). Returns a function that stops listening.
 */
export function installTheme(): () => void {
  applyThemePreference(readThemePreference());
  const onStorage = (event: StorageEvent): void => {
    if (event.key === THEME_STORAGE_KEY || event.key === null) {
      applyThemePreference(readThemePreference());
    }
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
