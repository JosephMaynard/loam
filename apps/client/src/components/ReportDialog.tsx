import { ReportReasonSchema, type ReportReason, type ReportTargetType } from "@loam/schema";
import { useEffect, useRef, useState } from "preact/hooks";

import { t } from "../i18n";
import { requestJson } from "../lib/api";

interface ReportDialogProps {
  targetType: ReportTargetType;
  targetId: string;
  onClose: () => void;
}

/**
 * A small modal for filing a member abuse report (docs/26): pick a reason, add an optional note, submit.
 * Reuses the invite-modal overlay styling. The report is moderator-private — the member only gets a
 * "sent to the moderators" confirmation; nothing about it is shown back in the conversation.
 */
export function ReportDialog({ targetType, targetId, onClose }: ReportDialogProps) {
  const [reason, setReason] = useState<ReportReason>("spam");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Move focus into the dialog on open (accessibility), so keyboard/screen-reader users land in it.
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(undefined);

    try {
      await requestJson("POST", "/api/reports", {
        targetType,
        targetId,
        reason,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setSent(true);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("report.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="invite-modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        aria-labelledby="report-dialog-title"
        aria-modal="true"
        className="invite-modal report-dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            onClose();
          }
        }}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="invite-modal-header">
          <h2 id="report-dialog-title">
            {targetType === "message" ? t("report.messageTitle") : t("report.userTitle")}
          </h2>
          <button aria-label={t("report.cancel")} className="close-button" onClick={onClose} type="button">
            ×
          </button>
        </div>

        {sent ? (
          <>
            <p className="report-dialog-sent">{t("report.sent")}</p>
            <div className="report-dialog-actions">
              <button onClick={onClose} type="button">
                {t("report.cancel")}
              </button>
            </div>
          </>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <label>
              {t("report.reasonLabel")}
              <select
                disabled={busy}
                onInput={(event) => setReason(ReportReasonSchema.parse(event.currentTarget.value))}
                value={reason}
              >
                {ReportReasonSchema.options.map((option) => (
                  <option key={option} value={option}>
                    {t(`report.reason.${option}` as Parameters<typeof t>[0])}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("report.noteLabel")}
              <textarea
                disabled={busy}
                maxLength={1000}
                onInput={(event) => setNote(event.currentTarget.value)}
                placeholder={t("report.notePlaceholder")}
                rows={3}
                value={note}
              />
            </label>
            {error ? <p className="form-error">{error}</p> : null}
            <div className="report-dialog-actions">
              <button disabled={busy} type="submit">
                {busy ? t("report.submitting") : t("report.submit")}
              </button>
              <button disabled={busy} onClick={onClose} type="button">
                {t("report.cancel")}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
