import type { MessageAttachment, MessageLocation } from "@loam/schema";
import { useEffect, useId, useRef, useState } from "preact/hooks";

import { t } from "../i18n";
import { ATTACHMENT_MAX_COUNT } from "../lib/attachments";

interface MessageComposerProps {
  /** When true, the composer offers the "share location" toggle (docs/10; off by default). */
  allowLocationSharing?: boolean;
  label: string;
  onSend: (body: string, attachments?: MessageAttachment[], location?: MessageLocation) => Promise<void>;
  /** When present, the composer offers image attachments (resized on-device before upload). */
  onUploadAttachment?: (file: File) => Promise<MessageAttachment>;
  placeholder: string;
}

type PendingAttachment = {
  key: string;
  name: string;
  status: "uploading" | "ready" | "error";
  attachment?: MessageAttachment;
  error?: string;
};

/**
 * Parse the composer's location draft fields into a `MessageLocation`, mirroring
 * `MessageLocationSchema`'s rule that a share needs a label or both coordinates. Returns `undefined`
 * when the draft doesn't (yet) satisfy that rule, so a half-entered coordinate never sends silently.
 */
function buildDraftLocation(label: string, latText: string, lngText: string): MessageLocation | undefined {
  const trimmedLabel = label.trim();
  const lat = latText.trim() === "" ? undefined : Number(latText);
  const lng = lngText.trim() === "" ? undefined : Number(lngText);
  const hasValidLat = lat !== undefined && Number.isFinite(lat) && lat >= -90 && lat <= 90;
  const hasValidLng = lng !== undefined && Number.isFinite(lng) && lng >= -180 && lng <= 180;
  const hasCoords = hasValidLat && hasValidLng;

  if (!trimmedLabel && !hasCoords) {
    return undefined;
  }

  return {
    ...(trimmedLabel ? { label: trimmedLabel } : {}),
    ...(hasCoords ? { lat, lng } : {}),
  };
}

