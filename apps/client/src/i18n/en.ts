/**
 * English UI strings — the source of truth for every LOAM catalog.
 *
 * Every other locale file is typed `Catalog`, so a missing key is a **compile error** (and a
 * completeness test guards against extra/stale keys). Keys are flat and dotted, namespaced by view
 * (`composer.*`, `settings.*`, `admin.*`, `error.*`, …). A value is either a plain string or a
 * plural object keyed by CLDR category — the right form is chosen at render time via
 * `Intl.PluralRules` (see `t()` in `./index.ts`). Positional tokens are written `{token}` and filled
 * from the `params` passed to `t()`.
 */

/** CLDR plural categories. A language supplies only the subset it uses; `other` is always required. */
export type PluralCategory = "zero" | "one" | "two" | "few" | "many" | "other";
export type PluralMessage = Partial<Record<PluralCategory, string>> & { other: string };

export const en = {
  // Streaming assistant placeholder shown while a reply is still generating.
  "composer.thinking": "Thinking…",
  // Fallback body used in notification toasts for an image-only message.
  "toast.imageFallback": "📷 Image",

  // Shared button/label strings reused across views.
  "common.save": "Save",
  "common.saving": "Saving…",
  "common.cancel": "Cancel",
  "common.delete": "Delete",
  "common.remove": "Remove",
  "common.requestFailed": "Request failed: {status}",

  // Conversation view (channel / DM shell + empty state).
  "conversation.emptyEyebrow": "Local node ready",
  "conversation.emptyTitle": "Choose a channel or direct message.",
  "conversation.emptyBody":
    "Messages, replies and reactions persist locally and sync through the laptop or Raspberry Pi server while it is running.",
  "conversation.members": "Members",
  "conversation.kindChannel": "Channel",
  "conversation.kindDm": "Direct message",
  "conversation.composerLabel": "Message {name}",
  "conversation.composerPlaceholderChannel": "Post an update",
  "conversation.composerPlaceholderDm": "Send a direct message",

  // Message list empty state.
  "messageList.empty": "No messages yet. Start with the practical detail everyone needs.",

  // A single message (meta, edit form, reactions, thread/edit/delete controls).
  "message.editedTag": "(edited)",
  "message.editAriaLabel": "Edit message",
  "message.attachedImageAlt": "Attached image",
  "message.streaming": "Streaming",
  "message.reply": "Reply",
  "message.replyCount": { one: "{n} reply", other: "{n} replies" },
  "message.edit": "Edit",
  "message.deleteOwnTitle": "Delete your message",
  "message.deleteAdminTitle": "Delete this message (admin)",

  // Message composer (attachments, send).
  "composer.uploadFailed": "Upload failed.",
  "composer.removeAttachment": "Remove {name}",
  "composer.attachImage": "Attach an image",
  "composer.attachImageHint": "Attach an image (resized on this device before upload)",
  "composer.send": "Send",

  // Private-channel members panel.
  "members.loadError": "Unable to load members.",
  "members.inviteError": "Unable to invite that person.",
  "members.leaveConfirm": "Leave this channel? You'll need a new invite to come back.",
  "members.removeError": "Unable to remove that person.",
  "members.eyebrow": "Private channel",
  "members.heading": "Members",
  "members.leave": "Leave channel",
  "members.loading": "Loading members…",
  "members.owner": "Owner",
  "members.inviteLabel": "Invite someone",
  "members.choosePerson": "Choose a person…",
  "members.allMembers": "Everyone is already a member",
  "members.invite": "Invite",

  // Thread side panel.
  "thread.eyebrow": "Thread",
  "thread.heading": "Replies",
  "thread.close": "Close thread",
  "thread.noReplies": "No replies yet",
  "thread.replyLabel": "Reply in thread",
};

/**
 * The shape every locale catalog must satisfy: exactly `en`'s keys, with plain strings kept as
 * `string` (any translation) and plural values relaxed to `PluralMessage` (each language brings its
 * own set of CLDR categories). Derived from `en` so `en` stays the single source of truth.
 */
export type Catalog = {
  [K in keyof typeof en]: (typeof en)[K] extends string ? string : PluralMessage;
};
export type CatalogKey = keyof Catalog;
