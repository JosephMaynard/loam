import type { Channel, User } from "@loam/schema";
import { useEffect, useState } from "preact/hooks";

import { errorText, t } from "../i18n";
import { fetchJson, parseUserList, requestChannel, requestJson, REQUEST_TIMEOUT_MS } from "../lib/api";
import { encryptedFetch } from "../lib/transport";
import { Avatar } from "./Avatar";

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
  const canManage = currentUser.isAdmin || channel.ownerUserId === currentUser.id;
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
      .catch(() => {});
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

  async function transfer(userId: string): Promise<void> {
    if (!window.confirm(t("members.transferConfirm"))) {
      return;
    }

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

  async function remove(userId: string): Promise<void> {
    const leaving = userId === currentUser.id;

    if (leaving && !window.confirm(t("members.leaveConfirm"))) {
      return;
    }

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

  return (
    <div className="channel-members-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">{t("members.eyebrow")}</p>
          <h2>{t("members.heading")}</h2>
        </div>
        {memberIds.has(currentUser.id) && channel.ownerUserId !== currentUser.id ? (
          <button className="danger-button" disabled={busy} onClick={() => void remove(currentUser.id)} type="button">
            {t("members.leave")}
          </button>
        ) : null}
      </div>
      {!loaded && !error ? <p className="form-note">{t("members.loading")}</p> : null}
      {loaded ? (
        <ul className="moderation-list">
          {members.map((member) => (
            <li className="moderation-row" key={member.id}>
              <div className="moderation-identity">
                <Avatar avatar={member.avatar} id={member.id} />
                <div className="moderation-name">
                  <strong>{member.displayName}</strong>
                  <span>{member.id === channel.ownerUserId ? t("members.owner") : member.id}</span>
                </div>
              </div>
              {canManage && member.id !== channel.ownerUserId ? (
                <div className="moderation-actions">
                  <button className="ghost-button" disabled={busy} onClick={() => void transfer(member.id)} type="button">
                    {t("members.makeOwner")}
                  </button>
                  <button className="danger-button" disabled={busy} onClick={() => void remove(member.id)} type="button">
                    {t("common.remove")}
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {canManage ? (
        <label className="admin-toggle">
          <input
            checked={!!channel.allowJoinRequests}
            disabled={busy}
            onInput={() => void toggleJoinRequests()}
            type="checkbox"
          />
          {t("members.allowJoinRequests")}
        </label>
      ) : null}
      {canManage && joinRequests.length ? (
        <div className="join-requests">
          <h3>{t("members.joinRequestsHeading")}</h3>
          <ul className="moderation-list">
            {joinRequests.map((requester) => (
              <li className="moderation-row" key={requester.id}>
                <div className="moderation-identity">
                  <Avatar avatar={requester.avatar} id={requester.id} />
                  <div className="moderation-name">
                    <strong>{requester.displayName}</strong>
                    <span>{requester.id}</span>
                  </div>
                </div>
                <div className="moderation-actions">
                  <button disabled={busy} onClick={() => void approveRequest(requester.id)} type="button">
                    {t("members.approve")}
                  </button>
                  <button className="danger-button" disabled={busy} onClick={() => void denyRequest(requester.id)} type="button">
                    {t("members.deny")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {canManage ? (
        <form
          className="member-invite-form"
          onSubmit={(event) => {
            event.preventDefault();
            void invite();
          }}
        >
          <label>
            {t("members.inviteLabel")}
            <select disabled={busy || !invitable.length} onInput={(event) => setInviteId(event.currentTarget.value)} value={inviteId}>
              <option value="">{invitable.length ? t("members.choosePerson") : t("members.allMembers")}</option>
              {invitable.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.displayName}
                </option>
              ))}
            </select>
          </label>
          <button disabled={busy || !inviteId} type="submit">
            {t("members.invite")}
          </button>
        </form>
      ) : null}
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}
