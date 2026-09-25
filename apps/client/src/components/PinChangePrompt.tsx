import { useLayoutEffect, useRef } from "preact/hooks";

import { t } from "../i18n";

export interface PinChangePromptProps {
  /** Emoji fingerprint of the key this browser already trusts for the node. */
  current: string;
  /** Emoji fingerprint of the key the `#k=` link carried. */
  next: string;
  onAccept: () => void;
  onReject: () => void;
}

/**
 * Asks the user before trusting a join link whose `#k=` key differs from the one this browser already
 * pinned for the node (pre-release review 2026-09-25). Legitimate after an Emergency Reset rotated the
 * node's key and the user rescanned the new QR in person; otherwise it is someone else's link (a message,
 * a poster swap) and must not silently replace the pin. Shows both fingerprints so the user can compare
 * with the one on the host's screen. Rendered as a modal over the app, or inline on the rescan gate.
 */
export function PinChangePrompt({ current, next, onAccept, onReject }: PinChangePromptProps) {
  const keepRef = useRef<HTMLButtonElement>(null);

  // Land on the SAFE choice: an accidental Enter must keep the current key.
  useLayoutEffect(() => {
    keepRef.current?.focus();
  }, []);

  return (
    <div
      aria-describedby="pin-change-body"
      aria-labelledby="pin-change-title"
      aria-modal="true"
      className="invite-modal pin-change"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          onReject();
        }
      }}
      role="alertdialog"
    >
      <h2 id="pin-change-title">{t("transport.pinChangeTitle")}</h2>
      <p id="pin-change-body">{t("transport.pinChangeBody")}</p>
      <p className="transport-fingerprint">{t("transport.pinChangeCurrent", { fingerprint: current })}</p>
      <p className="transport-fingerprint">{t("transport.pinChangeNew", { fingerprint: next })}</p>
      <div className="report-dialog-actions">
        <button onClick={onReject} ref={keepRef} type="button">
          {t("transport.pinChangeReject")}
        </button>
        <button className="danger-button" onClick={onAccept} type="button">
          {t("transport.pinChangeAccept")}
        </button>
      </div>
    </div>
  );
}
