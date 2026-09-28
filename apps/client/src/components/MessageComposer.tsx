import type { MessageAttachment, MessageLocation } from "@loam/schema";
import { useEffect, useId, useRef, useState } from "preact/hooks";

import { t } from "../i18n";
import { ATTACHMENT_MAX_COUNT } from "../lib/attachments";
import { IconAttach, IconClose, IconMapPin, IconSend } from "./icons";

/** The textarea grows with its content up to about six lines, then scrolls (matches `max-height` in CSS). */
const TEXTAREA_MAX_PX = 150;

interface MessageComposerProps {
  /** When true, the composer offers the "share location" toggle (docs/10; off by default). */
  allowLocationSharing?: boolean;
  /** When set, the composer is replaced by this notice and no message can be sent (e.g. a mod timeout). */
  disabledReason?: string;
  label: string;
  onSend: (body: string, attachments?: MessageAttachment[], location?: MessageLocation) => Promise<void>;
  /** Fired (throttled by the caller) as the user types, to emit an ephemeral "typing…" signal (P14). */
  onTyping?: () => void;
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
  /** A local `blob:` preview of an image, for the chip's thumbnail (revoked when the chip goes). */
  previewUrl?: string;
};

/** A thumbnail URL for a picked image, when the browser can make one cheaply (no decode happens here). */
function previewFor(file: File): string | undefined {
  if (!file.type.startsWith("image/") || typeof URL.createObjectURL !== "function") {
    return undefined;
  }
  try {
    return URL.createObjectURL(file);
  } catch {
    return undefined;
  }
}

/** Release a chip's preview URL. */
function revokePreview(entry: PendingAttachment): void {
  if (entry.previewUrl && typeof URL.revokeObjectURL === "function") {
    URL.revokeObjectURL(entry.previewUrl);
  }
}

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

