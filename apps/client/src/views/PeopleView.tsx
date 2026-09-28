import {
  ReportSchema,
  UserSchema,
  type Report,
  type ReportResolution,
  type Role,
  type User,
} from "@loam/schema";
import { generateDisplayName } from "@loam/display-name";
import { useCallback, useEffect, useState } from "preact/hooks";

import { Avatar } from "../components/Avatar";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CardHeader } from "../components/ScreenParts";
import { ScreenHeader } from "../components/ScreenHeader";
import { errorText, t } from "../i18n";
import { fetchJson, parseUserList, requestJson, REQUEST_TIMEOUT_MS } from "../lib/api";
import { canGreet, canManageRoles, canModerate, isProtectedTarget } from "../lib/capabilities";
import { useIsTimedOut } from "../lib/timeout";
import { encryptedFetch } from "../lib/transport";

/**
 * Issues a user-related admin/moderation/access request and returns the validated user the server
 * echoes back. Throws with the server's error message (or a status fallback) on failure. Mirrors
 * `requestChannel` for the user-management endpoints.
 *
 * @param method - HTTP method (`POST` for approve/deny, `PATCH` for roles/moderation).
 * @param path - The API path.
 * @param body - Optional JSON request body.
 * @returns The updated `User`.
 */
async function requestUser(method: "POST" | "PATCH", path: string, body?: unknown): Promise<User> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await encryptedFetch(method, path, body, { signal: controller.signal });
    const payload: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      const message = errorText(payload, `Request failed: ${response.status}`);
      throw new Error(message);
    }

    const parsed = UserSchema.safeParse(payload);

    if (!parsed.success) {
      throw new Error(t("app.userUnrecognised"));
    }

    return parsed.data;
  } finally {
    window.clearTimeout(timeout);
  }
}

/**
 * People & moderation surface for admins, moderators, and greeters. Greeters see the pending-join
 * queue; moderators (and admins) see the full roster with ban / shadow-ban controls; admins also get
 * role assignment. All gating here is cosmetic — the server enforces every capability.
 */