export function MessageComposer({ allowLocationSharing, label, onSend, onUploadAttachment, placeholder }: MessageComposerProps) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [locationOpen, setLocationOpen] = useState(false);
  const [locationLabel, setLocationLabel] = useState("");
  const [locationLat, setLocationLat] = useState("");
  const [locationLng, setLocationLng] = useState("");
  const pendingKeyRef = useRef(0);
  const composerId = useId();
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const readyAttachments = pending.flatMap((entry) => (entry.attachment ? [entry.attachment] : []));
  const uploading = pending.some((entry) => entry.status === "uploading");
  const draftLocation = locationOpen ? buildDraftLocation(locationLabel, locationLat, locationLng) : undefined;
  // The location panel is open but doesn't (yet) satisfy "a label or both coordinates" — block
  // sending rather than silently dropping what the person typed.
  const locationIncomplete =
    locationOpen && !draftLocation && (locationLabel.trim() !== "" || locationLat.trim() !== "" || locationLng.trim() !== "");

  useEffect(() => {
    const textArea = textAreaRef.current;

    if (!textArea) {
      return;
    }

    textArea.style.height = "auto";
    textArea.style.height = `${Math.min(textArea.scrollHeight, 168)}px`;
  }, [value]);

  function attachFiles(files: FileList | null): void {
    if (!onUploadAttachment || !files) {
      return;
    }

    const room = ATTACHMENT_MAX_COUNT - pending.filter((entry) => entry.status !== "error").length;

    for (const file of Array.from(files).slice(0, Math.max(0, room))) {
      pendingKeyRef.current += 1;
      const key = `att-${pendingKeyRef.current}`;
      setPending((previous) => [...previous, { key, name: file.name, status: "uploading" }]);
      onUploadAttachment(file)
        .then((attachment) => {
          setPending((previous) =>
            previous.map((entry) => (entry.key === key ? { ...entry, status: "ready", attachment } : entry)),
          );
        })
        .catch((uploadError: unknown) => {
          setPending((previous) =>
            previous.map((entry) =>
              entry.key === key
                ? {
                    ...entry,
                    status: "error",
                    error: uploadError instanceof Error ? uploadError.message : t("composer.uploadFailed"),
                  }
                : entry,
            ),
          );
        });
    }
  }

  /** Close the location panel and discard its draft — sharing is deliberate per message (docs/10),
   * so hiding the form never leaves a location silently queued to go out on the next send. */
  function closeLocationForm(): void {
    setLocationOpen(false);
    setLocationLabel("");
    setLocationLat("");
    setLocationLng("");
  }

  async function submit(): Promise<void> {
    const body = value.trim();

    if ((!body && !readyAttachments.length && !draftLocation) || sending || uploading || locationIncomplete) {
      return;
    }

    setSending(true);

    try {
      await onSend(body, readyAttachments.length ? readyAttachments : undefined, draftLocation);
      setValue("");
      setPending([]);
      closeLocationForm();
    } catch {
      // onSend surfaces its own error (setError); keep the composer text so the user can retry
      // instead of losing what they typed (and don't leave the rejection unhandled).
    } finally {
      setSending(false);
    }
  }

  return (
    <form
      className={onUploadAttachment || allowLocationSharing ? "composer has-attach" : "composer"}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {pending.length ? (
        <div className="composer-attachments">
          {pending.map((entry) => (
            <span className={`attachment-chip ${entry.status}`} key={entry.key}>
              {entry.status === "uploading" ? "⏳ " : entry.status === "error" ? "⚠ " : "🖼 "}
              <span className="attachment-chip-name" title={entry.error}>
                {entry.name}
              </span>
              <button
                aria-label={t("composer.removeAttachment", { name: entry.name })}
                disabled={sending}
                onClick={() => setPending((previous) => previous.filter((item) => item.key !== entry.key))}
                type="button"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {allowLocationSharing && locationOpen ? (
        <div className="composer-location-form">
          <input
            aria-label={t("composer.locationLabel")}
            className="composer-location-label"
            dir="auto"
            onInput={(event) => setLocationLabel(event.currentTarget.value)}
            placeholder={t("composer.locationLabelPlaceholder")}
            type="text"
            value={locationLabel}
          />
          <input
            aria-label={t("composer.locationLat")}
            className="composer-location-coord"
            inputMode="decimal"
            max={90}
            min={-90}
            onInput={(event) => setLocationLat(event.currentTarget.value)}
            placeholder={t("composer.locationLat")}
            step="any"
            type="number"
            value={locationLat}
          />
          <input
            aria-label={t("composer.locationLng")}
            className="composer-location-coord"
            inputMode="decimal"
            max={180}
            min={-180}
            onInput={(event) => setLocationLng(event.currentTarget.value)}
            placeholder={t("composer.locationLng")}
            step="any"
            type="number"
            value={locationLng}
          />
        </div>
      ) : null}
      <label className="sr-only" for={composerId}>
        {label}
      </label>
      {onUploadAttachment || allowLocationSharing ? (
        <div className="composer-tools">
          {onUploadAttachment ? (
            <>
              <input
                accept="image/png,image/jpeg,image/webp,image/*"
                className="sr-only"
                multiple
                onInput={(event) => {
                  attachFiles(event.currentTarget.files);
                  event.currentTarget.value = "";
                }}
                ref={fileInputRef}
                type="file"
              />
              <button
                aria-label={t("composer.attachImage")}
                className="composer-attach"
                disabled={sending || pending.filter((entry) => entry.status !== "error").length >= ATTACHMENT_MAX_COUNT}
                onClick={() => fileInputRef.current?.click()}
                title={t("composer.attachImageHint")}
                type="button"
              >
                🖼
              </button>
            </>
          ) : null}
          {allowLocationSharing ? (
            <button
              aria-label={t("composer.shareLocation")}
              aria-pressed={locationOpen}
              className="composer-attach composer-location-toggle"
              disabled={sending}
              onClick={() => (locationOpen ? closeLocationForm() : setLocationOpen(true))}
              title={t("composer.shareLocationHint")}
              type="button"
            >
              📍
            </button>
          ) : null}
        </div>
      ) : null}
      <textarea
        dir="auto"
        id={composerId}
        onInput={(event) => setValue(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
        }}
        placeholder={placeholder}
        ref={textAreaRef}
        rows={1}
        value={value}
      />
      <button
        disabled={(!value.trim() && !readyAttachments.length && !draftLocation) || sending || uploading || locationIncomplete}
        type="submit"
      >
        {t("composer.send")}
      </button>
    </form>
  );
}
