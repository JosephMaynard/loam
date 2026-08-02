import { useState } from "preact/hooks";

import { t } from "../i18n";

/** Compact add-a-peer form: URL (required, http/https) + optional label + optional pinned transport key. */
export function AddSyncPeerControl({
  disabled,
  onAdd,
}: {
  disabled: boolean;
  onAdd: (peer: { url: string; label?: string; transportKey?: string }) => void;
}) {
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [transportKey, setTransportKey] = useState("");
  const trimmedUrl = url.trim().replace(/\/+$/, "");
  const trimmedKey = transportKey.trim();
  const validUrl = /^https?:\/\/.+/.test(trimmedUrl);
  // Optional; when present it must be base64url within the server's length bound (SyncPeerSchema, max 64).
  const validKey = trimmedKey === "" || (/^[A-Za-z0-9_-]+$/.test(trimmedKey) && trimmedKey.length <= 64);

  return (
    <div className="sync-peer-add">
      <label>
        {t("admin.peerUrl")}
        <input
          disabled={disabled}
          onInput={(event) => setUrl(event.currentTarget.value)}
          placeholder="http://192.168.0.10:3000"
          value={url}
        />
      </label>
      <label>
        {t("admin.peerLabel")}
        <input
          disabled={disabled}
          maxLength={80}
          onInput={(event) => setLabel(event.currentTarget.value)}
          placeholder={t("admin.peerLabelPlaceholder")}
          value={label}
        />
      </label>
      <label>
        {t("admin.peerKey")}
        <input
          disabled={disabled}
          onInput={(event) => setTransportKey(event.currentTarget.value)}
          placeholder={t("admin.peerKeyPlaceholder")}
          value={transportKey}
        />
      </label>
      <button
        disabled={disabled || !validUrl || !validKey}
        onClick={() => {
          onAdd({
            url: trimmedUrl,
            ...(label.trim() ? { label: label.trim() } : {}),
            ...(trimmedKey ? { transportKey: trimmedKey } : {}),
          });
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
