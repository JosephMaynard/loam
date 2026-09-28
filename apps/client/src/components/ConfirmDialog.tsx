import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";

import { t } from "../i18n";
import { Dialog } from "./Dialog";

export interface ConfirmDialogProps {
  /** The dialog heading: what is about to happen ("Emergency Reset", "Ban"). */
  title: ComponentChildren;
  /** The consequence, in a sentence or two. */
  children: ComponentChildren;
  /** The confirm button's label ("Wipe this node now", "Delete"). */
  confirmLabel: string;
  /** Label while `busy` (defaults to `confirmLabel`). */
  busyLabel?: string;
  /** Called with what the user typed into the `confirmWord` field ("" without one). */
  onConfirm: (typed: string) => void;
  onCancel: () => void;
  /** Destructive actions get the red button (default); a reversible one passes `false` for moss. */
  danger?: boolean;
  busy?: boolean;
  /** Shown under the body when the confirmed action failed. */
  error?: string;
  /**
   * A word the user must type before the confirm button unlocks (the "type wipe" guard). The field is
   * labelled `{confirmWordBefore} <word> {confirmWordAfter}` so each locale keeps its own word order.
   */
  confirmWord?: string;
  confirmWordBefore?: string;
  confirmWordAfter?: string;
}

/**
 * The interrupting confirmation for a destructive action (wipe, kill switch, ban, delete): a `Dialog` with
 * `role="alertdialog"`, the consequence, an optional typed-word guard, and Cancel + confirm. Focus lands on
 * Cancel (or the typed-word field) so a stray Enter never confirms. Render it conditionally, like `Dialog`.
 */
export function ConfirmDialog({
  busy = false,
  busyLabel,
  children,
  confirmLabel,
  confirmWord,
  confirmWordAfter,
  confirmWordBefore,
  danger = true,
  error,
  onCancel,
  onConfirm,
  title,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState("");
  const cancelRef = useRef<HTMLButtonElement>(null);
  const wordRef = useRef<HTMLInputElement>(null);
  const locked = confirmWord !== undefined && typed.trim() !== confirmWord;

  // Land on the safe control. Dialog keeps focus on a child that took it during mount.
  useLayoutEffect(() => {
    (wordRef.current ?? cancelRef.current)?.focus();
  }, []);

  return (
    <Dialog onClose={busy ? () => undefined : onCancel} role="alertdialog" title={title}>
      <div className="confirm-body">{children}</div>
      {confirmWord !== undefined ? (
        <label className="field">
          <span className="field-label">
            {confirmWordBefore} <strong>{confirmWord}</strong> {confirmWordAfter}
          </span>
          <input
            autoComplete="off"
            className="input"
            disabled={busy}
            onInput={(event) => setTyped(event.currentTarget.value)}
            onKeyDown={(event) => {
              // Enter confirms only once the word matches, and never submits a form the dialog sits in.
              if (event.key === "Enter") {
                event.preventDefault();
                if (!locked && !busy) {
                  onConfirm(typed.trim());
                }
              }
            }}
            ref={wordRef}
            spellcheck={false}
            value={typed}
          />
        </label>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="dialog-actions">
        <button className="btn btn-secondary" disabled={busy} onClick={onCancel} ref={cancelRef} type="button">
          {t("common.cancel")}
        </button>
        <button
          className={danger ? "btn btn-danger" : "btn btn-primary"}
          disabled={busy || locked}
          onClick={() => onConfirm(typed.trim())}
          type="button"
        >
          {busy ? (busyLabel ?? confirmLabel) : confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
