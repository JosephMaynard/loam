import type { Channel, User } from "@loam/schema";
import { useEffect, useState } from "preact/hooks";

import { errorText, t } from "../i18n";
import { fetchJson, parseUserList, requestChannel, requestJson, REQUEST_TIMEOUT_MS } from "../lib/api";
import { encryptedFetch } from "../lib/transport";
import { Avatar } from "./Avatar";
import { ConfirmDialog } from "./ConfirmDialog";

interface ChannelMembersPanelProps {
  channel: Channel;
  currentUser: User;
  onChannelUpsert: (channels: Channel[]) => void;
  onLeftChannel: (channelId: string) => void;
  users: User[];
}

/**
 * The Members panel for a private channel: lists the roster, lets the owner/admin invite people,
 * transfer ownership, and remove members (self-remove = leave). Fetches its own roster and re-fetches
 * whenever the membership set changes. The server enforces every action; this is the UI surface.
 * `ConversationView` shows it inside a `Dialog` (a sheet on phones), which supplies the heading.
 */
export function ChannelMembersPanel({
  channel,
  currentUser,
  onChannelUpsert,
  onLeftChannel,
  users,
}: ChannelMembersPanelProps) {
  const [members, setMembers] = useState<User[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [inviteId, setInviteId] = useState("");
  const [joinRequests, setJoinRequests] = useState<User[]>([]);
  // Handing over ownership and leaving both interrupt with a ConfirmDialog (alertdialog), like every other
  // consequential action in the app: the member a transfer is pending for, and whether leaving is.
  const [pendingTransferId, setPendingTransferId] = useState<string>();
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  const canManage = currentUser.isAdmin || channel.ownerUserId === currentUser.id;
  // Roster GROWTH (invite / transfer / approve requests / the join-request toggle) is frozen while
  // the channel is archived — the server 403s these; removals and leaving stay available.
  const canGrow = canManage && !channel.archived;
  const memberIds = new Set(channel.memberUserIds ?? []);

  if (channel.ownerUserId) {
    memberIds.add(channel.ownerUserId);
  }

  const invitable = users.filter((user) => user.type === "human" && !memberIds.has(user.id));
  // Refetch whenever the roster itself changes (live channelUpserted events update the channel).
  const rosterKey = [...memberIds].sort().join(",");

  useEffect(() => {
    let active = true;
    setLoaded(false);
    setError(undefined);

    fetchJson<unknown>(`/api/channels/${encodeURIComponent(channel.id)}/members`)
      .then((payload) => {
        if (active) {
          setMembers(parseUserList(payload));
          setLoaded(true);
        }
      })
      .catch((loadError: unknown) => {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : t("members.loadError"));
        }
      });

    return () => {
      active = false;
    };
  }, [channel.id, rosterKey]);

  // Pending join requests (owner/admin only, and only when the channel opted in). Re-fetched when the
  // roster changes (an approval adds a member) or the opt-in toggles.
  useEffect(() => {
    if (!canManage || !channel.allowJoinRequests) {
      setJoinRequests([]);
      return;
    }
    let active = true;
    fetchJson<unknown>(`/api/channels/${encodeURIComponent(channel.id)}/join-requests`)
      .then((payload) => {
        if (active) {
          setJoinRequests(parseUserList(payload));
        }
      })
      .catch((loadError: unknown) => {
        if (active) {
          setJoinRequests([]);
          setError(loadError instanceof Error ? loadError.message : t("members.loadError"));
        }
      });
    return () => {
      active = false;
    };
  }, [channel.id, channel.allowJoinRequests, canManage, rosterKey]);

  async function toggleJoinRequests(): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      const updated = await requestChannel("PATCH", `/api/channels/${encodeURIComponent(channel.id)}`, {
        allowJoinRequests: !channel.allowJoinRequests,
      });
      onChannelUpsert([updated]);
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : t("members.updateError"));
    } finally {
      setBusy(false);
    }
  }

  async function approveRequest(userId: string): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      const updated = await requestChannel(
        "POST",
        `/api/channels/${encodeURIComponent(channel.id)}/join-requests/${encodeURIComponent(userId)}/approve`,
        {},
      );
      onChannelUpsert([updated]);
      setJoinRequests((previous) => previous.filter((user) => user.id !== userId));
    } catch (approveError) {
      setError(approveError instanceof Error ? approveError.message : t("members.approveError"));
    } finally {
      setBusy(false);
    }
  }

  async function denyRequest(userId: string): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await requestJson("DELETE", `/api/channels/${encodeURIComponent(channel.id)}/join-requests/${encodeURIComponent(userId)}`);
      setJoinRequests((previous) => previous.filter((user) => user.id !== userId));
    } catch (denyError) {
      setError(denyError instanceof Error ? denyError.message : t("members.denyError"));
    } finally {
      setBusy(false);
    }
  }

  async function invite(): Promise<void> {
    if (!inviteId) {
      return;
    }

    setBusy(true);
    setError(undefined);

    try {
      const updated = await requestChannel(
        "POST",
        `/api/channels/${encodeURIComponent(channel.id)}/members`,
        { userId: inviteId },
      );
      onChannelUpsert([updated]);
      setInviteId("");
    } catch (inviteError) {
      setError(inviteError instanceof Error ? inviteError.message : t("members.inviteError"));
    } finally {
      setBusy(false);
    }
  }

  /** Hand ownership to `userId`; called once the ConfirmDialog has been accepted. */
  async function transfer(userId: string): Promise<void> {
    setBusy(true);
    setError(undefined);

    try {
      const updated = await requestChannel(
        "POST",
        `/api/channels/${encodeURIComponent(channel.id)}/transfer`,
        { userId },
      );
      onChannelUpsert([updated]);
    } catch (transferError) {
      setError(transferError instanceof Error ? transferError.message : t("members.transferError"));
    } finally {
      setBusy(false);
    }
  }

  /** Remove `userId` from the roster (yourself = leave, which the ConfirmDialog has confirmed by now). */
  async function remove(userId: string): Promise<void> {
    const leaving = userId === currentUser.id;

    setBusy(true);
    setError(undefined);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await encryptedFetch(
        "DELETE",
        `/api/channels/${encodeURIComponent(channel.id)}/members/${encodeURIComponent(userId)}`,
        undefined,
        { signal: controller.signal },
      );

      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => undefined);
        const message = errorText(payload, t("common.requestFailed", { status: response.status }));
        throw new Error(message);
      }

      if (leaving) {
        onLeftChannel(channel.id);
        return;
      }

      onChannelUpsert([
        { ...channel, memberUserIds: (channel.memberUserIds ?? []).filter((id) => id !== userId) },
      ]);
      setMembers((previous) => previous.filter((member) => member.id !== userId));
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : t("members.removeError"));
    } finally {
      window.clearTimeout(timeout);
      setBusy(false);
    }
  }

  const canLeave = memberIds.has(currentUser.id) && channel.ownerUserId !== currentUser.id;

  return (
    <div className="members-panel">
      {!loaded && !error ? <p className="form-note">{t("members.loading")}</p> : null}
      {loaded ? (
        <ul className="list member-list">
          {members.map((member) => (
            <li className="list-row member-row" key={member.id}>
              <Avatar avatar={member.avatar} id={member.id} size="md" />
              <div className="member-name">
                <strong dir="auto">{member.displayName}</strong>
                {member.id === channel.ownerUserId ? (
                  <span className="badge badge-primary">{t("members.owner")}</span>
                ) : (
                  <span className="member-id">{member.id}</span>
                )}
              </div>
              {canManage && member.id !== channel.ownerUserId ? (
                <div className="member-actions">
                  {canGrow ? (
                    <button
                      className="btn btn-secondary btn-sm member-transfer"
                      disabled={busy}
                      onClick={() => setPendingTransferId(member.id)}
                      type="button"
                    >
                      {t("members.makeOwner")}
                    </button>
                  ) : null}
                  <button
                    className="btn btn-secondary btn-sm member-remove"
                    disabled={busy}
                    onClick={() => void remove(member.id)}
                    type="button"
                  >
                    {t("common.remove")}
                  </button>
                </div>
              ) : (
                <span />
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {canGrow ? (
        <label className="check-row">
          <input
            checked={!!channel.allowJoinRequests}
            className="toggle"
            disabled={busy}
            onInput={() => void toggleJoinRequests()}
            type="checkbox"
          />
          <span>{t("members.allowJoinRequests")}</span>
        </label>
      ) : null}
      {canGrow && joinRequests.length ? (
        <section className="members-section">
          <h3 className="members-section-title">{t("members.joinRequestsHeading")}</h3>
          <ul className="list member-list">
            {joinRequests.map((requester) => (
              <li className="list-row member-row" key={requester.id}>
                <Avatar avatar={requester.avatar} id={requester.id} size="md" />
                <div className="member-name">
                  <strong dir="auto">{requester.displayName}</strong>
                  <span className="member-id">{requester.id}</span>
                </div>
                <div className="member-actions">
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={busy}
                    onClick={() => void approveRequest(requester.id)}
                    type="button"
                  >
                    {t("members.approve")}
                  </button>
                  <button
                    className="btn btn-secondary btn-sm"
                    disabled={busy}
                    onClick={() => void denyRequest(requester.id)}
                    type="button"
                  >
                    {t("members.deny")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {canGrow ? (
        <form
          className="member-invite-form"
          onSubmit={(event) => {
            event.preventDefault();
            void invite();
          }}
        >
          <label className="field">
            <span className="field-label">{t("members.inviteLabel")}</span>
            <select
              className="select"
              disabled={busy || !invitable.length}
              onInput={(event) => setInviteId(event.currentTarget.value)}
              value={inviteId}
            >
              <option value="">{invitable.length ? t("members.choosePerson") : t("members.allMembers")}</option>
              {invitable.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.displayName}
                </option>
              ))}
            </select>
          </label>
          <button className="btn btn-primary" disabled={busy || !inviteId} type="submit">
            {t("members.invite")}
          </button>
        </form>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {canLeave ? (
        <button
          className="btn btn-danger btn-block members-leave"
          disabled={busy}
          onClick={() => setConfirmingLeave(true)}
          type="button"
        >
          {t("members.leave")}
        </button>
      ) : null}
      {pendingTransferId !== undefined ? (
        <ConfirmDialog
          confirmLabel={t("members.makeOwner")}
          onCancel={() => setPendingTransferId(undefined)}
          onConfirm={() => {
            const userId = pendingTransferId;
            setPendingTransferId(undefined);
            void transfer(userId);
          }}
          title={t("members.makeOwner")}
        >
          <p>{t("members.transferConfirm")}</p>
        </ConfirmDialog>
      ) : null}
      {confirmingLeave ? (
        <ConfirmDialog
          confirmLabel={t("members.leave")}
          onCancel={() => setConfirmingLeave(false)}
          onConfirm={() => {
            setConfirmingLeave(false);
            void remove(currentUser.id);
          }}
          title={t("members.leave")}
        >
          <p>{t("members.leaveConfirm")}</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
