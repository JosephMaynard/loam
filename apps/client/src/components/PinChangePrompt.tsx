import { useLayoutEffect, useRef } from "preact/hooks";

import { t } from "../i18n";
import { trapFocus } from "../lib/focus-trap";

export interface PinChangePromptProps {
  /** Emoji fingerprint of the key this browser already trusts for the node. */
  current: string;
  /** Emoji fingerprint of the key the `#k=` link carried. */
  next: string;
  /** Whether the link's key is the one the node itself reported. When it isn't, the key can't be accepted. */
  matchesNode: boolean;
  onAccept: () => void;
  onReject: () => void;
}

/**
 * Asks the user before trusting a join link whose `#k=` key differs from the one this browser already
 * pinned for the node (pre-release review 2026-09-25). Shown only once the pinned key has stopped working
 * (the node's handshake reported another key), which is legitimate after an Emergency Reset or a restart
 * rotated the node's key and the user rescanned the new QR in person. Shows both fingerprints so the user can
 * compare with the one on the host's screen. When the link's key isn't even the node's (`matchesNode` false:
 * someone else's link or a QR sticker) there is nothing to accept — it says so and offers only "keep".
 * Rendered inline on the rescan gate.
 */
export function PinChangePrompt({ current, next, matchesNode, onAccept, onReject }: PinChangePromptProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
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
          return;
        }
        trapFocus(dialogRef.current, event);
      }}
      ref={dialogRef}
      role="alertdialog"
    >
      <h2 id="pin-change-title">{t("transport.pinChangeTitle")}</h2>
      <p id="pin-change-body">{t(matchesNode ? "transport.pinChangeBody" : "transport.pinChangeMismatch")}</p>
      <p className="transport-fingerprint">{t("transport.pinChangeCurrent", { fingerprint: current })}</p>
      <p className="transport-fingerprint">{t("transport.pinChangeNew", { fingerprint: next })}</p>
      <div className="report-dialog-actions">
        <button onClick={onReject} ref={keepRef} type="button">
          {t("transport.pinChangeReject")}
        </button>
        {matchesNode ? (
          <button className="danger-button" onClick={onAccept} type="button">
            {t("transport.pinChangeAccept")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
