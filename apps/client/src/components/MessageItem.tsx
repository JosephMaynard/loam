import type { Message, User } from "@loam/schema";
import { generateDisplayName } from "@loam/display-name";
import { useState } from "preact/hooks";

import { t } from "../i18n";
import { renderMarkdownCached } from "../lib/markdown";
import { bodyFor, displayTime } from "../lib/message-format";
import type { ReactionSummary } from "../lib/messages";
import { AttachmentImage } from "./AttachmentImage";
import { Avatar } from "./Avatar";
import { LocationCard } from "./LocationCard";

const QUICK_REACTIONS = ["👍", "❤️", "✅"];

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
  const messageClassName = ["message", isMine ? "mine" : undefined, message.meta?.streaming ? "streaming" : undefined]
    .filter(Boolean)
    .join(" ");

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
      <Avatar avatar={author.avatar} id={author.id} />
      <div className="message-main">
        <div className="message-meta">
          <strong>{author.displayName}</strong>
          <span>{displayTime(message.createdAt)}</span>
          {message.editedAt ? <span className="edited-tag">{t("message.editedTag")}</span> : null}
        </div>
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
        ) : (
          <div
            className="markdown-body"
            dir="auto"
            dangerouslySetInnerHTML={{
              __html: renderMarkdownCached(message.id, bodyFor(message), message.editedAt),
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
          {canEdit && !editing ? (
            <button className="message-edit-button" onClick={startEditing} type="button">
              {t("message.edit")}
            </button>
          ) : null}
          {(isMine || currentUser.isAdmin) && !message.meta?.streaming ? (
            <button
              className="message-delete"
              onClick={() => onDelete(message.id)}
              title={isMine ? t("message.deleteOwnTitle") : t("message.deleteAdminTitle")}
              type="button"
            >
              {t("common.delete")}
            </button>
          ) : null}
        </div>
      </div>
    </article>
  );
}
