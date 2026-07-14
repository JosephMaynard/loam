import { useState } from "preact/hooks";

import { t } from "../i18n";

/** Compact add-a-peer form: URL (required, http/https) + optional label. */
export function AddSyncPeerControl({
  disabled,
  onAdd,
}: {
  disabled: boolean;
  onAdd: (peer: { url: string; label?: string }) => void;
}) {
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const trimmedUrl = url.trim().replace(/\/+$/, "");
  const validUrl = /^https?:\/\/.+/.test(trimmedUrl);

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
      <button
        disabled={disabled || !validUrl}
        onClick={() => {
          onAdd({ url: trimmedUrl, ...(label.trim() ? { label: label.trim() } : {}) });
          setUrl("");
          setLabel("");
        }}
        type="button"
      >
        {t("admin.addPeer")}
      </button>
    </div>
  );
}
