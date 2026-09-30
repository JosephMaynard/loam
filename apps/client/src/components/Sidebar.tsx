import type { Channel, User } from "@loam/schema";
import { useState } from "preact/hooks";

import loamMark from "../assets/loam.svg";
import { t } from "../i18n";
import { canGreet, canModerate } from "../lib/capabilities";
import type { Conversation } from "../lib/protocol";
import { joinQrUrl } from "../lib/transport";
import { Avatar } from "./Avatar";
import { IconHash, IconLock, IconMail, IconPlus, IconSearch, IconSettings, IconShield, IconUsers } from "./icons";
import { InviteControl } from "./InviteControl";
import { NavLink } from "./NavLink";
import { NewMessageControl } from "./NewMessageControl";
import { UnreadBadge } from "./UnreadBadge";

interface SidebarProps {
  activeConversation?: Conversation;
  /** The open non-conversation screen (settings, search, people, mesh, admin), to mark its row active. */
  activeScreen?: string;
  canCreateChannel: boolean;
  canCreatePrivateChannel: boolean;
  channels: Channel[];
  connection: "connecting" | "live" | "offline";
  currentUser: User;
  /**
   * What the invite QR may carry (see `inviteQrHostKey` in lib/transport): `key` is this client's own
   * QR-verified host key (absent → the QR is the plain join URL); `suppressed` withholds the QR because the
   * node's advertised key contradicts this client's pin. Never the unauthenticated advertised key.
   */
  inviteQr?: { key?: string; suppressed: boolean };
  joinUrl?: string;
  nodeName?: string;
  onCreateChannel: (name: string, visibility?: "public" | "private") => Promise<boolean>;
  /** The people listed under Direct Messages, in order (see `dmConversationPeers`). */
  dmPeers: User[];
  /** DM partners with something new that isn't loaded yet: a dot instead of a count. */
  dmUnreadHints: ReadonlySet<string>;
  onlineUserIds: ReadonlySet<string>;
  showMesh: boolean;
  unreadByConversation: Map<string, number>;
  users: User[];
}

/** The translated connection state, for the status line under the node name. */
function connectionLabel(connection: SidebarProps["connection"]): string {
  return connection === "live"
    ? t("sidebar.statusLive")
    : connection === "offline"
      ? t("sidebar.statusOffline")
      : t("sidebar.statusConnecting");
}

/** A conversation row's classes: active marks the open one; `has-unread` bolds its name. */
function rowClass(active: boolean, unread: number): string {
  return ["nav-link", active ? "active" : undefined, unread > 0 ? "has-unread" : undefined].filter(Boolean).join(" ");
}

/**
 * The conversation list: the sidebar from tablet width up, and the whole Home ("Chats") screen on phones.
 *
 * Top: an app bar with the LOAM mark, the node name, a connection dot, and search/settings icon buttons.
 * Middle (scrolls): Channels, Direct Messages, then the tools this user may open (invite, people, mesh,
 * admin). Bottom: who you are, with a settings shortcut. Rows are `NavLink`s with a 28px glyph or avatar,
 * a one-line label and an unread badge; the active row gets a tinted background and an accent bar.
 *
 * @param activeConversation - The currently selected conversation (marks its channel or DM row active).
 * @param channels - Channels to list (pinned first, archived last).
 * @param connection - Connection state shown by the status dot.
 * @param currentUser - The signed-in user (footer identity; gates the invite/people/admin rows).
 * @param dmPeers - Who is listed under Direct Messages (real conversations, newest first).
 * @param users - All known users, offered by "New message".
 * @returns The sidebar element.
 */