export function MessageComposer({ allowLocationSharing, disabledReason, label, onSend, onTyping, onUploadAttachment, placeholder }: MessageComposerProps) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [locationOpen, setLocationOpen] = useState(false);
  const [locationLabel, setLocationLabel] = useState("");
  const [locationLat, setLocationLat] = useState("");
  const [locationLng, setLocationLng] = useState("");
  const pendingKeyRef = useRef(0);
  // An upload that resolves after the user moved to another conversation can't land in the new composer:
  // the caller keys the composer by conversation, so the new one is a separate instance, and Preact ignores a
  // state update on an unmounted component (ConversationView.test.tsx covers it).
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

  // Keep the latest chips reachable from the unmount cleanup, which must revoke their preview URLs.
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  useEffect(() => () => pendingRef.current.forEach(revokePreview), []);

  useEffect(() => {
    const textArea = textAreaRef.current;

    if (!textArea) {
      return;
    }

    textArea.style.height = "auto";
    if (textArea.scrollHeight) {
      textArea.style.height = `${Math.min(textArea.scrollHeight, TEXTAREA_MAX_PX)}px`;
    }
  }, [value]);

  /** Drop one chip (and its preview). */
  function removePending(key: string): void {
    setPending((previous) =>
      previous.filter((item) => {
        if (item.key === key) {
          revokePreview(item);
          return false;
        }
        return true;
      }),
    );
  }

  function attachFiles(files: File[] | null): void {
    if (!onUploadAttachment || !files || !files.length) {
      return;
    }

    const room = ATTACHMENT_MAX_COUNT - pending.filter((entry) => entry.status !== "error").length;

    for (const file of files.slice(0, Math.max(0, room))) {
      pendingKeyRef.current += 1;
      const key = `att-${pendingKeyRef.current}`;
      const previewUrl = previewFor(file);
      setPending((previous) => [...previous, { key, name: file.name, status: "uploading", previewUrl }]);
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
      pending.forEach(revokePreview);
      setPending([]);
      closeLocationForm();
    } catch {
      // onSend surfaces its own error (setError); keep the composer text so the user can retry
      // instead of losing what they typed (and don't leave the rejection unhandled).
    } finally {
      setSending(false);
    }
  }

  // A moderator timeout (or any caller-supplied reason) replaces the whole composer with a notice, so a
  // blocked user can't even attempt to send (the server also rejects, but this is the honest UI signal).
  if (disabledReason) {
    return (
      <div className="composer composer-disabled" role="status">
        <p className="composer-disabled-text">{disabledReason}</p>
      </div>
    );
  }

  const canSend = (!!value.trim() || !!readyAttachments.length || !!draftLocation) && !sending && !uploading && !locationIncomplete;

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {pending.length ? (
        <ul className="composer-attachments">
          {pending.map((entry) => (
            <li className={`attachment-chip ${entry.status}`} key={entry.key}>
              {entry.previewUrl ? (
                <img alt="" className="attachment-chip-thumb" src={entry.previewUrl} />
              ) : (
                <span aria-hidden="true" className="attachment-chip-icon">
                  <IconAttach size={16} />
                </span>
              )}
              <span className="attachment-chip-text">
                <span className="attachment-chip-name" title={entry.name}>
                  {entry.name}
                </span>
                {/* The reason must be readable on touch devices too, where a `title` tooltip never shows. */}
                {entry.status === "error" && entry.error ? (
                  <span className="attachment-chip-error" role="alert">
                    {entry.error}
                  </span>
                ) : entry.status === "uploading" ? (
                  <span aria-hidden="true" className="attachment-chip-progress" />
                ) : null}
              </span>
              <button
                aria-label={t("composer.removeAttachment", { name: entry.name })}
                className="btn btn-icon btn-sm btn-ghost attachment-chip-remove"
                disabled={sending}
                onClick={() => removePending(entry.key)}
                type="button"
              >
                <IconClose size={16} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {allowLocationSharing && locationOpen ? (
        <div className="composer-location-form">
          <label className="field composer-location-field">
            <span className="field-label">{t("composer.locationLabel")}</span>
            <input
              className="input composer-location-label"
              dir="auto"
              onInput={(event) => setLocationLabel(event.currentTarget.value)}
              placeholder={t("composer.locationLabelPlaceholder")}
              type="text"
              value={locationLabel}
            />
            <span className="field-hint">{t("composer.shareLocationHint")}</span>
          </label>
          <label className="field composer-location-coord">
            <span className="field-label">{t("composer.locationLat")}</span>
            <input
              className="input"
              inputMode="decimal"
              max={90}
              min={-90}
              onInput={(event) => setLocationLat(event.currentTarget.value)}
              step="any"
              type="number"
              value={locationLat}
            />
          </label>
          <label className="field composer-location-coord">
            <span className="field-label">{t("composer.locationLng")}</span>
            <input
              className="input"
              inputMode="decimal"
              max={180}
              min={-180}
              onInput={(event) => setLocationLng(event.currentTarget.value)}
              step="any"
              type="number"
              value={locationLng}
            />
          </label>
        </div>
      ) : null}
      <div className="composer-well">
        {onUploadAttachment ? (
          <>
            <input
              accept="image/*,.pdf,.txt,.csv,.md,.json,.zip,.doc,.docx,.xlsx,.pptx"
              className="sr-only"
              multiple
              onInput={(event) => {
                attachFiles(event.currentTarget.files ? Array.from(event.currentTarget.files) : null);
                event.currentTarget.value = "";
              }}
              ref={fileInputRef}
              tabIndex={-1}
              type="file"
            />
            <button
              aria-label={t("composer.attachImage")}
              className="btn btn-icon btn-ghost composer-attach"
              disabled={sending || pending.filter((entry) => entry.status !== "error").length >= ATTACHMENT_MAX_COUNT}
              onClick={() => fileInputRef.current?.click()}
              type="button"
            >
              <IconAttach />
            </button>
          </>
        ) : null}
        {allowLocationSharing ? (
          <button
            aria-label={t("composer.shareLocation")}
            aria-pressed={locationOpen}
            className={
              locationOpen
                ? "btn btn-icon btn-ghost composer-attach composer-location-toggle is-active"
                : "btn btn-icon btn-ghost composer-attach composer-location-toggle"
            }
            disabled={sending}
            onClick={() => (locationOpen ? closeLocationForm() : setLocationOpen(true))}
            type="button"
          >
            <IconMapPin />
          </button>
        ) : null}
        <label className="sr-only" for={composerId}>
          {label}
        </label>
        <textarea
          className="composer-input"
          dir="auto"
          id={composerId}
          onInput={(event) => {
            setValue(event.currentTarget.value);
            if (event.currentTarget.value.trim()) {
              onTyping?.();
            }
          }}
          onKeyDown={(event) => {
            // Enter-to-send on devices with a PRECISE pointer (desktop/laptop hosts, incl. the Electron
            // target): Enter submits, Shift+Enter inserts a newline. On touch (coarse pointer) Enter stays a
            // newline — the on-screen keyboard's return key must never fire a send mid-compose. Skip while an
            // IME is composing (`isComposing`) so Enter confirms the candidate rather than sending.
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.isComposing &&
              typeof window !== "undefined" &&
              window.matchMedia?.("(pointer: fine)").matches
            ) {
              event.preventDefault();
              void submit();
            }
          }}
          onPaste={handlePaste}
          placeholder={placeholder}
          ref={textAreaRef}
          rows={1}
          value={value}
        />
        <button
          aria-label={t("composer.send")}
          className="btn btn-icon btn-accent composer-send"
          disabled={!canSend}
          type="submit"
        >
          <IconSend size={18} />
        </button>
      </div>
    </form>
  );
}
