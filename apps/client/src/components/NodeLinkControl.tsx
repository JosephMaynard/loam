import { SyncLinkCodeResponseSchema } from "@loam/schema";
import { useMemo, useState } from "preact/hooks";

import { errorText, t } from "../i18n";
import { safeQrSvg } from "../lib/qr";
import { displayTime } from "../lib/message-format";
import { encryptedFetch, inviteQrHostKey, joinQrUrl } from "../lib/transport";

/**
 * "Link another node" for the admin sync panel (server `sync-links.ts`): an admin deliberately shows a
 * single-use, 10-minute code as a QR, and the new node scans it from its setup screens ("Join another LOAM
 * network"). The QR is the join URL plus this network's key and the code (`#k=<key>&l=<code>`): the key
 * lets the new node send the code sealed, and the code is what lets it link, both ways, with no request to
 * approve. The code is never shown as text: it's a credential until it's used.
 *
 * Only a key this device verified by scanning (see `inviteQrHostKey`) may go in the QR, so a device that
 * joined by typing the address is told to show the code from the host phone instead.
 */
export function NodeLinkControl({ joinUrl }: { joinUrl?: string }) {
  const [shown, setShown] = useState<{ code: string; expiresAt: number }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const hostKey = inviteQrHostKey();
  const canVouch = !!joinUrl && !hostKey.suppressed && !!hostKey.key;
  const qrSvg = useMemo(
    () => (shown && joinUrl && hostKey.key ? safeQrSvg(`${joinQrUrl(joinUrl, hostKey.key)}&l=${shown.code}`, "#16271f") : ""),
    [shown, joinUrl, hostKey.key],
  );

  if (!joinUrl) {
    return null;
  }

  async function showCode(): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      const response = await encryptedFetch("POST", "/api/admin/sync/link-code");
      const payload: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        throw new Error(errorText(payload, t("admin.syncFailed", { status: response.status })));
      }
      const parsed = SyncLinkCodeResponseSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error(t("admin.syncStatusUnrecognised"));
      }
      setShown(parsed.data);
    } catch (showError) {
      setError(showError instanceof Error ? showError.message : t("admin.syncRunError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="node-link-control">
      {shown ? null : (
        <button className="btn btn-secondary btn-sm" disabled={busy || !canVouch} onClick={() => void showCode()} type="button">
          {t("nodeLink.show")}
        </button>
      )}
      {canVouch ? null : <p className="form-note">{t("nodeLink.needsKey")}</p>}
      {shown ? (
        <div className="invite-panel">
          <div aria-hidden="true" className="qr-tile invite-qr" dangerouslySetInnerHTML={{ __html: qrSvg }} />
          <p className="form-note">{t("nodeLink.note")}</p>
          <p className="form-note">{t("nodeLink.expires", { time: displayTime(shown.expiresAt) })}</p>
          <div className="card-actions">
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void showCode()} type="button">
              {t("nodeLink.again")}
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => setShown(undefined)} type="button">
              {t("nodeLink.hide")}
            </button>
          </div>
        </div>
      ) : null}
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}
