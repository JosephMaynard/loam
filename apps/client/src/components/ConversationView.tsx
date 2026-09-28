import type { Channel, Message, MessageAttachment, MessageLocation, User } from "@loam/schema";
import { useLocation } from "preact-iso";
import { useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";

import { t } from "../i18n";
import { withoutBlockedAuthors, withoutBlockedReactions } from "../lib/blocks";
import { dayLabel } from "../lib/dates";
import { groupMessages } from "../lib/message-groups";
import {
  groupReactionsByTarget,
  groupRepliesByParent,
  reactionSummary,
  repliesFor,
  topLevelMessages,
} from "../lib/messages";
import type { Conversation } from "../lib/protocol";
import { useIsTimedOut } from "../lib/timeout";
import { onViewportResize } from "../lib/viewport";
import { Avatar } from "./Avatar";
import { ChannelMembersPanel } from "./ChannelMembersPanel";
import { ConfirmDialog } from "./ConfirmDialog";
import { Dialog } from "./Dialog";
import { IconArrowDown, IconClose, IconFlag, IconHash, IconLock, IconSearch, IconShield, IconUsers } from "./icons";
import type { MenuItem } from "./Menu";
import { MessageComposer } from "./MessageComposer";
import { MessageItem } from "./MessageItem";
import { ReportDialog } from "./ReportDialog";
import { ScreenHeader } from "./ScreenHeader";

/** Shared empty array for grouped-map lookups with no matches, to avoid a fresh allocation per message. */
const EMPTY_MESSAGES: Message[] = [];
/** Shared empty block list (the default when the caller passes none). */
const NO_BLOCKS: ReadonlySet<string> = new Set();
/** Within this many px of the end, a list counts as "at the bottom" and follows new messages. */
const PIN_THRESHOLD_PX = 80;

/** Stable per-conversation identity (`channel:<id>` / `dm:<peerId>`) — a thread is part of its channel. */
export function conversationIdentity(conversation: Conversation): string {
  return `${conversation.kind}:${conversation.id}`;
}

export interface ConversationViewProps {
  allowAttachments: boolean;
  allowLocationSharing: boolean;
  /** Who the current user has blocked (docs/30 B3): their channel content is collapsed, their DM is read-only. */
  blockedUserIds?: ReadonlySet<string>;
  channels: Channel[];
  conversation?: Conversation;
  currentUser: User;
  messages: Message[];
  /** The server said this conversation doesn't exist for this user (unknown, removed, or not a member). */
  notFound?: boolean;
  /** Who is connected (presence events). Shows the online dot and "Online" in a DM header. */
  onlineUserIds?: ReadonlySet<string>;
  onChannelUpsert: (channels: Channel[]) => void;
  onDelete: (messageId: string) => void;
  onEdit: (messageId: string, body: string) => Promise<boolean>;
  onLeftChannel: (channelId: string) => void;
  onReact: (messageId: string, reaction: string) => Promise<void>;
  onSend: (body: string, attachments?: MessageAttachment[], location?: MessageLocation) => Promise<void>;
  /** Block (`true`) or unblock (`false`) a user. Omitted → no block controls. */
  onSetBlocked?: (userId: string, blocked: boolean) => Promise<void>;
  onThreadReply: (
    parentMessageId: string,
    body: string,
    attachments?: MessageAttachment[],
    location?: MessageLocation,
  ) => Promise<void>;
  onTyping: () => void;
  onUploadAttachment: (file: File) => Promise<MessageAttachment>;
  typers: string[];
  users: User[];
  usersById: Map<string, User>;
}

/**
 * The open channel or DM (or the "choose a conversation" empty state).
 *
 * Everything conversation-scoped below this point — the composer's draft text, pending attachments
 * (including uploads still in flight), the location draft, the members panel, report dialogs, the
 * message list's scroll bookkeeping — lives in a subtree KEYED by the conversation, so switching
 * conversations mounts a fresh one (pre-release review 2026-09-25). Before, those survived a route
 * change: a DM draft, a private photo or coordinates typed for one conversation went out into the next
 * one on a single Enter, and an upload finishing after the switch attached itself to the new
 * conversation. An upload that completes after its composer unmounted now lands nowhere.
 */
export function ConversationView(props: ConversationViewProps) {
  const { conversation } = props;

  if (!conversation) {
    return (
      <section className="conversation empty-state">
        <div>
          <h1>{t("conversation.emptyTitle")}</h1>
          <p>{t("conversation.emptyBody")}</p>
        </div>
      </section>
    );
  }

  return <ConversationPane key={conversationIdentity(conversation)} {...props} conversation={conversation} />;
}

function backRouteForThread(conversation: Conversation): string {
  return conversation.kind === "channel"
    ? `/channel/${encodeURIComponent(conversation.id)}`
    : `/dm/${encodeURIComponent(conversation.id)}`;
}

/** The typing line: "Ada is typing…", "Ada and Bo are typing…", or "Several people are typing…". */
function typingText(typers: string[]): string {
  return typers.length === 1
    ? t("typing.one", { name: typers[0]! })
    : typers.length === 2
      ? t("typing.two", { a: typers[0]!, b: typers[1]! })
      : t("typing.many");
}

/** One conversation's pane. Only ever mounted keyed by `conversationIdentity` (see `ConversationView`). */
function ConversationPane({
  allowAttachments,
  allowLocationSharing,
  blockedUserIds = NO_BLOCKS,
  channels,
  conversation,
  currentUser,
  notFound = false,
  onlineUserIds,
  onTyping,
  typers,
  messages,
  onChannelUpsert,
  onDelete,
  onEdit,
  onLeftChannel,
  onReact,
  onSend,
  onSetBlocked,
  onThreadReply,
  onUploadAttachment,
  users,
  usersById,
}: ConversationViewProps & { conversation: Conversation }) {
  const location = useLocation();
  const [membersOpen, setMembersOpen] = useState(false);
  // The user the report dialog was opened for — bound to that id (and, via the key, to this conversation).
  const [reportUserId, setReportUserId] = useState<string>();
  // Blocking interrupts with a ConfirmDialog (alertdialog) rather than window.confirm, like every other
  // consequential action in the app.
  const [blockConfirmOpen, setBlockConfirmOpen] = useState(false);
  const timedOut = useIsTimedOut(currentUser);
  const topMessages = useMemo(() => topLevelMessages(messages, conversation), [conversation, messages]);
  // Grouped once per `messages` change so the render loop below can look up each message's
  // replies/reactions in O(1) instead of rescanning the whole conversation per message (was O(n^2)
  // for a conversation with n messages).
  const repliesByParent = useMemo(() => groupRepliesByParent(messages), [messages]);
  // In a channel, a blocked person's reactions simply don't count (their posts and replies collapse to a
  // placeholder instead — see MessageItem). A DM you blocked someone in stays as it was.
  const hiddenAuthors = conversation.kind === "channel" ? blockedUserIds : NO_BLOCKS;
  const reactionsByTarget = useMemo(
    () => groupReactionsByTarget(withoutBlockedReactions(messages, hiddenAuthors)),
    [hiddenAuthors, messages],
  );
  const threadParent =
    conversation.kind === "channel" && conversation.threadId
      ? topMessages.find((message) => message.id === conversation.threadId)
      : undefined;

  const activeChannel =
    conversation.kind === "channel" ? channels.find((channel) => channel.id === conversation.id) : undefined;
  const isPrivateChannel = activeChannel?.visibility === "private";
  const dmPeer = conversation.kind === "dm" ? usersById.get(conversation.id) : undefined;
  const peerOnline = conversation.kind === "dm" && !!onlineUserIds?.has(conversation.id);
  // Only people can be blocked — not the assistant bot, and not a mesh sender (the server refuses both).
  const canBlockPeer = !!onSetBlocked && dmPeer?.type === "human" && !conversation.id.startsWith("mesh.");
  const dmBlocked = conversation.kind === "dm" && blockedUserIds.has(conversation.id);
  // Archived channels are readable but read-only: the composer (and the thread panel's) disable
  // with an explanation instead of letting a send fail server-side. So does a DM with someone you blocked.
  const composerDisabledReason = activeChannel?.archived
    ? t("composer.archived")
    : dmBlocked
      ? t("block.composerDisabled")
      : timedOut
        ? t("composer.timedOut")
        : undefined;
  const channelName = activeChannel?.name ?? conversation.id;
  const title = conversation.kind === "channel" ? channelName : dmPeer?.displayName ?? conversation.id;
  const memberCount = isPrivateChannel
    ? new Set([...(activeChannel?.memberUserIds ?? []), ...(activeChannel?.ownerUserId ? [activeChannel.ownerUserId] : [])])
        .size
    : 0;

  function confirmBlock(): void {
    if (onSetBlocked) {
      setBlockConfirmOpen(true);
    }
  }

  const leading =
    conversation.kind === "dm" ? (
      <Avatar avatar={dmPeer?.avatar} id={conversation.id} presence={peerOnline ? "online" : undefined} size="md" />
    ) : (
      <span aria-hidden="true" className="channel-glyph">
        {isPrivateChannel ? <IconLock size={18} /> : <IconHash size={18} />}
      </span>
    );
  // A DM's subtitle is the peer's id (their identity; display names are only near-unique), led by
  // "Online" while they're connected. A channel's is its topic.
  const subtitle =
    conversation.kind === "dm" ? (
      <>
        {peerOnline ? <span className="presence-text">{t("sidebar.online")}</span> : null}
        <span className="peer-id">{conversation.id}</span>
      </>
    ) : (
      activeChannel?.description
    );
  const menuItems: MenuItem[] = [
    ...(isPrivateChannel && activeChannel
      ? [{ label: t("conversation.members"), icon: <IconUsers />, onSelect: () => setMembersOpen(true) }]
      : []),
    { label: t("sidebar.searchMessages"), icon: <IconSearch />, onSelect: () => location.route("/search") },
    // The report-a-USER entry point: the one place a person is the subject is their DM. Block sits beside
    // it (Play UGC policy, docs/30 B3); once blocked, the banner below offers Unblock as well.
    ...(conversation.kind === "dm" && dmPeer?.type === "human"
      ? [{ label: t("report.userTitle"), icon: <IconFlag />, onSelect: () => setReportUserId(conversation.id) }]
      : []),
    ...(canBlockPeer
      ? [
          dmBlocked
            ? {
                label: t("block.unblock"),
                icon: <IconShield />,
                onSelect: () => void onSetBlocked?.(conversation.id, false),
              }
            : { label: t("block.block"), icon: <IconShield />, onSelect: confirmBlock, danger: true },
        ]
      : []),
  ];
  const header = (
    <ScreenHeader
      actions={
        isPrivateChannel && activeChannel && !notFound ? (
          <button
            aria-expanded={membersOpen}
            aria-haspopup="dialog"
            className="btn btn-secondary btn-sm members-button"
            onClick={() => setMembersOpen(true)}
            type="button"
          >
            <IconUsers size={18} />
            <span className="members-button-label">{t("conversation.members")}</span>
            <span className="members-button-count">{memberCount}</span>
          </button>
        ) : undefined
      }
      className="conversation-header"
      leading={leading}
      menuItems={notFound ? undefined : menuItems}
      menuLabel={t("conversation.moreActions")}
      subtitle={notFound ? undefined : subtitle}
      title={title}
    />
  );

  if (notFound) {
    return (
      <section className="conversation">
        {header}
        <div className="conversation-not-found" role="status">
          <h2>{t("conversation.notFoundTitle")}</h2>
          <p className="empty-copy">{t("conversation.notFoundBody")}</p>
        </div>
      </section>
    );
  }

  return (
    <>
      <section className="conversation">
        {header}
        {dmBlocked ? (
          <div className="conversation-banner">
            <div className="notice blocked-banner" role="status">
              <span>{t("block.dmBanner")}</span>
              {onSetBlocked ? (
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => void onSetBlocked(conversation.id, false)}
                  type="button"
                >
                  {t("block.unblock")}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
        <MessageList
          blockedUserIds={hiddenAuthors}
          conversation={conversation}
          currentUser={currentUser}
          onDelete={onDelete}
          onEdit={onEdit}
          onOpenThread={(messageId) => {
            if (conversation.kind === "channel") {
              location.route(`/channel/${encodeURIComponent(conversation.id)}/thread/${encodeURIComponent(messageId)}`);
            }
          }}
          onReact={onReact}
          readOnly={!!activeChannel?.archived}
          reactionsByTarget={reactionsByTarget}
          repliesByParent={repliesByParent}
          topMessages={topMessages}
          typers={typers}
          usersById={usersById}
        />
        <MessageComposer
          allowLocationSharing={allowLocationSharing}
          disabledReason={composerDisabledReason}
          label={t("conversation.composerLabel", { name: conversation.kind === "channel" ? `#${channelName}` : title })}
          onSend={onSend}
          onTyping={onTyping}
          onUploadAttachment={allowAttachments ? onUploadAttachment : undefined}
          placeholder={
            conversation.kind === "channel"
              ? t("conversation.composerPlaceholderChannel")
              : t("conversation.composerPlaceholderDm")
          }
        />
      </section>

      {threadParent ? (
        // Keyed by the thread so a reply draft, its attachments and a report dialog never follow the user
        // from one thread into another.
        <ThreadPanel
          allowLocationSharing={allowLocationSharing}
          blockedUserIds={hiddenAuthors}
          channelName={channelName}
          currentUser={currentUser}
          key={threadParent.id}
          onClose={() => location.route(backRouteForThread(conversation))}
          onDelete={onDelete}
          onEdit={onEdit}
          onReact={onReact}
          composerDisabledReason={activeChannel?.archived ? t("composer.archived") : undefined}
          readOnly={!!activeChannel?.archived}
          onReply={(body, attachments, messageLocation) =>
            onThreadReply(threadParent.id, body, attachments, messageLocation)
          }
          onUploadAttachment={allowAttachments ? onUploadAttachment : undefined}
          parent={threadParent}
          reactionsByTarget={reactionsByTarget}
          repliesByParent={repliesByParent}
          usersById={usersById}
        />
      ) : null}
      {isPrivateChannel && activeChannel && membersOpen ? (
        <Dialog className="members-dialog" onClose={() => setMembersOpen(false)} title={t("members.heading")}>
          <ChannelMembersPanel
            channel={activeChannel}
            currentUser={currentUser}
            onChannelUpsert={onChannelUpsert}
            onLeftChannel={onLeftChannel}
            users={users}
          />
        </Dialog>
      ) : null}
      {conversation.kind === "dm" && reportUserId === conversation.id ? (
        <ReportDialog targetType="user" targetId={reportUserId} onClose={() => setReportUserId(undefined)} />
      ) : null}
      {blockConfirmOpen && onSetBlocked ? (
        <ConfirmDialog
          confirmLabel={t("block.block")}
          onCancel={() => setBlockConfirmOpen(false)}
          onConfirm={() => {
            setBlockConfirmOpen(false);
            void onSetBlocked(conversation.id, true);
          }}
          title={t("block.block")}
        >
          {t("block.confirm", { name: title })}
        </ConfirmDialog>
      ) : null}
    </>
  );
}

/** Distance (px) between the bottom of a scroller's viewport and the end of its content. */
function distanceFromBottom(element: HTMLElement): number {
  return element.scrollHeight - element.scrollTop - element.clientHeight;
}

/**
 * Keep a scrolling list pinned to its newest content, chat-style.
 *
 * The list follows new content only while the reader is at (or near) the bottom; once they scroll up to
 * read history, it stays put and counts what arrived below instead (the "new messages" pill). It re-pins
 * when the visible viewport changes (the on-screen keyboard opening, via `onViewportResize`), when the
 * list itself resizes (the composer growing, a banner), and when an image inside finishes loading, so
 * the newest message never ends up hidden behind the keyboard or the composer.
 *
 * @param listRef - The scrolling element.
 * @param items - The list's items, oldest first; a new identity re-runs the pin (edits, streaming too).
 * @param currentUserId - A message you just sent always scrolls into view, even when scrolled up.
 * @param extra - Anything else that changes the content height (e.g. whether the typing pill shows).
 */
function useBottomPin(
  listRef: { current: HTMLElement | null },
  items: Message[],
  currentUserId: string,
  extra?: unknown,
) {
  const pinnedRef = useRef(true);
  const lastIdRef = useRef<string | null | undefined>(undefined);
  const [unseen, setUnseen] = useState(0);

  function scrollToBottom(): void {
    const element = listRef.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
    pinnedRef.current = true;
    setUnseen(0);
  }

  function repinIfPinned(): void {
    const element = listRef.current;
    if (element && pinnedRef.current) {
      element.scrollTop = element.scrollHeight;
    }
  }

  function onScroll(): void {
    const element = listRef.current;
    if (!element) {
      return;
    }
    pinnedRef.current = distanceFromBottom(element) < PIN_THRESHOLD_PX;
    if (pinnedRef.current) {
      setUnseen(0);
    }
  }

  // Layout effect, so the jump happens before paint (no flash of the old scroll position).
  useLayoutEffect(() => {
    const last = items[items.length - 1];
    const previousLastId = lastIdRef.current;
    lastIdRef.current = last?.id ?? null;

    if (previousLastId === undefined) {
      scrollToBottom(); // Opening a conversation shows its newest messages.
      return;
    }

    if (pinnedRef.current) {
      repinIfPinned(); // The reader is following along.
      return;
    }

    if (!last || last.id === previousLastId) {
      return; // An edit, reaction or streamed token above: leave the reader where they are.
    }

    if (last.authorId === currentUserId) {
      scrollToBottom();
      return;
    }

    const previousIndex = previousLastId === null ? -1 : items.findIndex((item) => item.id === previousLastId);
    const added = previousIndex >= 0 ? items.length - 1 - previousIndex : 1;
    setUnseen((count) => count + added);
  }, [items, extra]);

  // A layout effect so the subscription exists from the first frame (a keyboard can open immediately).
  useLayoutEffect(() => {
    const unsubscribe = onViewportResize(repinIfPinned);
    const element = listRef.current;
    let observer: ResizeObserver | undefined;
    if (element && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => repinIfPinned());
      observer.observe(element);
    }
    return () => {
      unsubscribe();
      observer?.disconnect();
    };
  }, []);

  return { onScroll, onLoadCapture: repinIfPinned, scrollToBottom, unseen };
}

interface MessageListProps {
  /** Authors whose posts collapse to a "blocked user" placeholder. */
  blockedUserIds: ReadonlySet<string>;
  conversation: Conversation;
  currentUser: User;
  onDelete: (messageId: string) => void;
  onEdit: (messageId: string, body: string) => Promise<boolean>;
  onOpenThread: (messageId: string) => void;
  onReact: (messageId: string, reaction: string) => Promise<void>;
  /** Archived (read-only) channel: per-message mutation affordances are hidden (see MessageItem). */
  readOnly?: boolean;
  reactionsByTarget: Map<string, Message[]>;
  repliesByParent: Map<string, Message[]>;
  topMessages: Message[];
  typers: string[];
  usersById: Map<string, User>;
}

/**
 * The scrolling message list, with the typing pill and the "new messages" pill floating over its bottom
 * edge (inside the list area, so neither can ever push the composer off screen). Mounted per
 * conversation (it lives in the keyed pane), so its scroll bookkeeping and an open report dialog start
 * fresh in every conversation.
 */
function MessageList({
  blockedUserIds,
  conversation,
  currentUser,
  onDelete,
  onEdit,
  onOpenThread,
  onReact,
  readOnly = false,
  reactionsByTarget,
  repliesByParent,
  topMessages,
  typers,
  usersById,
}: MessageListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  // The message currently being reported (opens ReportDialog); undefined = closed.
  const [reportMessage, setReportMessage] = useState<Message | undefined>(undefined);
  const typing = typers.length > 0;
  const pin = useBottomPin(listRef, topMessages, currentUser.id, typing);
  const grouped = useMemo(
    () => groupMessages(topMessages, { isolate: (message) => blockedUserIds.has(message.authorId) }),
    [blockedUserIds, topMessages],
  );

  return (
    <div className={typing ? "message-list-wrap is-typing" : "message-list-wrap"}>
      <div className="message-list" onLoadCapture={pin.onLoadCapture} onScroll={pin.onScroll} ref={listRef}>
        {grouped.length ? (
          grouped.map(({ first, last, message, newDay }) => (
            <div className="message-slot" key={message.id}>
              {newDay ? (
                <div className="day-divider" role="separator">
                  <span>{dayLabel(message.createdAt)}</span>
                </div>
              ) : null}
              <MessageItem
                currentUser={currentUser}
                groupFirst={first}
                groupLast={last}
                hiddenAsBlocked={blockedUserIds.has(message.authorId)}
                message={message}
                onDelete={onDelete}
                onEdit={onEdit}
                onOpenThread={conversation.kind === "channel" ? onOpenThread : undefined}
                onReact={onReact}
                onReport={setReportMessage}
                readOnly={readOnly}
                reactions={reactionSummary(
                  reactionsByTarget.get(message.id) ?? EMPTY_MESSAGES,
                  message.id,
                  currentUser.id,
                )}
                replyCount={withoutBlockedAuthors(repliesFor(repliesByParent.get(message.id) ?? EMPTY_MESSAGES, message.id), blockedUserIds).length}
                showAuthor={conversation.kind === "channel"}
                usersById={usersById}
              />
            </div>
          ))
        ) : (
          <p className="empty-copy message-list-empty">{t("messageList.empty")}</p>
        )}
      </div>
      <div className="message-list-overlay">
        {/* Always mounted, so screen readers hear each change of this live region. */}
        <p aria-live="polite" className={typing ? "typing-indicator" : "typing-indicator is-idle"}>
          {typing ? (
            <>
              <span aria-hidden="true" className="typing-dots">
                <span />
                <span />
                <span />
              </span>
              <span className="typing-text">{typingText(typers)}</span>
            </>
          ) : null}
        </p>
        {pin.unseen > 0 ? (
          <button className="btn btn-primary btn-sm new-messages-pill" onClick={pin.scrollToBottom} type="button">
            <IconArrowDown />
            {t("messageList.newMessages")}
          </button>
        ) : null}
      </div>
      {reportMessage ? (
        <ReportDialog targetType="message" targetId={reportMessage.id} onClose={() => setReportMessage(undefined)} />
      ) : null}
    </div>
  );
}

interface ThreadPanelProps {
  /** When true, the reply composer offers the "share location" toggle (docs/10; off by default). */
  allowLocationSharing?: boolean;
  /** Authors whose posts collapse to a "blocked user" placeholder. */
  blockedUserIds?: ReadonlySet<string>;
  /** The channel the thread belongs to (the header's "in #name"). */
  channelName: string;
  currentUser: User;
  onClose: () => void;
  onDelete: (messageId: string) => void;
  /** Set when the surrounding channel is archived — the reply composer disables with this reason. */
  composerDisabledReason?: string;
  /** Archived (read-only) channel: hide per-message mutation affordances in the thread too. */
  readOnly?: boolean;
  onEdit: (messageId: string, body: string) => Promise<boolean>;
  onReact: (messageId: string, reaction: string) => Promise<void>;
  onReply: (body: string, attachments?: MessageAttachment[], location?: MessageLocation) => Promise<void>;
  onUploadAttachment?: (file: File) => Promise<MessageAttachment>;
  parent: Message;
  reactionsByTarget: Map<string, Message[]>;
  repliesByParent: Map<string, Message[]>;
  usersById: Map<string, User>;
}

/**
 * The thread panel: the parent message, a "N replies" divider, the replies (grouped like the main list)
 * and a reply composer. A 360px side panel on desktop, the whole screen on phones (and on narrow tablets,
 * where it replaces the conversation); the shell's `thread-open` class does the switching. Mounted keyed
 * by the parent message id (see `ConversationPane`).
 */
function ThreadPanel({
  allowLocationSharing,
  blockedUserIds = NO_BLOCKS,
  channelName,
  composerDisabledReason,
  currentUser,
  onClose,
  onDelete,
  onEdit,
  onReact,
  onReply,
  onUploadAttachment,
  parent,
  reactionsByTarget,
  readOnly = false,
  repliesByParent,
  usersById,
}: ThreadPanelProps) {
  const timedOut = useIsTimedOut(currentUser);
  const [reportMessage, setReportMessage] = useState<Message | undefined>(undefined);
  const replies = useMemo(
    () => repliesFor(repliesByParent.get(parent.id) ?? EMPTY_MESSAGES, parent.id),
    [parent.id, repliesByParent],
  );
  const grouped = useMemo(
    () => groupMessages(replies, { isolate: (message) => blockedUserIds.has(message.authorId) }),
    [blockedUserIds, replies],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const pin = useBottomPin(scrollRef, replies, currentUser.id);

  return (
    <aside className="thread-panel">
      <ScreenHeader
        actions={
          <button aria-label={t("thread.close")} className="btn btn-icon btn-ghost thread-close" onClick={onClose} type="button">
            <IconClose />
          </button>
        }
        className="thread-header"
        headingLevel={2}
        onBack={onClose}
        subtitle={t("thread.inChannel", { name: channelName })}
        title={t("thread.eyebrow")}
      />
      <div className="thread-scroll" onLoadCapture={pin.onLoadCapture} onScroll={pin.onScroll} ref={scrollRef}>
        <MessageItem
          currentUser={currentUser}
          hiddenAsBlocked={blockedUserIds.has(parent.authorId)}
          message={parent}
          onDelete={onDelete}
          onEdit={onEdit}
          onReact={onReact}
          onReport={setReportMessage}
          readOnly={readOnly}
          reactions={reactionSummary(reactionsByTarget.get(parent.id) ?? EMPTY_MESSAGES, parent.id, currentUser.id)}
          usersById={usersById}
        />
        <div className="thread-divider" role="separator">
          <span>{replies.length ? t("message.replyCount", { n: replies.length }) : t("thread.noReplies")}</span>
        </div>
        {grouped.map(({ first, last, message }) => (
          <MessageItem
            currentUser={currentUser}
            groupFirst={first}
            groupLast={last}
            hiddenAsBlocked={blockedUserIds.has(message.authorId)}
            key={message.id}
            message={message}
            onDelete={onDelete}
            onEdit={onEdit}
            onReact={onReact}
            onReport={setReportMessage}
            readOnly={readOnly}
            reactions={reactionSummary(reactionsByTarget.get(message.id) ?? EMPTY_MESSAGES, message.id, currentUser.id)}
            usersById={usersById}
          />
        ))}
      </div>
      <MessageComposer
        allowLocationSharing={allowLocationSharing}
        disabledReason={composerDisabledReason ?? (timedOut ? t("composer.timedOut") : undefined)}
        label={t("thread.replyLabel")}
        onSend={onReply}
        onUploadAttachment={onUploadAttachment}
        placeholder={t("thread.replyLabel")}
      />
      {reportMessage ? (
        <ReportDialog targetType="message" targetId={reportMessage.id} onClose={() => setReportMessage(undefined)} />
      ) : null}
    </aside>
  );
}
