import { useMemo, useState } from "preact/hooks";

import { t } from "../i18n";
import { safeQrSvg } from "../lib/qr";

/**
 * Sidebar invite affordance for greeters/admins: a collapsible panel rendering the node's join URL as
 * a QR (for someone already on the LAN) plus the URL text. WiFi credentials are native-only, so this
 * only surfaces the URL. Gated by the caller on `canGreet`.
 *
 * @param qrUrl - The URL to encode in the QR, if it should differ from the displayed `joinUrl` — e.g.
 *   the caller's `joinQrUrl(joinUrl, transportPublicKey)` (docs/08), which appends a `#k=` fragment so
 *   the QR carries the host's transport public key out-of-band while the displayed text stays plain.
 *   Defaults to `joinUrl` when omitted.
 */
export function InviteControl({ joinUrl, qrUrl }: { joinUrl?: string; qrUrl?: string }) {
  const [open, setOpen] = useState(false);
  const qrSvg = useMemo(() => safeQrSvg(qrUrl ?? joinUrl, "#16271f"), [joinUrl, qrUrl]);

  if (!joinUrl) {
    return null;
  }

  return (
    <div className="invite-control">
      <button
        aria-expanded={open}
        className="new-channel-toggle"
        onClick={() => setOpen((previous) => !previous)}
        type="button"
      >
        {open ? t("invite.hide") : t("invite.show")}
      </button>
      {open ? (
        <div className="invite-panel">
          {/* The QR is a visual shortcut for the URL below it; hide it from assistive tech so screen
              readers announce the actual join URL rather than raw SVG. */}
          <div aria-hidden="true" className="invite-qr" dangerouslySetInnerHTML={{ __html: qrSvg }} />
          <p className="invite-url">{joinUrl}</p>
        </div>
      ) : null}
    </div>
  );
}
