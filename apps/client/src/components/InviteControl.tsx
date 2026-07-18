import { useLayoutEffect, useMemo, useState } from "preact/hooks";

import { t } from "../i18n";
import { safeQrSvg } from "../lib/qr";

/** The subset of the native host bridge this component talks to. Mirrors the `window.ReactNativeWebView`
 * shape used by the `loam-wipe` bridge message in `app.tsx` — it only ever exists inside LOAM's own
 * Android WebView (`apps/app`), never in a plain browser. */
type ReactNativeBridge = { postMessage: (message: string) => void };

/** The native bridge object, if this page is running inside LOAM's Android host WebView. */
function reactNativeBridge(): ReactNativeBridge | undefined {
  return (window as unknown as { ReactNativeWebView?: ReactNativeBridge }).ReactNativeWebView;
}

/**
 * Sidebar invite affordance for greeters/admins: a button that opens a big centered modal with the
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
 */
export function InviteControl({ joinUrl, qrUrl }: { joinUrl?: string; qrUrl?: string }) {
  const [open, setOpen] = useState(false);
  const qrSvg = useMemo(() => safeQrSvg(qrUrl ?? joinUrl, "#16271f"), [joinUrl, qrUrl]);
  const hasNativeBridge = typeof window !== "undefined" && !!reactNativeBridge();

  useLayoutEffect(() => {
    if (!open) {
      return;
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (!joinUrl) {
    return null;
  }

  function openHostShare(): void {
    reactNativeBridge()?.postMessage(JSON.stringify({ type: "loam-open-share" }));
  }

  return (
    <div className="invite-control">
      <button className="new-channel-toggle" onClick={() => setOpen(true)} type="button">
        {t("invite.show")}
      </button>
      {open ? (
        <div
          className="invite-modal-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setOpen(false);
            }
          }}
        >
          <div aria-labelledby="invite-modal-title" aria-modal="true" className="invite-modal" role="dialog">
            <div className="invite-modal-header">
              <h2 id="invite-modal-title">{t("invite.title")}</h2>
              <button
                aria-label={t("invite.close")}
                className="close-button"
                onClick={() => setOpen(false)}
                type="button"
              >
                ×
              </button>
            </div>
            {/* The QR is a visual shortcut for the URL below it; hide it from assistive tech so screen
                readers announce the actual join URL rather than raw SVG. */}
            <div aria-hidden="true" className="invite-modal-qr" dangerouslySetInnerHTML={{ __html: qrSvg }} />
            <p className="invite-modal-url">{joinUrl}</p>
            {hasNativeBridge ? (
              <div className="invite-modal-wifi">
                <button onClick={openHostShare} type="button">
                  {t("invite.wifiButton")}
                </button>
                <p>{t("invite.wifiHint")}</p>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
