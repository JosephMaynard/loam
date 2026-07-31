import type { Message, User } from "@loam/schema";
import { generateDisplayName } from "@loam/display-name";
import { useState } from "preact/hooks";

import { t } from "../i18n";
import { renderMarkdownCached } from "../lib/markdown";
import { bodyFor, displayTime } from "../lib/message-format";
import { isJumboEmoji, type ReactionSummary } from "../lib/messages";
import { AttachmentImage } from "./AttachmentImage";
import { Avatar } from "./Avatar";
import { LocationCard } from "./LocationCard";

const QUICK_REACTIONS = ["👍", "❤️", "✅"];

/**
 * Small pencil glyph for the "edit message" icon button — same inline-SVG convention as
 * `BackArrowIcon`/the composer's paperclip (fixed viewBox, `currentColor`, round strokes,
 * `aria-hidden` since the enclosing button carries the accessible label).
 */
function PencilIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="16"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="2"
      viewBox="0 0 24 24"
      width="16"
    >
      <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
    </svg>
  );
}

/** Small trash-can glyph for the "delete message" icon button — same convention as `PencilIcon`. */
function TrashIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="16"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="2"
      viewBox="0 0 24 24"
      width="16"
    >
      <path d="M3 6h18" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

interface MessageItemProps {
  currentUser: User;
  message: Message;
  onDelete: (messageId: string) => void;
  onEdit: (messageId: string, body: string) => Promise<boolean>;
  onOpenThread?: (messageId: string) => void;
  onReact: (messageId: string, reaction: string) => Promise<void>;
  reactions: ReactionSummary[];
  replyCount?: number;
  usersById: Map<string, User>;
}

/**
 * Render a single chat message including avatar, author metadata, formatted body, reactions, and thread/reply controls.
 *
 * @param currentUser - The currently signed-in user (used to determine message ownership).
 * @param message - The message to render.
 * @param onOpenThread - Optional callback invoked with the message id to open its thread view.
 * @param onReact - Callback invoked with the message id and reaction string when a reaction or quick reaction is triggered.
 * @param reactions - Aggregated reaction summaries for this message (used to render reaction buttons and active state).
 * @param replyCount - Number of replies to this message; used to label the thread button.
 * @param usersById - Map of users keyed by id; used to resolve the message author (falls back to a generated ephemeral author when missing).
 * @returns A JSX element representing the message item.
 */
export function MessageItem({
  currentUser,
  message,
  onDelete,
  onEdit,
  onOpenThread,
  onReact,
  reactions,
  replyCount = 0,
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
  const canEdit = isMine && !message.meta?.streaming && message.type !== "reaction";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const bodyText = bodyFor(message);
  // WhatsApp-style "jumbo emoji": a lone/short burst of emoji (1-3, no other text, no attachments)
  // renders big with no bubble — never while actively editing the message.
  // `attachments` only exists on the body-bearing message arms (not `reaction`/`sealed`) — the `in` guard
  // narrows the union so this is safe for every message type.
  const hasAttachments = "attachments" in message && !!message.attachments?.length;
  const jumbo = !editing && !hasAttachments && isJumboEmoji(bodyText);
  const messageClassName = [
    "message",
    isMine ? "mine" : undefined,
    message.meta?.streaming ? "streaming" : undefined,
    jumbo ? "jumbo" : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  const canDelete = (isMine || currentUser.isAdmin) && !message.meta?.streaming;
  const hasIconActions = (canEdit && !editing) || canDelete;

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

  return (
    <article className={messageClassName}>
      {/* WhatsApp behaviour: your own messages hide the avatar (and, in the meta row below, the
          author name) since the alignment + bubble colour already say who sent it. */}
      {!isMine ? <Avatar avatar={author.avatar} id={author.id} /> : null}
      <div className="message-main">
        <div className="message-meta">
          {!isMine ? <strong>{author.displayName}</strong> : null}
          <span>{displayTime(message.createdAt)}</span>
          {message.editedAt ? <span className="edited-tag">{t("message.editedTag")}</span> : null}
        </div>
        <div className="message-bubble">
          {editing ? (
            <form
              className="message-edit"
              onSubmit={(event) => {
                event.preventDefault();
                void saveEdit();
              }}
            >
              <textarea
                aria-label={t("message.editAriaLabel")}
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
                dir="auto"
                disabled={savingEdit}
                onInput={(event) => setDraft(event.currentTarget.value)}
                rows={2}
                value={draft}
              />
              <div className="message-edit-actions">
                <button disabled={savingEdit || !draft.trim()} type="submit">
                  {savingEdit ? t("common.saving") : t("common.save")}
                </button>
                <button disabled={savingEdit} onClick={() => setEditing(false)} type="button">
                  {t("common.cancel")}
                </button>
              </div>
            </form>
          ) : jumbo ? (
            <div className="message-jumbo-emoji" dir="auto">
              {bodyText.trim()}
            </div>
          ) : (
            <div
              className="markdown-body"
              dir="auto"
              dangerouslySetInnerHTML={{
                __html: renderMarkdownCached(message.id, bodyText, message.editedAt),
              }}
            />
          )}
          {message.type !== "reaction" && message.type !== "sealed" && message.attachments?.length ? (
            <div className="message-attachments">
              {message.attachments.map((attachment) => (
                <AttachmentImage attachment={attachment} alt={t("message.attachedImageAlt")} key={attachment.id} />
              ))}
            </div>
          ) : null}
          {message.type !== "reaction" && message.type !== "sealed" && message.location ? (
            <LocationCard location={message.location} />
          ) : null}
        </div>
        <div className="message-actions">
          {message.meta?.streaming ? <span className="streaming-pill">{t("message.streaming")}</span> : null}
          {!message.meta?.streaming && reactions.map((reaction) => (
            <button
              className={reaction.active ? "reaction active" : "reaction"}
              key={reaction.reaction}
              onClick={() => void onReact(message.id, reaction.reaction).catch(() => {})}
              type="button"
            >
              {reaction.reaction} {reaction.count}
            </button>
          ))}
          {!message.meta?.streaming && QUICK_REACTIONS.filter(
            (reaction) => !reactions.some((summary) => summary.reaction === reaction),
          ).map((reaction) => (
            <button
              className="quick-reaction"
              key={reaction}
              onClick={() => void onReact(message.id, reaction).catch(() => {})}
              type="button"
            >
              {reaction}
            </button>
          ))}
          {onOpenThread && !message.meta?.streaming ? (
            <button className="thread-button" onClick={() => onOpenThread(message.id)} type="button">
              {replyCount ? t("message.replyCount", { n: replyCount }) : t("message.reply")}
            </button>
          ) : null}
          {hasIconActions ? (
            <div className="message-icon-actions">
              {canEdit && !editing ? (
                <button
                  aria-label={t("message.edit")}
                  className="message-edit-button"
                  onClick={startEditing}
                  title={t("message.edit")}
                  type="button"
                >
                  <PencilIcon />
                </button>
              ) : null}
              {canDelete ? (
                <button
                  aria-label={isMine ? t("message.deleteOwnTitle") : t("message.deleteAdminTitle")}
                  className="message-delete"
                  onClick={() => onDelete(message.id)}
                  title={isMine ? t("message.deleteOwnTitle") : t("message.deleteAdminTitle")}
                  type="button"
                >
                  <TrashIcon />
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}
