import { useMemo, useRef, useState } from "preact/hooks";

import { t } from "../i18n";
import { copyText } from "../lib/clipboard";
import { safeQrSvg } from "../lib/qr";
import { Dialog } from "./Dialog";
import { IconCopy, IconWifi } from "./icons";

/** The subset of the native host bridge this component talks to. Mirrors the `window.ReactNativeWebView`
 * shape used by the `loam-wipe` bridge message in `app.tsx` — it only ever exists inside LOAM's own
 * Android WebView (`apps/app`), never in a plain browser. */
type ReactNativeBridge = { postMessage: (message: string) => void };

/** The native bridge object, if this page is running inside LOAM's Android host WebView. */
function reactNativeBridge(): ReactNativeBridge | undefined {
  return (window as unknown as { ReactNativeWebView?: ReactNativeBridge }).ReactNativeWebView;
}

/**
 * Sidebar invite affordance for greeters/admins: a row that opens a `Dialog` (a sheet on phones) with the
 * node's join URL as a QR (for someone already on the LAN) plus the URL text. Gated by the caller on
 * `canGreet`.
 *
 * Inside the native Android host (`apps/app`), the WebView bridges a `loam-open-share` message that
 * opens the host's own share overlay carrying the Wi-Fi hotspot QR — credentials the WebView itself
 * can never read. That button only renders when the bridge is present; a plain browser has no way to
 * produce Wi-Fi credentials, so it just shows the join QR.
 *
 * @param qrUrl - The URL to encode in the QR, if it should differ from the displayed `joinUrl` — e.g.
 *   the caller's `joinQrUrl(joinUrl, transportPublicKey)` (docs/08), which appends a `#k=` fragment so
 *   the QR carries the host's transport public key out-of-band while the displayed text stays plain.
 *   Defaults to `joinUrl` when omitted.
 * @param qrSuppressed - Withhold the QR and explain why: the node's advertised key contradicts the key
 *   this client joined with, so any key the QR could carry is suspect.
 */
export function InviteControl({
  joinUrl,
  qrSuppressed = false,
  qrUrl,
}: {
  joinUrl?: string;
  qrSuppressed?: boolean;
  qrUrl?: string;
}) {
  const [open, setOpen] = useState(false);
  // The row that opened the dialog: Dialog returns focus here on close (Safari never focuses a clicked button).
  const triggerRef = useRef<HTMLButtonElement>(null);
  const qrSvg = useMemo(
    () => (qrSuppressed ? "" : safeQrSvg(qrUrl ?? joinUrl, "#16271f")),
    [joinUrl, qrSuppressed, qrUrl],
  );
  const hasNativeBridge = typeof window !== "undefined" && !!reactNativeBridge();
  const [copied, setCopied] = useState(false);

  async function copyLink(): Promise<void> {
    if (qrSuppressed) {
      return;
    }
    if (await copyText(qrUrl ?? joinUrl ?? "")) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }
  }

  if (!joinUrl) {
    return null;
  }

  /**
   * Ask the native Android host to open its share overlay by posting a `loam-open-share` message over the
   * WebView bridge. The host (`apps/app`, `index.tsx`'s WebView-message handler) opens its own share
   * overlay — which carries the Wi-Fi hotspot QR the WebView itself can't render, since those credentials
   * are native-only. A no-op outside the native host (`reactNativeBridge()` is `undefined` in a browser).
   */
  function openHostShare(): void {
    reactNativeBridge()?.postMessage(JSON.stringify({ type: "loam-open-share" }));
  }

  return (
    <div className="invite-control">
      <button className="nav-link invite-trigger" onClick={() => setOpen(true)} ref={triggerRef} type="button">
        <span className="nav-glyph">
          <IconWifi size={18} />
        </span>
        <span className="nav-label">{t("invite.title")}</span>
      </button>
      {open ? (
        // Dialog owns focus: it moves into the panel on open and back to the trigger on close.
        <Dialog
          backdropClassName="invite-modal-backdrop"
          className="invite-modal"
          closeLabel={t("invite.close")}
          onClose={() => setOpen(false)}
          returnFocusTo={triggerRef}
          title={t("invite.title")}
        >
          {/* The QR is a visual shortcut for the URL below it; hide it from assistive tech so screen
              readers announce the actual join URL rather than raw SVG. */}
          {qrSuppressed ? (
            <p className="form-error" role="alert">
              {t("invite.qrKeyMismatch")}
            </p>
          ) : (
            <div aria-hidden="true" className="invite-modal-qr" dangerouslySetInnerHTML={{ __html: qrSvg }} />
          )}
          <p className="invite-modal-howto">{t("invite.howTo")}</p>
          <p className="invite-modal-url">{joinUrl}</p>
          {/* The link the QR carries (with this device's verified node key when it has one), so a pasted
              link keeps the same protection as a scan. Withheld with the QR when the node's key doesn't
              match the one this device verified: copying would hand out the same suspect invite. */}
          {qrSuppressed ? null : (
            <button className="btn btn-secondary btn-block" onClick={() => void copyLink()} type="button">
              <IconCopy />
              {copied ? t("invite.copied") : t("invite.copyLink")}
            </button>
          )}
          {hasNativeBridge ? (
            <div className="invite-modal-wifi">
              <button className="btn btn-primary btn-block" onClick={openHostShare} type="button">
                <IconWifi />
                {t("invite.wifiButton")}
              </button>
              <p>{t("invite.wifiHint")}</p>
            </div>
          ) : null}
        </Dialog>
      ) : null}
    </div>
  );
}
