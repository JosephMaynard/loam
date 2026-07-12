import { SyncStatusReportSchema, type SyncStatusReport } from "@loam/schema";
import { useEffect, useState } from "preact/hooks";

import { errorText, t } from "../i18n";
import { fetchJson } from "../lib/api";
import { displayTime } from "../lib/message-format";
import { encryptedFetch } from "../lib/transport";

function parseSyncStatusReport(payload: unknown): SyncStatusReport | undefined {
  const parsed = SyncStatusReportSchema.safeParse(payload);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Live per-peer sync status (`GET /api/admin/sync`) with a "Sync now" trigger. Reflects the
 * *saved* config — peers added above appear here after saving.
 */
export function SyncStatusPanel() {
  const [report, setReport] = useState<SyncStatusReport>();
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;

    fetchJson<unknown>("/api/admin/sync")
      .then((payload) => {
        if (!active) {
          return;
        }

        const parsed = parseSyncStatusReport(payload);

        if (!parsed) {
          // Surface contract drift instead of rendering a silently blank panel.
          setError(t("admin.syncStatusUnrecognised"));
          return;
        }

        setReport(parsed);
      })
      .catch((loadError: unknown) => {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : t("admin.syncStatusLoadError"));
        }
      });

    return () => {
      active = false;
    };
  }, [reloadKey]);

  async function runNow(): Promise<void> {
    setRunning(true);
    setError(undefined);

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 60_000);

    try {
      const response = await encryptedFetch("POST", "/api/admin/sync/run", undefined, {
        signal: controller.signal,
      });
      const payload: unknown = await response.json().catch(() => undefined);

      if (!response.ok) {
        const message = errorText(payload, t("admin.syncFailed", { status: response.status }));
        throw new Error(message);
      }

      const parsed = parseSyncStatusReport(payload);

      if (!parsed) {
        throw new Error(t("admin.syncStatusUnrecognised"));
      }

      setReport(parsed);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : t("admin.syncRunError"));
    } finally {
      window.clearTimeout(timeout);
      setRunning(false);
    }
  }

  if (!report?.peers.length) {
    return error ? <p className="form-error">{error}</p> : null;
  }

  return (
    <div className="sync-status">
      <div className="panel-heading">
        <p className="eyebrow">{t("admin.syncStatusEyebrow")}</p>
        <div className="moderation-actions">
          <button className="ghost-button" disabled={running} onClick={() => setReloadKey((key) => key + 1)} type="button">
            {t("common.refresh")}
          </button>
          <button disabled={running || !report.enabled} onClick={() => void runNow()} type="button">
            {running ? t("admin.syncing") : t("admin.syncNow")}
          </button>
        </div>
      </div>
      <ul className="moderation-list">
        {report.peers.map((peer) => (
          <li className="moderation-row sync-peer" key={peer.url}>
            <div className="moderation-name">
              <strong>{peer.label ?? peer.url}</strong>
              <span>
                {peer.status?.lastError
                  ? t("admin.peerError", { error: peer.status.lastError })
                  : peer.status?.lastSuccessAt
                    ? `${t("admin.peerLastSyncedAt", { time: displayTime(peer.status.lastSuccessAt) })} · ${t("admin.peerImported", { n: peer.status.imported })}`
                    : t("admin.peerNotSynced")}
              </span>
            </div>
          </li>
        ))}
      </ul>
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}
