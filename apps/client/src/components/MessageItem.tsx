import type { Message, User } from "@loam/schema";
import { generateDisplayName } from "@loam/display-name";
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

import { t } from "../i18n";
import { isImageAttachment } from "../lib/attachments";
import { trackBubbleFit } from "../lib/bubble-fit";
import { copyText } from "../lib/clipboard";
import { renderMarkdownCached } from "../lib/markdown";
import { placeToolbar } from "../lib/toolbar-placement";
import { bodyFor, displayTime } from "../lib/message-format";
import { isJumboEmoji, type ReactionSummary } from "../lib/messages";
import { firstEmoji, QUICK_REACTIONS, readRecentReactions, rememberReaction, SHEET_REACTIONS } from "../lib/reactions";
import { useLongPress } from "../lib/use-long-press";
import { AttachmentFile } from "./AttachmentFile";
import { AttachmentImage } from "./AttachmentImage";
import { Avatar } from "./Avatar";
import { Dialog } from "./Dialog";
import { IconChevronRight, IconCopy, IconEdit, IconFlag, IconPlus, IconReply, IconSmile, IconTrash } from "./icons";
import { LocationCard } from "./LocationCard";
import { Menu, type MenuItem } from "./Menu";

interface MessageItemProps {
  currentUser: User;
  /** The author is someone the current user blocked (docs/30 B3): collapse to a placeholder, revealable on tap. */
  hiddenAsBlocked?: boolean;
  message: Message;
  onDelete: (messageId: string) => void;
  onEdit: (messageId: string, body: string) => Promise<boolean>;
  onOpenThread?: (messageId: string) => void;
  onReact: (messageId: string, reaction: string) => Promise<void>;
  /** Open the report dialog for this message (omitted → no report affordance, e.g. for the current user's own). */
  onReport?: (message: Message) => void;
  reactions: ReactionSummary[];
  /** The surrounding channel is archived (read-only): hide edit/delete/react affordances — the
   * server refuses them anyway — while keeping the content, existing reactions, thread access, and
   * (for admins) moderation delete. */
  readOnly?: boolean;
  replyCount?: number;
  usersById: Map<string, User>;
  /** First message of a group of consecutive messages by one author: shows the avatar and name. Default true. */
  groupFirst?: boolean;
  /** Last message of its group: gets the bubble tail. Default true. */
  groupLast?: boolean;
  /** Show the author's name on a group's first bubble (channels). A DM never does: the header says who. */
  showAuthor?: boolean;
}

/** The box of an element's text itself (a block's full-width row would be far wider than the words). */
function textBox(element: Element | null): DOMRect | undefined {
  if (!element) {
    return undefined;
  }
  const range = element.ownerDocument.createRange();
  range.selectNodeContents(element);
  return range.getBoundingClientRect();
}

/** Letters of the right-to-left scripts LOAM ships (Hebrew, Arabic, Persian/Dari/Pashto/Urdu, Syriac, Thaana…). */
const RTL_LETTER = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;

/**
 * The direction a browser's `dir="auto"` would pick for this text (its first strong letter decides), or
 * the page's direction when it has no letters at all (emoji, numbers).
 */
function textDirection(text: string): "ltr" | "rtl" {
  const firstLetter = /\p{L}/u.exec(text)?.[0];
  if (firstLetter) {
    return RTL_LETTER.test(firstLetter) ? "rtl" : "ltr";
  }
  return typeof document !== "undefined" && document.documentElement.dir === "rtl" ? "rtl" : "ltr";
}

/** One action a message offers, shared by the desktop menu and the touch sheet. */
interface MessageAction {
  key: string;
  label: string;
  icon: ComponentChildren;
  onSelect: () => void;
  danger?: boolean;
}

