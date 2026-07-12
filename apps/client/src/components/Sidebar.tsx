import type { Channel, User } from "@loam/schema";
import { useState } from "preact/hooks";

import loamMark from "../assets/loam.svg";
import { t } from "../i18n";
import { canGreet, canModerate } from "../lib/capabilities";
import type { Conversation } from "../lib/protocol";
import { joinQrUrl } from "../lib/transport";
import { Avatar } from "./Avatar";
import { InviteControl } from "./InviteControl";
import { NavLink } from "./NavLink";
import { UnreadBadge } from "./UnreadBadge";

interface SidebarProps {
  activeConversation?: Conversation;
  canCreateChannel: boolean;
  canCreatePrivateChannel: boolean;
  channels: Channel[];
  connection: "connecting" | "live" | "offline";
  currentUser: User;
  joinUrl?: string;
  nodeName?: string;
  onCreateChannel: (name: string, visibility?: "public" | "private") => Promise<boolean>;
  onlineUserIds: ReadonlySet<string>;
  showMesh: boolean;
  transportPublicKey?: string;
  unreadByConversation: Map<string, number>;
  users: User[];
}

/**
 * Render the application sidebar with channels, direct-message peers, connection status, and current user info.
 *
 * @param activeConversation - The currently selected conversation (used to mark the active channel or DM).
 * @param channels - List of channels to display in the Channels section.
 * @param connection - Current connection status string (used to display the status pill).
 * @param currentUser - The currently signed-in user (used for the footer identity display).
 * @param users - All known users; peers (other users) are shown in the Direct Messages section.
 * @returns The sidebar element containing navigation links for channels, direct messages, settings, and a current-user panel.
 */
export function Sidebar({
  activeConversation,
  canCreateChannel,
  canCreatePrivateChannel,
  channels,
  connection,
  currentUser,
  joinUrl,
  nodeName,
  onCreateChannel,
  onlineUserIds,
  showMesh,
  transportPublicKey,
  unreadByConversation,
  users,
}: SidebarProps) {
  const peers = users.filter((user) => user.id !== currentUser.id);
  const showPeople = canModerate(currentUser) || canGreet(currentUser);
  // Encode the host's transport public key into the invite QR (docs/08) so a scanner learns it
  // out-of-band → MITM-resistant handshake; the displayed URL text (inside InviteControl) stays plain.
  const inviteQrUrl = joinUrl ? joinQrUrl(joinUrl, transportPublicKey) : undefined;

  return (
    <aside className="sidebar">
      <div className="brand-row">
        <img src={loamMark} alt="" className="brand-mark" />
        <div>
          {/* The operator-chosen network name is the headline; LOAM stays as the mark. */}
          <p className="brand-title" title={nodeName}>
            {nodeName ?? "LOAM"}
          </p>
          <p className={`status-pill status-${connection}`}>
            {connection === "live"
              ? t("sidebar.statusLive")
              : connection === "offline"
                ? t("sidebar.statusOffline")
                : t("sidebar.statusConnecting")}
          </p>
        </div>
      </div>

      <section className="nav-section">
        <h2>{t("sidebar.channels")}</h2>
        <nav aria-label={t("sidebar.channels")}>
          {channels.map((channel) => (
            <NavLink
              active={activeConversation?.kind === "channel" && activeConversation.id === channel.id}
              href={`/channel/${encodeURIComponent(channel.id)}`}
              key={channel.id}
            >
              <span aria-label={channel.visibility === "private" ? t("members.eyebrow") : undefined} className="nav-glyph">
                {channel.visibility === "private" ? "🔒" : "#"}
              </span>
              <span className="nav-label">{channel.name}</span>
              <UnreadBadge count={unreadByConversation.get(`channel:${channel.id}`) ?? 0} />
            </NavLink>
          ))}
        </nav>
        {canCreateChannel ? (
          <NewChannelControl allowPrivate={canCreatePrivateChannel} onCreateChannel={onCreateChannel} />
        ) : null}
      </section>

      <section className="nav-section">
        <h2>{t("sidebar.dms")}</h2>
        <nav aria-label={t("sidebar.dms")}>
          {peers.map((user) => (
            <NavLink
              active={activeConversation?.kind === "dm" && activeConversation.id === user.id}
              href={`/dm/${encodeURIComponent(user.id)}`}
              key={user.id}
            >
              <span className="presence-anchor">
                <Avatar avatar={user.avatar} id={user.id} />
                {onlineUserIds.has(user.id) ? (
                  <span aria-label={t("sidebar.online")} className="presence-dot" title={t("sidebar.online")} />
                ) : null}
              </span>
              <span className="nav-label">{user.displayName}</span>
              <UnreadBadge count={unreadByConversation.get(`dm:${user.id}`) ?? 0} />
            </NavLink>
          ))}
        </nav>
      </section>

      <div className="sidebar-footer">
        <NavLink active={false} href="/search">
          <span className="nav-glyph">⌕</span>
          {t("sidebar.searchMessages")}
        </NavLink>
        {canGreet(currentUser) ? <InviteControl joinUrl={joinUrl} qrUrl={inviteQrUrl} /> : null}
        {showPeople ? (
          <NavLink active={false} href="/people">
            <span className="nav-glyph">☺</span>
            {t("people.title")}
          </NavLink>
        ) : null}
        {showMesh ? (
          <NavLink active={false} href="/mesh">
            <span className="nav-glyph">✉</span>
            {t("sidebar.meshMail")}
          </NavLink>
        ) : null}
        {currentUser.isAdmin ? (
          <NavLink active={false} href="/admin">
            <span className="nav-glyph">⚙</span>
            {t("admin.eyebrow")}
          </NavLink>
        ) : null}
        <NavLink active={false} href="/settings">
          <span className="nav-glyph">⌁</span>
          {t("sidebar.settings")}
        </NavLink>
        <div className="current-user">
          <Avatar avatar={currentUser.avatar} id={currentUser.id} />
          <div>
            <strong>{currentUser.displayName}</strong>
            <span>{currentUser.id}</span>
          </div>
        </div>
      </div>
    </aside>
  );
}

