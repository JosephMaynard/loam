import { ReportReasonSchema, type ReportReason, type ReportTargetType } from "@loam/schema";
import { useState } from "preact/hooks";

import { t } from "../i18n";
import { requestJson } from "../lib/api";
import { Dialog } from "./Dialog";

interface ReportDialogProps {
  targetType: ReportTargetType;
  targetId: string;
  onClose: () => void;
}

/**
 * A small modal for filing a member abuse report (docs/26): pick a reason, add an optional note, submit.
 * Built on `Dialog` (a bottom sheet on phones, a centred card wider up), which handles focus, the Tab
 * trap, Escape and handing focus back to whatever opened it. The report is moderator-private — the member
 * only gets a "sent to the moderators" confirmation; nothing about it is shown back in the conversation.
 */
export function ReportDialog({ targetType, targetId, onClose }: ReportDialogProps) {
  const [reason, setReason] = useState<ReportReason>("spam");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState(false);

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
    <Dialog
      className="report-dialog"
      closeLabel={t("report.cancel")}
      onClose={onClose}
      title={targetType === "message" ? t("report.messageTitle") : t("report.userTitle")}
    >
      {sent ? (
        <>
          <p className="report-dialog-sent" role="status">
            {t("report.sent")}
          </p>
          <div className="dialog-actions">
            <button className="btn btn-primary" onClick={onClose} type="button">
              {t("report.done")}
            </button>
          </div>
        </>
      ) : (
        <form
          className="report-dialog-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="field">
            <span className="field-label">{t("report.reasonLabel")}</span>
            <select
              className="select"
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
          <label className="field">
            <span className="field-label">{t("report.noteLabel")}</span>
            <textarea
              className="textarea"
              dir="auto"
              disabled={busy}
              maxLength={1000}
              onInput={(event) => setNote(event.currentTarget.value)}
              placeholder={t("report.notePlaceholder")}
              rows={3}
              value={note}
            />
          </label>
          {/* Honest about what a report shares: the moderators see the reported message itself. */}
          <p className="field-hint report-shared">{t("report.shared")}</p>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="dialog-actions">
            <button className="btn btn-secondary" disabled={busy} onClick={onClose} type="button">
              {t("report.cancel")}
            </button>
            <button className="btn btn-primary" disabled={busy} type="submit">
              {busy ? t("report.submitting") : t("report.submit")}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
