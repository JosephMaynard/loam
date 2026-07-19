import type { MessageAttachment, MessageLocation } from "@loam/schema";
import { useEffect, useId, useRef, useState } from "preact/hooks";

import { t } from "../i18n";
import { ATTACHMENT_MAX_COUNT } from "../lib/attachments";

/**
 * Paper-plane "send" glyph for the composer's submit button — same inline-SVG convention as
 * `BackArrowIcon`/the attach paperclip (fixed viewBox, `currentColor`, round strokes, `aria-hidden`
 * since the button itself carries the accessible label).
 */
function SendIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="20"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="2"
      viewBox="0 0 24 24"
      width="20"
    >
      <path d="M22 2L11 13" />
      <path d="M22 2l-7 20-4-9-9-4 20-7z" />
    </svg>
  );
}

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

  function attachFiles(files: File[] | null): void {
    if (!onUploadAttachment || !files || !files.length) {
      return;
    }

    const room = ATTACHMENT_MAX_COUNT - pending.filter((entry) => entry.status !== "error").length;

    for (const file of files.slice(0, Math.max(0, room))) {
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

  /**
   * Route a pasted image into the same on-device attachment pipeline the attach button uses
   * (`onUploadAttachment`, which wraps `prepareImageAttachment`) — no separate upload path to keep in
   * sync. Only wired when attachments are enabled; falls through to the browser's normal text paste
   * when the clipboard carries no image. An animated GIF pasted this way becomes a single static
   * frame, since the shared pipeline re-encodes through a `<canvas>`. Note this does NOT cover
   * Android's GIF/sticker keyboard: that inserts rich content via `InputEvent`'s
   * `dataTransfer`/`getTargetRanges`, which a plain WebView `<textarea>` doesn't support — only an
   * actual clipboard image (e.g. a long-press "Copy image", or a desktop paste) reaches this handler.
   */
  function handlePaste(event: ClipboardEvent): void {
    if (!onUploadAttachment) {
      return;
    }

    const items = event.clipboardData?.items;

    if (!items) {
      return;
    }

    const imageFiles: File[] = [];

    for (const item of Array.from(items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();

        if (file) {
          imageFiles.push(file);
        }
      }
    }

    if (!imageFiles.length) {
      return;
    }

    event.preventDefault();
    attachFiles(imageFiles);
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
                  attachFiles(event.currentTarget.files ? Array.from(event.currentTarget.files) : null);
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
                <svg
                  aria-hidden="true"
                  fill="none"
                  height="20"
                  stroke="currentColor"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  viewBox="0 0 24 24"
                  width="20"
                >
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
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
        onPaste={handlePaste}
        placeholder={placeholder}
        ref={textAreaRef}
        rows={1}
        value={value}
      />
      <button
        aria-label={t("composer.send")}
        className="composer-send"
        disabled={(!value.trim() && !readyAttachments.length && !draftLocation) || sending || uploading || locationIncomplete}
        title={t("composer.send")}
        type="submit"
      >
        <SendIcon />
      </button>
    </form>
  );
}
