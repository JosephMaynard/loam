import { useMemo, useState } from "preact/hooks";

import { safeQrSvg } from "../lib/qr";

/**
 * Sidebar invite affordance for greeters/admins: a collapsible panel rendering the node's join URL as
 * a QR (for someone already on the LAN) plus the URL text. WiFi credentials are native-only, so this
 * only surfaces the URL. Gated by the caller on `canGreet`.
 */
export function InviteControl({ joinUrl }: { joinUrl?: string }) {
  const [open, setOpen] = useState(false);
  const qrSvg = useMemo(() => safeQrSvg(joinUrl, "#16271f"), [joinUrl]);

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
        {open ? "× Hide invite" : "⧉ Invite someone"}
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