/**
 * A compact "new channel" affordance in the sidebar. Shown to admins, and to everyone when the
 * `enableUserChannels` flag is on. Collapses to a single button until the user starts creating.
 * When the node allows private channels, offers an invite-only toggle (the creator starts as the
 * only member and invites people from the channel's Members panel).
 */
function NewChannelControl({
  allowPrivate,
  onCreateChannel,
}: {
  allowPrivate: boolean;
  onCreateChannel: (name: string, visibility?: "public" | "private") => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [creating, setCreating] = useState(false);

  async function create(): Promise<void> {
    if (!name.trim()) {
      return;
    }

    setCreating(true);
    const ok = await onCreateChannel(name, isPrivate ? "private" : "public");
    setCreating(false);

    if (ok) {
      setName("");
      setIsPrivate(false);
      setOpen(false);
    }
  }

  if (!open) {
    return (
      <button className="new-channel-toggle" onClick={() => setOpen(true)} type="button">
        {t("newChannel.new")}
      </button>
    );
  }

  return (
    <form
      className="new-channel-form"
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <input
        aria-label={t("newChannel.nameAria")}
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        disabled={creating}
        maxLength={80}
        onInput={(event) => setName(event.currentTarget.value)}
        placeholder={t("newChannel.namePlaceholder")}
        value={name}
      />
      {allowPrivate ? (
        <label className="admin-toggle">
          <input
            checked={isPrivate}
            disabled={creating}
            onInput={(event) => setIsPrivate(event.currentTarget.checked)}
            type="checkbox"
          />
          {t("newChannel.private")}
        </label>
      ) : null}
      <div className="new-channel-actions">
        <button disabled={creating || !name.trim()} type="submit">
          {creating ? t("admin.creating") : t("newChannel.create")}
        </button>
        <button
          disabled={creating}
          onClick={() => {
            setOpen(false);
            setName("");
          }}
          type="button"
        >
          {t("common.cancel")}
        </button>
      </div>
    </form>
  );
}
