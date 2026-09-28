import { SyncPeerSchema, type SyncPeer } from "@loam/schema";
import { useState } from "preact/hooks";

import { t } from "../i18n";

/** Compact add-a-peer form: URL (required, http/https) + optional label + optional pinned transport key. */
export function AddSyncPeerControl({
  disabled,
  onAdd,
}: {
  disabled: boolean;
  onAdd: (peer: SyncPeer) => void;
}) {
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [transportKey, setTransportKey] = useState("");
  const trimmedUrl = url.trim().replace(/\/+$/, "");
  const trimmedKey = transportKey.trim();
  // Validate the WHOLE candidate peer against the shared schema (URL protocol, key charset+length, label
  // bound) — the same shape the server stores — instead of hand-rolled partial checks.
  const candidate = SyncPeerSchema.safeParse({
    url: trimmedUrl,
    ...(label.trim() ? { label: label.trim() } : {}),
    ...(trimmedKey ? { transportKey: trimmedKey } : {}),
  });

  return (
    <div className="sync-peer-add">
      <label className="field">
        <span className="field-label">{t("admin.peerUrl")}</span>
        <input
          className="input"
          dir="ltr"
          disabled={disabled}
          inputMode="url"
          onInput={(event) => setUrl(event.currentTarget.value)}
          placeholder="http://192.168.0.10:3000"
          value={url}
        />
      </label>
      <label className="field">
        <span className="field-label">{t("admin.peerLabel")}</span>
        <input
          className="input"
          disabled={disabled}
          maxLength={80}
          onInput={(event) => setLabel(event.currentTarget.value)}
          placeholder={t("admin.peerLabelPlaceholder")}
          value={label}
        />
      </label>
      <label className="field">
        <span className="field-label">{t("admin.peerKey")}</span>
        <input
          className="input mono-field"
          dir="ltr"
          disabled={disabled}
          onInput={(event) => setTransportKey(event.currentTarget.value)}
          placeholder={t("admin.peerKeyPlaceholder")}
          value={transportKey}
        />
      </label>
      <button
        className="btn btn-secondary sync-peer-add-button"
        disabled={disabled || !candidate.success}
        onClick={() => {
          if (!candidate.success) {
            return;
          }
          onAdd(candidate.data);
          setUrl("");
          setLabel("");
          setTransportKey("");
        }}
        type="button"
      >
        {t("admin.addPeer")}
      </button>
    </div>
  );
}