/**
 * One chat message: bubble (body, attachments, location, time inside), reactions, thread affordance, and
 * its actions.
 *
 * Actions are never a permanently visible icon row. With a mouse, hovering (or focusing) the message
 * reveals a small floating toolbar: quick reactions, reply in thread, and a ⋮ menu (copy, edit, delete,
 * report). On touch, a long-press on the bubble opens a bottom sheet with the same options; tapping the
 * time inside the bubble opens it too, so nothing is reachable only through a gesture.
 */
export function MessageItem({
  currentUser,
  groupFirst = true,
  groupLast = true,
  hiddenAsBlocked = false,
  message,
  onDelete,
  onEdit,
  onOpenThread,
  onReact,
  onReport,
  reactions,
  readOnly = false,
  replyCount = 0,
  showAuthor = true,
  usersById,
}: MessageItemProps) {
  const author = usersById.get(message.authorId) ?? {
    id: message.authorId,
    displayName: generateDisplayName(message.authorId),
    type: "human",
    isAdmin: false,
    createdAt: message.createdAt,
    ephemeral: true,
  };
  const isMine = message.authorId === currentUser.id;
  const streaming = message.meta?.streaming === true;
  // A moderator-removed message is an honest tombstone: shown, but with no body/attachments/actions.
  const removed = message.meta?.removedByModerator === true;
  const canEdit = isMine && !removed && !readOnly && !streaming && message.type !== "reaction";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  // The sheet's "any emoji" field (lib/reactions.ts): shown by its "+" tile, gone when the sheet closes.
  const [emojiFieldOpen, setEmojiFieldOpen] = useState(false);
  const [emojiFieldRefused, setEmojiFieldRefused] = useState(false);
  const emojiFieldRef = useRef<HTMLInputElement>(null);
  // A blocked author's message stays collapsed until the reader deliberately taps "Show" (per message).
  const [revealed, setRevealed] = useState(false);
  const longPress = useLongPress(() => {
    if (!editing) {
      setSheetOpen(true);
    }
  });
  const bodyText = bodyFor(message);
  // WhatsApp-style "jumbo emoji": a lone/short burst of emoji (1-3, no other text, no attachments)
  // renders big with no bubble — never while actively editing the message.
  // `attachments` only exists on the body-bearing message arms (not `reaction`/`sealed`) — the `in` guard
  // narrows the union so this is safe for every message type.
  const hasAttachments = "attachments" in message && !!message.attachments?.length;
  const jumbo = !editing && !removed && !hasAttachments && isJumboEmoji(bodyText);
  // @mentions-lite: highlight a message that names the current user by their (deterministic, near-unique)
  // display name. Client-side only — a visual/attention cue, not a stored/notified mention. A trailing
  // boundary (no following word char or dot) stops `@blue.iron.fox` matching someone else's `@...foxes`.
  const mentionsYou =
    !isMine &&
    !removed &&
    message.type !== "reaction" &&
    !!currentUser.displayName &&
    new RegExp(`@${currentUser.displayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.])`, "i").test(bodyText);
  // In a read-only (archived) channel only the admin moderation-delete survives — mirroring the
  // server's adminOverride on the delete route.
  const canDelete = (readOnly ? currentUser.isAdmin : isMine || currentUser.isAdmin) && !removed && !streaming;
  // Report anyone else's non-removed, non-streaming message (never your own; reactions carry no content).
  const canReport = !!onReport && !isMine && !removed && !streaming && message.type !== "reaction";
  // The server refuses new reactions on an archived channel's messages and on a moderator-removed one.
  const canReact = !readOnly && !removed && !streaming && message.type !== "reaction";
  const canReply = !!onOpenThread && !readOnly && !removed && !streaming;
  const canCopy = !removed && !streaming && message.type !== "reaction" && bodyText.trim() !== "";

  function startEditing(): void {
    setDraft(bodyFor(message));
    setEditing(true);
  }

  async function saveEdit(): Promise<void> {
    setSavingEdit(true);
    const ok = await onEdit(message.id, draft);
    setSavingEdit(false);
    if (ok) {
      setEditing(false);
    }
  }

  function react(reaction: string): void {
    void onReact(message.id, reaction).catch(() => {});
  }

  function closeSheet(): void {
    setSheetOpen(false);
    setEmojiFieldOpen(false);
    setEmojiFieldRefused(false);
  }

  /** React from the sheet: closes it first, as every sheet action does. */
  function reactFromSheet(reaction: string): void {
    closeSheet();
    react(reaction);
  }

  /** The emoji field takes the first emoji typed into it; plain text gets a hint instead. */
  function onEmojiFieldInput(value: string): void {
    const emoji = firstEmoji(value);

    if (emoji) {
      rememberReaction(emoji);
      reactFromSheet(emoji);
    } else {
      setEmojiFieldRefused(value.trim() !== "");
    }
  }

  useEffect(() => {
    if (emojiFieldOpen) {
      emojiFieldRef.current?.focus();
    }
  }, [emojiFieldOpen]);

  // Everything behind the ⋮ menu (desktop) and below the reactions in the sheet (touch), in one order.
  const menuActions: MessageAction[] = [
    ...(canCopy
      ? [{ key: "copy", label: t("message.copyText"), icon: <IconCopy />, onSelect: () => void copyText(bodyText) }]
      : []),
    ...(canEdit && !editing
      ? [{ key: "edit", label: t("message.edit"), icon: <IconEdit />, onSelect: startEditing }]
      : []),
    ...(canDelete
      ? [
          {
            key: "delete",
            label: isMine ? t("common.delete") : t("message.deleteAdminTitle"),
            icon: <IconTrash />,
            onSelect: () => onDelete(message.id),
            danger: true,
          },
        ]
      : []),
    ...(canReport
      ? [{ key: "report", label: t("message.report"), icon: <IconFlag />, onSelect: () => onReport?.(message) }]
      : []),
  ];
  const replyAction: MessageAction | undefined = canReply
    ? { key: "reply", label: t("thread.replyLabel"), icon: <IconReply />, onSelect: () => onOpenThread?.(message.id) }
    : undefined;
  const sheetActions = replyAction ? [replyAction, ...menuActions] : menuActions;
  const hasActions = canReact || sheetActions.length > 0;

  const hasLocation = !removed && "location" in message && !!message.location;
  const stampInline = !editing && !jumbo && !hasLocation && (removed || bodyText.trim() !== "");
  // A text-only bubble is narrowed to its widest line once it wraps (lib/bubble-fit.ts); one with
  // attachments keeps the width they give it.
  const fitWidth = stampInline && !hasAttachments;
  const bubbleRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const bubble = bubbleRef.current;
    const column = bubble?.parentElement?.parentElement;
    if (!fitWidth || !bubble || !column) {
      return;
    }
    return trackBubbleFit(bubble, column);
  }, [fitWidth, bodyText, message.editedAt, removed]);

  const toolbarRef = useRef<HTMLDivElement>(null);
  /**
   * Place the desktop hover toolbar just before it shows (hover or keyboard focus): beside the bubble when
   * there's room, else over its corner, never on the author's name (lib/toolbar-placement.ts). Positions
   * are measured, since how much room a bubble leaves depends on its width.
   */
  function positionToolbar(event: Event): void {
    const toolbar = toolbarRef.current;
    const bubble = bubbleRef.current;
    const wrap = toolbar?.parentElement;
    const article = event.currentTarget as HTMLElement;
    const list = article.closest(".message-list, .thread-scroll");
    if (!toolbar || !bubble || !wrap || !list) {
      return;
    }
    const size = toolbar.getBoundingClientRect();
    if (!size.width) {
      return; // Hidden (touch layout): nothing to place.
    }
    const listBox = list.getBoundingClientRect();
    const inset = 4;
    const { left, top } = placeToolbar({
      bubble: bubble.getBoundingClientRect(),
      bounds: {
        left: listBox.left + inset,
        top: listBox.top,
        right: listBox.right - inset,
        bottom: listBox.bottom,
      },
      mine: isMine,
      name: textBox(article.querySelector(".message-author")),
      rtl: getComputedStyle(article).direction === "rtl",
      toolbar: { width: size.width, height: size.height },
    });
    const origin = wrap.getBoundingClientRect();
    toolbar.style.left = `${Math.round(left - origin.left)}px`;
    toolbar.style.top = `${Math.round(top - origin.top)}px`;
    toolbar.style.right = "auto";
  }

  if (hiddenAsBlocked && !isMine && !revealed) {
    // No avatar, name, body, attachments or actions — just the fact that something is here.
    return (
      <article className="message theirs message-blocked group-first group-last">
        <div className="message-column">
          <div className="message-bubble">
            <p className="message-removed" dir="auto">
              <em>{t("block.hiddenMessage")}</em>{" "}
              <button className="link-button" onClick={() => setRevealed(true)} type="button">
                {t("block.show")}
              </button>
            </p>
          </div>
        </div>
      </article>
    );
  }

  const time = displayTime(message.createdAt);
  const edited = !!message.editedAt && !removed;
  // The time sits inside the bubble at its bottom-end corner. When text is the last thing in the bubble,
  // the stamp floats over the end of the last line and an invisible copy of it (a `::after` on the body,
  // reading `--stamp`) reserves exactly its width there, WhatsApp-style: a short message stays
  // one line tall, a long one wraps the stamp onto its own line. Otherwise it sits on its own row.
  const stampText = `${edited ? `${t("message.editedTag")} ` : ""}${time}`.replace(/["\\]/g, "");
  const bubbleClassName = [
    "message-bubble",
    stampInline ? "stamp-inline" : undefined,
    hasAttachments && !removed ? "has-attachments" : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  const messageClassName = [
    "message",
    isMine ? "mine" : "theirs",
    groupFirst ? "group-first" : undefined,
    groupLast ? "group-last" : undefined,
    streaming ? "streaming" : undefined,
    jumbo ? "jumbo" : undefined,
    mentionsYou ? "mentions-you" : undefined,
    editing ? "is-editing" : undefined,
    removed ? "is-removed" : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  const showName = !isMine && showAuthor && groupFirst;

  return (
    <article
      className={messageClassName}
      onFocusIn={hasActions && !editing ? positionToolbar : undefined}
      onPointerEnter={hasActions && !editing ? positionToolbar : undefined}
    >
      {showName ? (
        <p className="message-author" dir="auto">
          {author.displayName}
        </p>
      ) : null}
      {/* WhatsApp behaviour: your own messages carry no avatar or name — alignment and colour say who. The
          avatar sits in a fixed gutter, top-aligned with the group's first bubble; later bubbles keep the
          gutter empty so the column stays straight. */}
      {!isMine ? (
        <div className="message-gutter">
          {groupFirst ? <Avatar avatar={author.avatar} id={author.id} size="sm" /> : null}
        </div>
      ) : null}
      <div className="message-column">
        <div className="message-bubble-wrap">
          <div
            className={bubbleClassName}
            ref={bubbleRef}
            dir={stampInline ? textDirection(removed ? t("message.removedByModerator") : bodyText) : undefined}
            style={stampInline ? { "--stamp": `"${stampText}"` } : undefined}
            {...(hasActions && !editing ? longPress : {})}
          >
            {removed ? (
              <p className="message-removed" dir="auto">
                <em>{t("message.removedByModerator")}</em>
                {message.meta?.removalReason ? (
                  <span className="message-removed-reason">: {message.meta.removalReason}</span>
                ) : null}
              </p>
            ) : editing ? (
              <form
                className="message-edit"
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    setEditing(false);
                  }
                }}
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveEdit();
                }}
              >
                <textarea
                  aria-label={t("message.editAriaLabel")}
                  // eslint-disable-next-line jsx-a11y/no-autofocus
                  autoFocus
                  className="textarea"
                  dir="auto"
                  disabled={savingEdit}
                  onInput={(event) => setDraft(event.currentTarget.value)}
                  rows={2}
                  value={draft}
                />
                <div className="message-edit-actions">
                  <button
                    className="btn btn-secondary btn-sm"
                    disabled={savingEdit}
                    onClick={() => setEditing(false)}
                    type="button"
                  >
                    {t("common.cancel")}
                  </button>
                  <button className="btn btn-primary btn-sm" disabled={savingEdit || !draft.trim()} type="submit">
                    {savingEdit ? t("common.saving") : t("common.save")}
                  </button>
                </div>
              </form>
            ) : (
              <>
                {!removed && message.type !== "reaction" && message.type !== "sealed" && message.attachments?.length ? (
                  <div className="message-attachments">
                    {message.attachments.map((attachment) =>
                      isImageAttachment(attachment) ? (
                        <AttachmentImage attachment={attachment} alt={t("message.attachedImageAlt")} key={attachment.id} />
                      ) : (
                        // Non-image file: a download link. Served octet-stream + attachment (never rendered);
                        // AttachmentFile routes the fetch through the transport tunnel so it works in required mode.
                        <AttachmentFile attachment={attachment} key={attachment.id} />
                      ),
                    )}
                  </div>
                ) : null}
                {jumbo ? (
                  <div className="message-jumbo-emoji" dir="auto">
                    {bodyText.trim()}
                  </div>
                ) : bodyText ? (
                  <div
                    className="markdown-body"
                    dir="auto"
                    dangerouslySetInnerHTML={{
                      __html: renderMarkdownCached(message.id, bodyText, message.editedAt),
                    }}
                  />
                ) : null}
                {hasLocation && "location" in message && message.location ? <LocationCard location={message.location} /> : null}
              </>
            )}
            {editing ? null : (
              <span className="message-stamp">
                {edited ? <span className="message-edited">{t("message.editedTag")}</span> : null}
                {hasActions ? (
                  // The always-available (non-gesture) way into the actions on touch; harmless with a mouse.
                  <button
                    aria-haspopup="dialog"
                    aria-label={t("message.actionsAt", { time })}
                    className="message-time"
                    onClick={() => setSheetOpen(true)}
                    type="button"
                  >
                    <time dateTime={new Date(message.createdAt).toISOString()}>{time}</time>
                  </button>
                ) : (
                  <time className="message-time" dateTime={new Date(message.createdAt).toISOString()}>
                    {time}
                  </time>
                )}
              </span>
            )}
          </div>
          {hasActions && !editing ? (
            <div
              aria-label={t("message.actionsTitle")}
              className="message-toolbar"
              ref={toolbarRef}
              // A pointer click must not focus a toolbar button: the toolbar shows while it has focus (so
              // keyboard users can reach it), and a focused button would pin it open after the click while
              // the mouse has already moved on to the next message. Keyboard focus is unaffected.
              onMouseDown={(event) => event.preventDefault()}
              role="toolbar"
            >
              {canReact
                ? QUICK_REACTIONS.map((reaction) => (
                    <button
                      aria-label={t("message.reactWith", { emoji: reaction })}
                      className="btn btn-icon btn-sm btn-ghost quick-reaction"
                      key={reaction}
                      onClick={() => react(reaction)}
                      type="button"
                    >
                      {reaction}
                    </button>
                  ))
                : null}
              {canReact ? (
                <button
                  aria-haspopup="dialog"
                  aria-label={t("message.moreReactions")}
                  className="btn btn-icon btn-sm btn-ghost"
                  onClick={() => setSheetOpen(true)}
                  type="button"
                >
                  <IconSmile size={18} />
                </button>
              ) : null}
              {replyAction ? (
                <button
                  aria-label={replyAction.label}
                  className="btn btn-icon btn-sm btn-ghost message-reply-button"
                  onClick={replyAction.onSelect}
                  type="button"
                >
                  <IconReply size={18} />
                </button>
              ) : null}
              {menuActions.length ? (
                <Menu
                  items={menuActions.map(
                    (action): MenuItem => ({
                      label: action.label,
                      icon: action.icon,
                      onSelect: action.onSelect,
                      danger: action.danger,
                    }),
                  )}
                  label={t("message.moreActions")}
                  presentation="popover"
                  triggerClassName="btn-sm message-more"
                />
              ) : null}
            </div>
          ) : null}
        </div>
        {streaming ? <span className="streaming-pill">{t("message.streaming")}</span> : null}
        {!streaming && reactions.length ? (
          <div className="message-reactions">
            {reactions.map((reaction) => (
              <button
                aria-pressed={reaction.active}
                className={reaction.active ? "reaction-chip is-active" : "reaction-chip"}
                disabled={readOnly}
                key={reaction.reaction}
                onClick={() => react(reaction.reaction)}
                type="button"
              >
                {reaction.reaction} <span className="reaction-count">{reaction.count}</span>
              </button>
            ))}
          </div>
        ) : null}
        {onOpenThread && replyCount && !streaming ? (
          <button className="thread-button" onClick={() => onOpenThread(message.id)} type="button">
            {t("message.replyCount", { n: replyCount })}
            <IconChevronRight size={16} />
          </button>
        ) : null}
      </div>
      {sheetOpen ? (
        <Dialog
          className="menu-sheet message-sheet"
          hideTitle
          onClose={closeSheet}
          title={t("message.actionsTitle")}
          variant="sheet"
        >
          {canReact ? (
            <div className="message-sheet-reactions">
              <div className="sheet-reaction-grid">
                {[...SHEET_REACTIONS, null, ...readRecentReactions()].map((reaction) => {
                  if (reaction === null) {
                    // The "any emoji" tile opens the fourth row, followed by this device's recent picks.
                    return (
                      <button
                        aria-expanded={emojiFieldOpen}
                        aria-label={t("message.otherEmoji")}
                        className={`sheet-reaction sheet-reaction-more${emojiFieldOpen ? " is-active" : ""}`}
                        key="more"
                        onClick={() => setEmojiFieldOpen((open) => !open)}
                        type="button"
                      >
                        <IconPlus size={22} />
                      </button>
                    );
                  }

                  const active = reactions.some((summary) => summary.reaction === reaction && summary.active);
                  return (
                    <button
                      aria-label={t("message.reactWith", { emoji: reaction })}
                      aria-pressed={active}
                      className={active ? "sheet-reaction is-active" : "sheet-reaction"}
                      key={reaction}
                      onClick={() => reactFromSheet(reaction)}
                      type="button"
                    >
                      {reaction}
                    </button>
                  );
                })}
              </div>
              {emojiFieldOpen ? (
                <div className="sheet-emoji-field">
                  <input
                    aria-describedby={`emoji-hint-${message.id}`}
                    aria-label={t("message.otherEmoji")}
                    autoComplete="off"
                    className="input"
                    enterKeyHint="done"
                    onInput={(event) => onEmojiFieldInput(event.currentTarget.value)}
                    placeholder={t("message.emojiFieldPlaceholder")}
                    ref={emojiFieldRef}
                    type="text"
                  />
                  <p
                    className={emojiFieldRefused ? "field-error" : "field-hint"}
                    id={`emoji-hint-${message.id}`}
                    role={emojiFieldRefused ? "alert" : undefined}
                  >
                    {emojiFieldRefused ? t("message.emojiFieldRefused") : t("message.emojiFieldHint")}
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}
          {sheetActions.length ? (
            <div className="menu">
              {sheetActions.map((action) => (
                <button
                  className={action.danger ? "menu-item is-danger" : "menu-item"}
                  key={action.key}
                  onClick={() => {
                    // Close first, so an action that opens its own dialog (report) gets focus cleanly.
                    closeSheet();
                    action.onSelect();
                  }}
                  type="button"
                >
                  <span className="menu-item-icon">{action.icon}</span>
                  <span className="menu-item-label">{action.label}</span>
                </button>
              ))}
            </div>
          ) : null}
        </Dialog>
      ) : null}
    </article>
  );
}
