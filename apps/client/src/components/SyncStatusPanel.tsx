import { type SyncLinkRequestEntry, type SyncPeer, SyncStatusReportSchema, type SyncStatusReport } from "@loam/schema";
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
 * *saved* config — peers added above appear here after saving. Also lists other networks asking to sync
 * with this one (server `sync-links.ts`), shown even while sync is off, since accepting switches it on.
 * `onAccepted` lets the admin form above take in the peer an accept just saved, so its next save keeps it;
 * `hasToken` says whether this node uses a shared mesh token the other network will need too.
 */
export function SyncStatusPanel({
  hasToken = false,
  onAccepted,
}: {
  hasToken?: boolean;
  onAccepted?: (peer: SyncPeer) => void;
} = {}) {
  const [report, setReport] = useState<SyncStatusReport>();
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState(false);
  const [deciding, setDeciding] = useState<string>();
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    // Clear a prior error as the (re)load starts, so a transient failure that succeeds on retry doesn't
    // leave a stale error banner alongside fresh data.
    setError(undefined);

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

        setError(undefined);
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

  /** Accept or decline a link request; the server answers with the fresh report. */
  async function decide(request: SyncLinkRequestEntry, action: "accept" | "decline"): Promise<void> {
    setDeciding(request.id);
    setError(undefined);
    try {
      const response = await encryptedFetch("POST", `/api/admin/sync/link-requests/${request.id}/${action}`);
      const payload: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        throw new Error(errorText(payload, t("admin.syncFailed", { status: response.status })));
      }
      const parsed = parseSyncStatusReport(payload);
      if (!parsed) {
        throw new Error(t("admin.syncStatusUnrecognised"));
      }
      setReport(parsed);
      const peer = action === "accept" ? parsed.peers.find((entry) => entry.url === request.url) : undefined;
      if (peer) {
        onAccepted?.({
          url: peer.url,
          ...(peer.label ? { label: peer.label } : {}),
          ...(peer.transportKey ? { transportKey: peer.transportKey } : {}),
        });
      }
    } catch (decideError) {
      setError(decideError instanceof Error ? decideError.message : t("admin.syncRunError"));
    } finally {
      setDeciding(undefined);
    }
  }

  const linkRequests = report?.linkRequests ?? [];
  const requestsBlock = linkRequests.length ? (
    <div className="sync-link-requests">
      <h4 className="card-subtitle">{t("admin.linkRequestsTitle")}</h4>
      <p className="form-note">{t("admin.linkRequestsNote")}</p>
      {hasToken ? <p className="form-note">{t("admin.linkTokenNote")}</p> : null}
      <ul className="list">
        {linkRequests.map((request) => (
          <li className="list-row sync-link-request" key={request.id}>
            <div className="row-text row-text-first">
              <strong className="row-title">{request.name ?? request.url}</strong>
              <span className="row-meta">
                {t("admin.linkRequestMeta", { url: request.url, time: displayTime(request.requestedAt) })}
              </span>
            </div>
            <div className="row-actions">
              <button
                className="btn btn-ghost btn-sm"
                disabled={deciding !== undefined}
                onClick={() => void decide(request, "decline")}
                type="button"
              >
                {t("admin.linkDecline")}
              </button>
              <button
                className="btn btn-secondary btn-sm"
                disabled={deciding !== undefined}
                onClick={() => void decide(request, "accept")}
                type="button"
              >
                {t("admin.linkAccept")}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  ) : null;

  if (!report?.peers.length) {
    if (requestsBlock) {
      return (
        <div className="sync-status">
          {requestsBlock}
          {error ? <p className="form-error">{error}</p> : null}
        </div>
      );
    }
    // Keep a retry affordance in the error/empty state: a transient load failure shouldn't force a full
    // page reload to recover — the refresh button re-runs the fetch effect (via `reloadKey`).
    if (!error) {
      return null;
    }
    return (
      <div className="sync-status">
        <p className="notice notice-danger">
          {error}
          <button className="btn btn-ghost btn-sm" onClick={() => setReloadKey((key) => key + 1)} type="button">
            {t("common.refresh")}
          </button>
        </p>
      </div>
    );
  }

  return (
    <div className="sync-status">
      <div className="sync-status-header">
        <h4 className="card-subtitle">
          {t("admin.syncStatusEyebrow")}
          {report.enabled ? (
            <span className="card-subtitle-meta">
              {" · "}
              {t("admin.syncEvery", { seconds: Math.round(report.intervalMs / 1000) })}
            </span>
          ) : null}
        </h4>
        <div className="row-actions">
          <button
            className="btn btn-ghost btn-sm"
            disabled={running}
            onClick={() => setReloadKey((key) => key + 1)}
            type="button"
          >
            {t("common.refresh")}
          </button>
          <button
            className="btn btn-secondary btn-sm"
            disabled={running || !report.enabled}
            onClick={() => void runNow()}
            type="button"
          >
            {running ? t("admin.syncing") : t("admin.syncNow")}
          </button>
        </div>
      </div>
      <ul className="list">
        {report.peers.map((peer) => (
          <li className="list-row sync-peer" key={peer.url}>
            <div className="row-text row-text-first">
              <strong className="row-title">{peer.label ?? peer.url}</strong>
              <span className={peer.status?.lastError ? "row-meta row-meta-danger" : "row-meta"}>
                {peer.status?.lastError
                  ? t("admin.peerError", { error: peer.status.lastError })
                  : peer.status?.lastSuccessAt
                    ? `${t("admin.peerLastSyncedAt", { time: displayTime(peer.status.lastSuccessAt) })} · ${t("admin.peerImported", { n: peer.status.imported })}`
                    : t("admin.peerNotSynced")}
                {peer.link === "pending" ? ` · ${t("admin.peerLinkPending")}` : null}
              </span>
            </div>
          </li>
        ))}
      </ul>
      {requestsBlock}
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}
