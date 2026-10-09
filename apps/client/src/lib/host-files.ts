/**
 * Saving a received file from inside the Android host's own WebView (apps/app `lib/save-file.ts`). There,
 * every attachment arrives through the encrypted tunnel as a `blob:` URL that Android's downloader can't
 * fetch, so instead of a download the page posts the file's bytes to the host app, which opens the share
 * sheet. Browsers on other phones never take this path: they download normally.
 */

type Bridge = { postMessage: (message: string) => void };

/** The native host bridge, present only inside LOAM's Android host WebView. */
export function hostBridge(): Bridge | undefined {
  return (window as unknown as { ReactNativeWebView?: Bridge }).ReactNativeWebView;
}

/** Base64 of the bytes, in chunks so a large file doesn't overflow the argument list. Pure. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/** Read the file at `url` (a `blob:` or same-origin URL) and hand it to the host app's share sheet. */
export async function saveThroughHost(url: string, name: string, mimeType: string): Promise<void> {
  const bridge = hostBridge();
  if (!bridge) {
    return;
  }
  try {
    const response = await fetch(url);
    if (!response.ok) {
      // An error page under the file's name is worse than nothing.
      throw new Error(`HTTP ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    bridge.postMessage(JSON.stringify({ type: "loam-save-file", name, mimeType, data: toBase64(bytes) }));
  } catch (error) {
    console.warn("LOAM: couldn't read the file to save it", error);
  }
}