export function Sidebar({
  activeConversation,
  activeScreen,
  canCreateChannel,
  canCreatePrivateChannel,
  channels,
  connection,
  currentUser,
  dmPeers,
  dmUnreadHints,
  inviteQr,
  joinUrl,
  nodeName,
  onCreateChannel,
  onlineUserIds,
  showMesh,
  unreadByConversation,
  users,
}: SidebarProps) {
  const peers = users.filter((user) => user.id !== currentUser.id);
  const showPeople = canModerate(currentUser) || canGreet(currentUser);
  const showInvite = canGreet(currentUser) && !!joinUrl;
  // Encode this client's VERIFIED host key into the invite QR (docs/08) so a scanner learns it out-of-band
  // → MITM-resistant handshake; the displayed URL text (inside InviteControl) stays plain.
  const inviteQrUrl = joinUrl && !inviteQr?.suppressed ? joinQrUrl(joinUrl, inviteQr?.key) : undefined;
  const status = connectionLabel(connection);

  return (
    <aside className="sidebar">
      <header className="sidebar-header">
        <img src={loamMark} alt="" className="brand-mark" />
        <div className="sidebar-heading">
          {/* The operator-chosen network name is the headline; LOAM stays as the mark. */}
          <p className="brand-title" title={nodeName}>
            {nodeName ?? "LOAM"}
          </p>
          <p className={`status-pill status-${connection}`}>
            <span aria-hidden="true" className="status-dot" />
            {status}
          </p>
        </div>
        <div className="sidebar-header-actions">
          <NavLink
            active={activeScreen === "search"}
            ariaLabel={t("sidebar.searchMessages")}
            className={activeScreen === "search" ? "btn btn-icon btn-ghost is-active" : "btn btn-icon btn-ghost"}
            href="/search"
          >
            <IconSearch />
          </NavLink>
          <NavLink
            active={activeScreen === "settings"}
            ariaLabel={t("sidebar.settings")}
            className="btn btn-icon btn-ghost only-mobile"
            href="/settings"
          >
            <IconSettings />
          </NavLink>
        </div>
      </header>

      <div className="sidebar-scroll">
        <section className="nav-section">
          <h2 className="nav-heading">{t("sidebar.channels")}</h2>
          <nav aria-label={t("sidebar.channels")}>
            {/* Pinned channels sort to the top (P13); archived (read-only) sink to the bottom; stable
                otherwise so the existing order is preserved. */}
            {[...channels]
              .sort((a, b) => Number(!!a.archived) - Number(!!b.archived) || Number(!!b.pinned) - Number(!!a.pinned))
              .map((channel) => {
                const active = activeConversation?.kind === "channel" && activeConversation.id === channel.id;
                const unread = channel.archived ? 0 : (unreadByConversation.get(`channel:${channel.id}`) ?? 0);
                return (
                  <NavLink
                    active={active}
                    className={rowClass(active, unread)}
                    href={`/channel/${encodeURIComponent(channel.id)}`}
                    key={channel.id}
                  >
                    {channel.visibility === "private" ? (
                      <span aria-label={t("members.eyebrow")} className="nav-glyph" role="img">
                        <IconLock size={18} />
                      </span>
                    ) : (
                      <span aria-hidden="true" className="nav-glyph">
                        <IconHash size={18} />
                      </span>
                    )}
                    <span className={channel.archived ? "nav-label archived-channel" : "nav-label"}>
                      {channel.name}
                    </span>
                    {channel.archived ? (
                      <span className="archived-tag" title={t("sidebar.archivedTag")}>
                        {t("sidebar.archivedTag")}
                      </span>
                    ) : (
                      <UnreadBadge count={unread} />
                    )}
                  </NavLink>
                );
              })}
          </nav>
          {canCreateChannel ? (
            <NewChannelControl allowPrivate={canCreatePrivateChannel} onCreateChannel={onCreateChannel} />
          ) : null}
        </section>

        {peers.length ? (
          <section className="nav-section">
            <h2 className="nav-heading">{t("sidebar.dms")}</h2>
            <nav aria-label={t("sidebar.dms")}>
              {dmPeers.map((user) => {
                const active = activeConversation?.kind === "dm" && activeConversation.id === user.id;
                const unread = unreadByConversation.get(`dm:${user.id}`) ?? 0;
                return (
                  <NavLink
                    active={active}
                    className={rowClass(active, unread)}
                    href={`/dm/${encodeURIComponent(user.id)}`}
                    key={user.id}
                  >
                    <Avatar
                      avatar={user.avatar}
                      id={user.id}
                      presence={onlineUserIds.has(user.id) ? "online" : undefined}
                      size="sm"
                    />
                    <span className="nav-label">{user.displayName}</span>
                    <UnreadBadge count={unread} dot={dmUnreadHints.has(user.id)} />
                  </NavLink>
                );
              })}
            </nav>
            <NewMessageControl onlineUserIds={onlineUserIds} people={peers} />
          </section>
        ) : null}

        {showInvite || showPeople || showMesh || currentUser.isAdmin ? (
          <section className="nav-section nav-tools">
            {showInvite ? (
              <InviteControl joinUrl={joinUrl} qrSuppressed={!!inviteQr?.suppressed} qrUrl={inviteQrUrl} />
            ) : null}
            {showPeople ? (
              <NavLink active={activeScreen === "people"} href="/people">
                <span aria-hidden="true" className="nav-glyph">
                  <IconUsers size={18} />
                </span>
                <span className="nav-label">{t("people.title")}</span>
              </NavLink>
            ) : null}
            {showMesh ? (
              <NavLink active={activeScreen === "mesh"} href="/mesh">
                <span aria-hidden="true" className="nav-glyph">
                  <IconMail size={18} />
                </span>
                <span className="nav-label">{t("sidebar.meshMail")}</span>
              </NavLink>
            ) : null}
            {currentUser.isAdmin ? (
              <NavLink active={activeScreen === "admin"} href="/admin">
                <span aria-hidden="true" className="nav-glyph">
                  <IconShield size={18} />
                </span>
                <span className="nav-label">{t("admin.eyebrow")}</span>
              </NavLink>
            ) : null}
          </section>
        ) : null}
      </div>

      <footer className="sidebar-footer">
        <div className="current-user">
          <Avatar avatar={currentUser.avatar} id={currentUser.id} size="md" />
          <div className="current-user-text">
            <strong>{currentUser.displayName}</strong>
          </div>
        </div>
        <NavLink
          active={activeScreen === "settings"}
          ariaLabel={t("sidebar.settings")}
          className={
            activeScreen === "settings"
              ? "btn btn-icon btn-ghost only-desktop is-active"
              : "btn btn-icon btn-ghost only-desktop"
          }
          href="/settings"
        >
          <IconSettings />
        </NavLink>
      </footer>
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
      <button className="nav-link new-channel-toggle" onClick={() => setOpen(true)} type="button">
        <span aria-hidden="true" className="nav-glyph">
          <IconPlus size={18} />
        </span>
        {/* Older catalogs spell the label "+ New channel"; the icon is the plus now. */}
        <span className="nav-label">{t("newChannel.new").replace(/^\s*\+\s*/, "")}</span>
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
        className="input"
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        disabled={creating}
        maxLength={80}
        onInput={(event) => setName(event.currentTarget.value)}
        placeholder={t("newChannel.namePlaceholder")}
        value={name}
      />
      {allowPrivate ? (
        <label className="check-row">
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
        <button className="btn btn-primary btn-sm" disabled={creating || !name.trim()} type="submit">
          {creating ? t("admin.creating") : t("newChannel.create")}
        </button>
        <button
          className="btn btn-ghost btn-sm"
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
