import { useMemo, useState } from "preact/hooks";

import { t } from "../i18n";
import { safeQrSvg } from "../lib/qr";

/**
 * "Link another node" affordance for the admin sync panel: shows this node's own address (its join
 * URL, which is also its sync address) as a QR plus a copy button, so a second host can be paired by
 * scanning or pasting it into their own peer list. The reciprocal of `AddSyncPeerControl` — this
 * hands *out* the address; that takes one *in*.
 */
export function NodeLinkControl({ joinUrl }: { joinUrl?: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // Intentionally plain joinUrl, no `#k=` transport-key fragment (docs/08): this QR addresses a sync
  // peer, not a person joining, and the fragment is meaningless (and potentially confusing) there.
  const qrSvg = useMemo(() => safeQrSvg(joinUrl, "#16271f"), [joinUrl]);

  if (!joinUrl) {
    return null;
  }

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(joinUrl ?? "");
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard is unavailable on some insecure-context browsers — the URL is on screen to copy
      // manually, so this is a best-effort convenience only.
    }
  }

  return (
    <div className="node-link-control">
      <button
        aria-expanded={open}
        className="new-channel-toggle"
        onClick={() => setOpen((previous) => !previous)}
        type="button"
      >
        {open ? t("nodeLink.hide") : t("nodeLink.show")}
      </button>
      {open ? (
        <div className="invite-panel">
          {/* The QR encodes the URL shown below; hide it from assistive tech so screen readers
              announce the address itself rather than raw SVG. */}
          <div aria-hidden="true" className="invite-qr" dangerouslySetInnerHTML={{ __html: qrSvg }} />
          <p className="invite-url">{joinUrl}</p>
          <p className="form-note">{t("nodeLink.note")}</p>
          <button className="ghost-button" onClick={() => void copy()} type="button">
            {copied ? t("nodeLink.copied") : t("nodeLink.copy")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
