import type { Channel, Message, MessageAttachment, MessageLocation, User } from "@loam/schema";
import type { ComponentChildren } from "preact";
import { useLocation } from "preact-iso";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";

import { t } from "../i18n";
import { withoutBlockedAuthors, withoutBlockedReactions } from "../lib/blocks";
import { dayKey, dayLabel } from "../lib/dates";
import {
  groupReactionsByTarget,
  groupRepliesByParent,
  reactionSummary,
  repliesFor,
  topLevelMessages,
} from "../lib/messages";
import type { Conversation } from "../lib/protocol";
import { useIsTimedOut } from "../lib/timeout";
import { BackArrowIcon } from "./BackArrowIcon";
import { ChannelMembersPanel } from "./ChannelMembersPanel";
import { MessageComposer } from "./MessageComposer";
import { MessageItem } from "./MessageItem";
import { MobileBackLink } from "./MobileBackLink";
import { ReportDialog } from "./ReportDialog";

/** Shared empty array for grouped-map lookups with no matches, to avoid a fresh allocation per message. */
const EMPTY_MESSAGES: Message[] = [];
/** Shared empty block list (the default when the caller passes none). */
const NO_BLOCKS: ReadonlySet<string> = new Set();

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
          <p className="eyebrow">{t("conversation.emptyEyebrow")}</p>
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

