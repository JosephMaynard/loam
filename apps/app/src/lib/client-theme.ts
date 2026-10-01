/**
 * The web client's colour theme (Settings → Appearance: System / Light / Dark) mirrored onto the native
 * host, so the top bar and status bar match what the WebView shows. The client posts
 * `{"type":"loam-theme","theme":"system"|"light"|"dark"}` on load and whenever the choice changes;
 * `Appearance.setColorScheme` then drives `useColorScheme` (and so `useTheme`) app-wide. The activity
 * declares `uiMode` in its configChanges, so switching doesn't restart it (or the WebView).
 */

/** The value `Appearance.setColorScheme` takes: `unspecified` hands control back to the device. */
export type NativeColorScheme = 'light' | 'dark' | 'unspecified';

/**
 * The native scheme for a posted message, or undefined when the message isn't a well-formed
 * `loam-theme` (anything else is left for the other handlers).
 */
export function colorSchemeForClientMessage(message: unknown): NativeColorScheme | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  const { type, theme } = message as { type?: unknown; theme?: unknown };
  if (type !== 'loam-theme') {
    return undefined;
  }
  if (theme === 'light' || theme === 'dark') {
    return theme;
  }
  return theme === 'system' ? 'unspecified' : undefined;
}