export function PeopleView({
  currentUser,
  onUsersChanged,
}: {
  currentUser: User;
  onUsersChanged: (users: User[]) => void;
}) {
  const greeter = canGreet(currentUser);
  const moderator = canModerate(currentUser);

  if (!greeter && !moderator) {
    return (
      <section className="settings-view">
        <ScreenHeader title={t("people.notAuthorizedTitle")} />
        <div className="screen-body">
          <div className="screen-column">
            <p className="empty-note">{t("people.notAuthorizedNote")}</p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="settings-view">
      <ScreenHeader title={t("people.title")} />
      <div className="screen-body">
        <div className="screen-column">
          {greeter ? <PendingApprovalsPanel onUsersChanged={onUsersChanged} /> : null}
          {moderator ? <ModerationPanel currentUser={currentUser} onUsersChanged={onUsersChanged} /> : null}
        </div>
      </div>
    </section>
  );
}

/** The small ghost "Refresh" button in a card's title row. */
function RefreshButton({ disabled, onClick }: { disabled?: boolean; onClick: () => void }) {
  return (
    <button className="btn btn-ghost btn-sm" disabled={disabled} onClick={onClick} type="button">
      {t("common.refresh")}
    </button>
  );
}

/**
 * Greeter queue: lists users awaiting approval (`GET /api/access/pending`) with Approve / Deny
 * actions. Pending users are hidden from the normal roster, so this panel fetches its own list and
 * offers a manual refresh.
 */
function PendingApprovalsPanel({ onUsersChanged }: { onUsersChanged: (users: User[]) => void }) {
  const [pending, setPending] = useState<User[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setLoaded(false);
    setLoadError(undefined);

    fetchJson<unknown>("/api/access/pending")
      .then((payload) => {
        if (!active) {
          return;
        }

        setPending(parseUserList(payload));
        setLoaded(true);
      })
      .catch((error: unknown) => {
        if (active) {
          setLoadError(error instanceof Error ? error.message : t("people.pendingLoadError"));
        }
      });

    return () => {
      active = false;
    };
  }, [reloadKey]);

  return (
    <div className="card">
      <CardHeader
        actions={<RefreshButton onClick={() => setReloadKey((key) => key + 1)} />}
        title={t("people.pendingTitle")}
      />
      {loadError ? <p className="notice notice-danger">{loadError}</p> : null}
      {!loaded && !loadError ? <p className="form-note">{t("people.pendingLoading")}</p> : null}
      {loaded && pending.length === 0 ? <p className="empty-note">{t("people.pendingEmpty")}</p> : null}
      {pending.length > 0 ? (
        <ul className="list">
          {pending.map((user) => (
            <PendingRow
              key={user.id}
              onResolved={(resolved) => {
                setPending((previous) => previous.filter((entry) => entry.id !== resolved.id));
                onUsersChanged([resolved]);
              }}
              user={user}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * One pending-join row: Approve lets the user in; Deny bans them. Holds its own busy/error state so
 * resolving one person never disturbs another.
 */
function PendingRow({ onResolved, user }: { onResolved: (user: User) => void; user: User }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function decide(action: "approve" | "deny"): Promise<void> {
    setBusy(true);
    setError(undefined);

    try {
      const updated = await requestUser("POST", `/api/access/users/${encodeURIComponent(user.id)}/${action}`);
      onResolved(updated);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("moderation.updateError"));
      setBusy(false);
    }
  }

  return (
    <li className="list-row pending-row">
      <Avatar avatar={user.avatar} id={user.id} size="md" />
      <div className="row-text">
        <strong className="row-title" dir="auto">
          {user.displayName}
        </strong>
        <span className="row-meta">{user.id}</span>
      </div>
      <div className="row-actions">
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void decide("approve")} type="button">
          {t("people.approve")}
        </button>
        <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => void decide("deny")} type="button">
          {t("people.deny")}
        </button>
      </div>
      {error ? <p className="form-error row-detail">{error}</p> : null}
    </li>
  );
}

/**
 * Moderator roster: the full human user list including banned / shadow-banned people
 * (`GET /api/moderation/users`) so they can be unbanned. Each row exposes ban / shadow-ban toggles,
 * and (for admins) role assignment. Controls are hidden for admin targets and for yourself.
 */
const TIMEOUT_DURATION_MS = 3_600_000; // a moderator "time out" lasts one hour

/**
 * The moderator report queue (docs/26): open member reports with one-motion actions. A message report
 * offers Remove / Escalate / Dismiss; a user report offers Time-out / Ban / Escalate / Dismiss. Every
 * action resolves the report (it drops out of the queue). Names are resolved from the moderation roster.
 */
function ReportQueue({ people, onApplyUser }: { people: User[]; onApplyUser: (user: User) => void }) {
  const [reports, setReports] = useState<Report[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();
  const [busyId, setBusyId] = useState<string>();
  const [reloadKey, setReloadKey] = useState(0);
  // A user report whose "Ban" is waiting on its alertdialog.
  const [confirmingBan, setConfirmingBan] = useState<Report>();

  useEffect(() => {
    let active = true;
    setLoaded(false);
    // A reload starts clean: a failure shown from the previous load must not survive a successful refresh.
    setError(undefined);
    fetchJson<unknown>("/api/moderation/reports")
      .then((payload) => {
        if (!active) {
          return;
        }
        setReports(
          Array.isArray(payload)
            ? payload.flatMap((item) => {
                const parsed = ReportSchema.safeParse(item);
                return parsed.success ? [parsed.data] : [];
              })
            : [],
        );
        setLoaded(true);
      })
      .catch((loadError: unknown) => {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : t("moderation.reports.loadError"));
        }
      });
    return () => {
      active = false;
    };
  }, [reloadKey]);

  const nameFor = (id: string): string => people.find((entry) => entry.id === id)?.displayName ?? generateDisplayName(id);

  async function act(report: Report, enforce: () => Promise<unknown>, resolution: ReportResolution): Promise<void> {
    setBusyId(report.id);
    setError(undefined);
    try {
      await enforce();
      await requestJson("POST", `/api/moderation/reports/${encodeURIComponent(report.id)}/resolve`, { resolution });
      setReports((previous) => previous.filter((entry) => entry.id !== report.id));
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : t("moderation.updateError"));
    } finally {
      setBusyId(undefined);
    }
  }

  const removeMessage = (id: string): Promise<unknown> =>
    requestJson("POST", `/api/moderation/messages/${encodeURIComponent(id)}/remove`, {});
  const moderateUser = async (id: string, update: Record<string, unknown>): Promise<void> => {
    const updated = await requestJson<unknown>("PATCH", `/api/moderation/users/${encodeURIComponent(id)}`, update);
    const parsed = UserSchema.safeParse(updated);
    if (parsed.success) {
      onApplyUser(parsed.data);
    }
  };

  return (
    <div className="card report-queue">
      <CardHeader
        actions={<RefreshButton onClick={() => setReloadKey((key) => key + 1)} />}
        title={t("moderation.reports.title")}
      />
      {error ? <p className="notice notice-danger">{error}</p> : null}
      {loaded && reports.length === 0 ? <p className="empty-note">{t("moderation.reports.empty")}</p> : null}
      {reports.length > 0 ? (
        <ul className="list report-list">
          {reports.map((report) => {
            const busy = busyId === report.id;
            return (
              <li className="report-row" key={report.id}>
                <div className="report-meta">
                  <strong className="row-title">
                    {report.targetType === "message"
                      ? t("moderation.reports.targetMessage")
                      : `${t("moderation.reports.targetUser")}: ${nameFor(report.targetId)}`}
                  </strong>
                  <span className="row-meta">
                    {t("moderation.reports.reasonLine", {
                      reason: t(`report.reason.${report.reason}` as Parameters<typeof t>[0]),
                    })}
                    {" · "}
                    {t("moderation.reports.reporter", { name: nameFor(report.reporterUserId) })}
                  </span>
                  {report.note ? (
                    <p className="report-note" dir="auto">
                      {report.note}
                    </p>
                  ) : null}
                </div>
                <div className="row-actions">
                  {report.targetType === "message" ? (
                    <button
                      className="btn btn-danger btn-sm"
                      disabled={busy}
                      onClick={() => void act(report, () => removeMessage(report.targetId), "message_removed")}
                      type="button"
                    >
                      {t("moderation.reports.removeMessage")}
                    </button>
                  ) : (
                    <>
                      <button
                        className="btn btn-secondary btn-sm"
                        disabled={busy}
                        onClick={() =>
                          void act(
                            report,
                            // A duration, not an absolute time: the server derives the expiry from its own clock.
                            () => moderateUser(report.targetId, { timeoutMs: TIMEOUT_DURATION_MS }),
                            "user_timed_out",
                          )
                        }
                        type="button"
                      >
                        {t("moderation.reports.timeoutUser")}
                      </button>
                      <button
                        className="btn btn-danger btn-sm"
                        disabled={busy}
                        onClick={() => setConfirmingBan(report)}
                        type="button"
                      >
                        {t("moderation.reports.banUser")}
                      </button>
                    </>
                  )}
                  <button
                    className="btn btn-secondary btn-sm"
                    disabled={busy}
                    onClick={() => void act(report, () => Promise.resolve(), "escalated")}
                    type="button"
                  >
                    {t("moderation.reports.escalate")}
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    disabled={busy}
                    onClick={() => void act(report, () => Promise.resolve(), "dismissed")}
                    type="button"
                  >
                    {t("moderation.reports.dismiss")}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {confirmingBan ? (
        <ConfirmDialog
          confirmLabel={t("moderation.ban")}
          onCancel={() => setConfirmingBan(undefined)}
          onConfirm={() => {
            const report = confirmingBan;
            setConfirmingBan(undefined);
            void act(report, () => moderateUser(report.targetId, { banned: true }), "user_banned");
          }}
          title={t("moderation.ban")}
        >
          <p>{t("moderation.banConfirm", { name: nameFor(confirmingBan.targetId) })}</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

function ModerationPanel({
  currentUser,
  onUsersChanged,
}: {
  currentUser: User;
  onUsersChanged: (users: User[]) => void;
}) {
  const [people, setPeople] = useState<User[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setLoaded(false);
    setLoadError(undefined);

    fetchJson<unknown>("/api/moderation/users")
      .then((payload) => {
        if (!active) {
          return;
        }

        setPeople(parseUserList(payload));
        setLoaded(true);
      })
      .catch((error: unknown) => {
        if (active) {
          setLoadError(error instanceof Error ? error.message : t("moderation.loadError"));
        }
      });

    return () => {
      active = false;
    };
  }, [reloadKey]);

  /** Merge an updated user into the roster (preserving order) and the app-wide roster in one step. */
  const applyUser = useCallback(
    (user: User) => {
      setPeople((previous) => {
        const next = new Map(previous.map((entry) => [entry.id, entry]));
        next.set(user.id, user);
        return Array.from(next.values());
      });
      onUsersChanged([user]);
    },
    [onUsersChanged],
  );

  return (
    <>
      <ReportQueue onApplyUser={applyUser} people={people} />
      <div className="card">
        <CardHeader
          actions={<RefreshButton onClick={() => setReloadKey((key) => key + 1)} />}
          title={t("moderation.heading")}
        />
        {loadError ? <p className="notice notice-danger">{loadError}</p> : null}
        {!loaded && !loadError ? <p className="form-note">{t("moderation.loading")}</p> : null}
        {loaded && people.length === 0 ? <p className="empty-note">{t("moderation.empty")}</p> : null}
        {people.length > 0 ? (
          <ul className="list">
            {people.map((user) => (
              <ModerationUserRow currentUser={currentUser} key={user.id} onApply={applyUser} user={user} />
            ))}
          </ul>
        ) : null}
      </div>
    </>
  );
}

/**
 * One roster row. Shows the person's identity and state badges; when the target is neither an admin
 * nor yourself, exposes role checkboxes (admins only) and ban / shadow-ban toggles.
 */
function ModerationUserRow({
  currentUser,
  onApply,
  user,
}: {
  currentUser: User;
  onApply: (user: User) => void;
  user: User;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // Which destructive/irreversible action is waiting on its alertdialog: a ban, or the one-way promotion.
  const [confirming, setConfirming] = useState<"ban" | "promote">();
  const protectedTarget = isProtectedTarget(user, currentUser);
  const roles = new Set<Role>(user.roles ?? []);
  // Reactive so the timeout button flips to "time out" the moment the timeout expires (not on next render).
  const timedOut = useIsTimedOut(user);

  async function run(action: () => Promise<User>): Promise<void> {
    setBusy(true);
    setError(undefined);

    try {
      onApply(await action());
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("moderation.updateError"));
    } finally {
      setBusy(false);
    }
  }

  function setRole(role: Role, checked: boolean): void {
    const next = new Set(roles);

    if (checked) {
      next.add(role);
    } else {
      next.delete(role);
    }

    void run(() =>
      requestUser("PATCH", `/api/admin/users/${encodeURIComponent(user.id)}/roles`, {
        roles: Array.from(next),
      }),
    );
  }

  function setModeration(update: {
    banned?: boolean;
    shadowBanned?: boolean;
    timeoutMs?: number;
    timeoutUntil?: null;
  }): void {
    void run(() => requestUser("PATCH", `/api/moderation/users/${encodeURIComponent(user.id)}`, update));
  }

  function promote(): void {
    void run(() => requestUser("POST", `/api/admin/users/${encodeURIComponent(user.id)}/promote`));
  }

  /** Run the action the open alertdialog was confirming, closing it first. */
  function confirmPending(): void {
    const action = confirming;
    setConfirming(undefined);

    if (action === "ban") {
      setModeration({ banned: true });
    } else if (action === "promote") {
      promote();
    }
  }

  return (
    <li className="person-row">
      <div className="person-head">
        <Avatar avatar={user.avatar} id={user.id} size="md" />
        <div className="row-text">
          <strong className="row-title" dir="auto">
            {user.displayName}
          </strong>
          <span className="row-meta">{user.id}</span>
          <UserStateBadges user={user} />
        </div>
      </div>
      {protectedTarget ? (
        <p className="row-meta person-note">
          {user.id === currentUser.id ? t("moderation.thatsYou") : t("moderation.adminsProtected")}
        </p>
      ) : (
        <div className="person-controls">
          {canManageRoles(currentUser) ? (
            <div className="role-toggles">
              <label className="check-row">
                <input
                  checked={roles.has("moderator")}
                  disabled={busy}
                  onInput={(event) => setRole("moderator", event.currentTarget.checked)}
                  type="checkbox"
                />
                {t("moderation.roleModerator")}
              </label>
              <label className="check-row">
                <input
                  checked={roles.has("greeter")}
                  disabled={busy}
                  onInput={(event) => setRole("greeter", event.currentTarget.checked)}
                  type="checkbox"
                />
                {t("moderation.roleGreeter")}
              </label>
            </div>
          ) : null}
          <div className="row-actions">
            <button
              className="btn btn-secondary btn-sm"
              disabled={busy}
              onClick={() => setModeration({ shadowBanned: !user.shadowBanned })}
              type="button"
            >
              {user.shadowBanned ? t("moderation.unshadowban") : t("moderation.shadowban")}
            </button>
            {timedOut ? (
              <button
                className="btn btn-secondary btn-sm"
                disabled={busy}
                onClick={() => setModeration({ timeoutUntil: null })}
                type="button"
              >
                {t("moderation.timeoutClear")}
              </button>
            ) : (
              <button
                className="btn btn-secondary btn-sm"
                disabled={busy}
                onClick={() => setModeration({ timeoutMs: TIMEOUT_DURATION_MS })}
                type="button"
              >
                {t("moderation.timeout")}
              </button>
            )}
            {user.banned ? (
              <button
                className="btn btn-secondary btn-sm"
                disabled={busy}
                onClick={() => setModeration({ banned: false })}
                type="button"
              >
                {t("moderation.unban")}
              </button>
            ) : (
              <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => setConfirming("ban")} type="button">
                {t("moderation.ban")}
              </button>
            )}
            {/* Promotion is admin-only and one-way (no demote — see the server route). Offered
                only for a non-banned, non-pending member so the new admin is immediately usable. */}
            {canManageRoles(currentUser) && !user.banned && !user.pending ? (
              <button
                className="btn btn-ghost btn-sm"
                disabled={busy}
                onClick={() => setConfirming("promote")}
                type="button"
              >
                {t("moderation.makeAdmin")}
              </button>
            ) : null}
          </div>
        </div>
      )}
      {error ? <p className="form-error">{error}</p> : null}
      {confirming ? (
        <ConfirmDialog
          confirmLabel={confirming === "ban" ? t("moderation.ban") : t("moderation.makeAdmin")}
          danger={confirming === "ban"}
          onCancel={() => setConfirming(undefined)}
          onConfirm={confirmPending}
          title={confirming === "ban" ? t("moderation.ban") : t("moderation.makeAdmin")}
        >
          <p>
            {confirming === "ban"
              ? t("moderation.banConfirm", { name: user.displayName })
              : t("moderation.promoteConfirm", { name: user.displayName })}
          </p>
        </ConfirmDialog>
      ) : null}
    </li>
  );
}

/**
 * Compact state badges (admin / roles / pending / banned / shadow-banned) for a roster row.
 */
function UserStateBadges({ user }: { user: User }) {
  const badges: { key: string; label: string; className: string }[] = [];
  // Reactive so a "timed out" badge clears itself when the timeout expires.
  const timedOut = useIsTimedOut(user);

  if (user.isAdmin) {
    badges.push({ key: "admin", label: t("moderation.badgeAdmin"), className: "badge-primary" });
  }

  for (const role of user.roles ?? []) {
    badges.push({
      key: `role-${role}`,
      label: role === "moderator" ? t("moderation.roleModerator") : t("moderation.roleGreeter"),
      className: "",
    });
  }

  if (user.pending) {
    badges.push({ key: "pending", label: t("moderation.badgePending"), className: "badge-accent" });
  }

  if (user.banned) {
    badges.push({ key: "banned", label: t("moderation.badgeBanned"), className: "badge-danger" });
  }

  if (user.shadowBanned) {
    badges.push({ key: "shadow", label: t("moderation.badgeShadow"), className: "badge-danger" });
  }

  if (timedOut) {
    badges.push({ key: "timeout", label: t("moderation.timedOutBadge"), className: "badge-danger" });
  }

  if (!badges.length) {
    return null;
  }

  return (
    <span className="state-badges">
      {badges.map((badge) => (
        <span className={badge.className ? `badge ${badge.className}` : "badge"} key={badge.key}>
          {badge.label}
        </span>
      ))}
    </span>
  );
}