/** One conversation's pane. Only ever mounted keyed by `conversationIdentity` (see `ConversationView`). */
function ConversationPane({
  allowAttachments,
  allowLocationSharing,
  blockedUserIds = NO_BLOCKS,
  channels,
  conversation,
  currentUser,
  notFound = false,
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
  const title =
    conversation.kind === "channel"
      ? `${isPrivateChannel ? "🔒" : "#"} ${activeChannel?.name ?? conversation.id}`
      : dmPeer?.displayName ?? conversation.id;

  function confirmBlock(): void {
    if (onSetBlocked && window.confirm(t("block.confirm", { name: title }))) {
      void onSetBlocked(conversation.id, true);
    }
  }

  if (notFound) {
    return (
      <section className="conversation">
        <div className="conversation-top">
          <ConversationHeader conversation={conversation} title={title} />
        </div>
        <div className="message-list conversation-not-found" role="status">
          <h2>{t("conversation.notFoundTitle")}</h2>
          <p className="empty-copy">{t("conversation.notFoundBody")}</p>
        </div>
      </section>
    );
  }

  return (
    <>
      <section className="conversation">
        {/* One wrapper = one grid row: .conversation is a strict header/list/composer 3-row grid. */}
        <div className="conversation-top">
          <ConversationHeader
            conversation={conversation}
            description={activeChannel?.description}
            title={title}
            trailing={
              isPrivateChannel ? (
                <button
                  aria-expanded={membersOpen}
                  className="ghost-button"
                  onClick={() => setMembersOpen((previous) => !previous)}
                  type="button"
                >
                  {t("conversation.members")}
                </button>
              ) : conversation.kind === "dm" && dmPeer?.type === "human" ? (
                // The report-a-USER entry point (the server + dialog already supported it, but nothing
                // opened it): reachable from the one place a person is the subject — their DM. Block sits
                // beside it (Play UGC policy, docs/30 B3); once blocked, the banner below offers Unblock.
                <>
                  <button className="ghost-button" onClick={() => setReportUserId(conversation.id)} type="button">
                    {t("report.userTitle")}
                  </button>
                  {canBlockPeer && !dmBlocked ? (
                    <button className="ghost-button" onClick={confirmBlock} type="button">
                      {t("block.block")}
                    </button>
                  ) : null}
                </>
              ) : undefined
            }
          />
          {isPrivateChannel && membersOpen && activeChannel ? (
            <ChannelMembersPanel
              channel={activeChannel}
              currentUser={currentUser}
              onChannelUpsert={onChannelUpsert}
              onLeftChannel={onLeftChannel}
              users={users}
            />
          ) : null}
          {dmBlocked ? (
            <div className="blocked-banner" role="status">
              <span>{t("block.dmBanner")}</span>
              {onSetBlocked ? (
                <button className="ghost-button" onClick={() => void onSetBlocked(conversation.id, false)} type="button">
                  {t("block.unblock")}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
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
          usersById={usersById}
        />
        {typers.length ? (
          <p className="typing-indicator" aria-live="polite">
            {typers.length === 1
              ? t("typing.one", { name: typers[0]! })
              : typers.length === 2
                ? t("typing.two", { a: typers[0]!, b: typers[1]! })
                : t("typing.many")}
          </p>
        ) : null}
        <MessageComposer
          allowLocationSharing={allowLocationSharing}
          disabledReason={composerDisabledReason}
          label={t("conversation.composerLabel", { name: conversation.kind === "channel" ? conversation.id : title })}
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
      {conversation.kind === "dm" && reportUserId === conversation.id ? (
        <ReportDialog targetType="user" targetId={reportUserId} onClose={() => setReportUserId(undefined)} />
      ) : null}
    </>
  );
}

function ConversationHeader({
  conversation,
  description,
  title,
  trailing,
}: {
  conversation: Conversation;
  description?: string;
  title: string;
  trailing?: ComponentChildren;
}) {
  return (
    <header className="conversation-header">
      <MobileBackLink />
      <div className="conversation-heading">
        <p className="eyebrow">{conversation.kind === "channel" ? t("conversation.kindChannel") : t("conversation.kindDm")}</p>
        <h1>{title}</h1>
        {description ? <p className="conversation-description">{description}</p> : null}
      </div>
      {trailing ? <div className="conversation-header-actions">{trailing}</div> : null}
    </header>
  );
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
  usersById: Map<string, User>;
}

/**
 * The scrolling message list. Mounted per conversation (it lives in the keyed pane), so its scroll
 * bookkeeping and an open report dialog start fresh in every conversation.
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
  usersById,
}: MessageListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const previousScrollHeightRef = useRef<number | undefined>(undefined);
  // The message currently being reported (opens ReportDialog); undefined = closed.
  const [reportMessage, setReportMessage] = useState<Message | undefined>(undefined);

  useEffect(() => {
    const el = listRef.current;

    if (!el) {
      return;
    }

    const previousScrollHeight = previousScrollHeightRef.current;
    const distanceFromBottom =
      previousScrollHeight === undefined ? 0 : previousScrollHeight - el.scrollTop - el.clientHeight;

    previousScrollHeightRef.current = el.scrollHeight;

    if (distanceFromBottom < 100) {
      el.scrollTo?.({ top: el.scrollHeight });
    }
  }, [topMessages.length]);

  return (
    <>
      <div className="message-list" ref={listRef}>
        {topMessages.length ? (
          topMessages.map((message, index) => {
            const previous = topMessages[index - 1];
            const newDay = !previous || dayKey(previous.createdAt) !== dayKey(message.createdAt);

            return (
              <div key={message.id}>
                {newDay ? (
                  <div className="day-divider" role="separator">
                    <span>{dayLabel(message.createdAt)}</span>
                  </div>
                ) : null}
                <MessageItem
                  currentUser={currentUser}
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
                  usersById={usersById}
                />
              </div>
            );
          })
        ) : (
          <p className="empty-copy">{t("messageList.empty")}</p>
        )}
      </div>
      {reportMessage ? (
        <ReportDialog targetType="message" targetId={reportMessage.id} onClose={() => setReportMessage(undefined)} />
      ) : null}
    </>
  );
}

interface ThreadPanelProps {
  /** When true, the reply composer offers the "share location" toggle (docs/10; off by default). */
  allowLocationSharing?: boolean;
  /** Authors whose posts collapse to a "blocked user" placeholder. */
  blockedUserIds?: ReadonlySet<string>;
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
 * Renders the thread side panel containing the thread parent message, its replies, and a reply composer.
 * Mounted keyed by the parent message id (see `ConversationPane`).
 *
 * @param currentUser - The currently signed-in user (used to determine ownership and reaction state).
 * @param parent - The parent message that the thread is showing replies for.
 * @param reactionsByTarget - Reaction messages grouped by target message id (from `groupReactionsByTarget`), used to compute reaction summaries without rescanning the conversation.
 * @param repliesByParent - Reply messages grouped by parent message id (from `groupRepliesByParent`), used to compute this thread's replies without rescanning the conversation.
 * @param usersById - Map of user id to User objects used to resolve author information for displayed messages.
 * @param onClose - Callback invoked when the panel should be closed (e.g., back or close button).
 * @param onReact - Callback invoked when a reaction action is triggered for a message.
 * @param onReply - Callback invoked with the reply body when the composer submits a new thread reply.
 *
 * @returns The thread panel JSX element.
 */
function ThreadPanel({
  allowLocationSharing,
  blockedUserIds = NO_BLOCKS,
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
  const replies = repliesFor(repliesByParent.get(parent.id) ?? EMPTY_MESSAGES, parent.id);

  return (
    <aside className="thread-panel">
      <header className="thread-header">
        <button aria-label={t("common.back")} className="mobile-back" onClick={onClose} type="button">
          <BackArrowIcon />
        </button>
        <div>
          <p className="eyebrow">{t("thread.eyebrow")}</p>
          <h2>{t("thread.heading")}</h2>
        </div>
        <button aria-label={t("thread.close")} className="close-button" onClick={onClose} type="button">
          ×
        </button>
      </header>
      <div className="thread-scroll">
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
        <div className="reply-divider">
          {replies.length ? t("message.replyCount", { n: replies.length }) : t("thread.noReplies")}
        </div>
        {replies.map((reply) => (
          <MessageItem
            currentUser={currentUser}
            hiddenAsBlocked={blockedUserIds.has(reply.authorId)}
            key={reply.id}
            message={reply}
            onDelete={onDelete}
            onEdit={onEdit}
            onReact={onReact}
            onReport={setReportMessage}
            readOnly={readOnly}
            reactions={reactionSummary(reactionsByTarget.get(reply.id) ?? EMPTY_MESSAGES, reply.id, currentUser.id)}
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
