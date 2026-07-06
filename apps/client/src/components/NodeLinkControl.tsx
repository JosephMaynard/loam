import { useMemo, useState } from "preact/hooks";

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
        {open ? "× Hide link" : "⧉ Link another node"}
      </button>
      {open ? (
        <div className="invite-panel">
          {/* The QR encodes the URL shown below; hide it from assistive tech so screen readers
              announce the address itself rather than raw SVG. */}
          <div aria-hidden="true" className="invite-qr" dangerouslySetInnerHTML={{ __html: qrSvg }} />
          <p className="invite-url">{joinUrl}</p>
          <p className="form-note">
            On the other node&rsquo;s admin screen, enable sync and add this address as a peer (scan
            the code or paste the URL).
          </p>
          <button className="ghost-button" onClick={() => void copy()} type="button">
            {copied ? "Copied" : "Copy address"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
