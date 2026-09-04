// Typed boot/identity errors and the stable wire error-code table. Extracted from app.ts (2026-09-04 split).
import type { ServerErrorCode } from "@loam/schema";

/**
 * Thrown by `getSessionUserId` when a client IP exceeds its new-identity budget. The `statusCode`
 * makes Fastify's default error handler answer `429 Too Many Requests` without a custom handler.
 */
export class IdentityLimitError extends Error {
  readonly statusCode = 429;
  constructor() {
    super("Too many new identities from this address");
    this.name = "IdentityLimitError";
  }
}

/**
 * Thrown by `openInitialStore` (P1-1, docs/15) when a database is genuinely unopenable (wrong/lost
 * key, or an unreadable file) and no start-fresh confirmation was present for THIS boot attempt. The
 * typed `.code` lets `embedded-main.ts` tell this specific, recoverable-without-a-process-restart
 * failure apart from every other boot error — see its `hasStayAliveBootErrorCode` — without
 * string-matching the human-readable message.
 */
export class DbEncryptionUnreadableError extends Error {
  readonly code = "db_encryption_unreadable" as const;
  constructor(message: string) {
    super(message);
    this.name = "DbEncryptionUnreadableError";
  }
}

/**
 * Thrown by `openInitialStore` (P1-4-server, Sol round 8) when an EXISTING PLAINTEXT database is found
 * while an encrypted mode is configured (a `dbKey` is set): the keyed open failed but a plaintext open
 * succeeds. Serving that plaintext file while the persisted mode/hint say encrypted is a silent
 * confidentiality downgrade, so instead of falling through to a plaintext boot the store open LOCKS with
 * this distinct code. `embedded-main.ts` keeps the runtime alive for it (same as the unreadable path) so
 * the RN launcher bridge can offer the destructive "delete data and start encrypted" flow — consuming the
 * start-fresh marker DELETES the plaintext DB so the next boot creates a fresh encrypted database. The
 * plaintext-fallback-to-serving is only allowed when NO encrypted mode is configured (no `dbKey`).
 */
export class DbEncryptionPlaintextUnconvertedError extends Error {
  readonly code = "db_encryption_plaintext_unconverted" as const;
  constructor(message: string) {
    super(message);
    this.name = "DbEncryptionPlaintextUnconvertedError";
  }
}

/**
 * Thrown by `buildApp`'s boot-time wipe-phase resume (P1-1, Sol round 8) after it has re-run (and, on a
 * `delete-pending` phase, RETRIED) the fixed-key kill-switch artifact deletion BEFORE opening a serving
 * store. It never opens the real store — either the wipe is not yet safe to complete (deletion still
 * unverifiable → stay `delete-pending`, do not signal), or deletion is now proven complete and the
 * launcher has been signaled to clear the device key + restart (`key-clear-ready`). In both cases the
 * process must NOT serve under the old key, so the resume throws this and `embedded-main.ts` keeps the
 * runtime alive (like the unreadable path) rather than exiting — the imminent launcher restart, or a
 * later reopen, drives it forward.
 */
export class WipeResumeInProgressError extends Error {
  readonly code = "db_encryption_wipe_resume" as const;
  constructor(message: string) {
    super(message);
    this.name = "WipeResumeInProgressError";
  }
}

/**
 * Stable snake_case code for every error message the server can return, so clients can localize the
 * message from a catalog while the English `error` string stays as the fallback (unknown codes → the
 * client shows `error` verbatim). Keep these codes stable across releases — they are a wire contract
 * with a mixed-version mesh. The canonical set of codes is `SERVER_ERROR_CODES` in `@loam/schema`
 * (values here are typed against it, so a typo or unlisted code fails to compile); every code must
 * also have a matching `error.<code>` key in the client i18n catalogs (enforced by
 * `apps/client/src/i18n/i18n.test.ts`, which asserts against the same `SERVER_ERROR_CODES` list).
 */
export const ERROR_CODES: Record<string, ServerErrorCode> = {
  "Admin access required": "admin_required",
  "Admin claiming is not enabled on this LOAM node": "admin_claim_disabled",
  "Admin user editing is disabled on this LOAM node": "admin_user_edit_disabled",
  "Approve or unban this user before promoting them": "promote_requires_active",
  "Attachment does not exist": "attachment_not_found",
  "Attachment image must be 256KB or smaller": "attachment_too_large",
  "Attachment image type does not match the uploaded data": "attachment_type_mismatch",
  "Attachments are disabled on this LOAM node": "attachments_disabled",
  "Avatar image does not exist": "avatar_not_found",
  "Avatar image must be 128KB or smaller": "avatar_too_large",
  "Avatar image type does not match the uploaded data": "avatar_type_mismatch",
  "Cannot change the roles of an admin": "roles_admin_immutable",
  "Cannot react to this message": "reaction_not_allowed",
  "Channel does not exist": "channel_not_found",
  "Channel posting is disabled on this LOAM node": "channel_posting_disabled",
  "Creating channels is disabled on this LOAM node": "channel_create_disabled",
  'Confirmation required: send { "confirm": "wipe" }': "confirmation_required",
  "Direct messages are disabled on this LOAM node": "dms_disabled",
  "Enable sync and add at least one peer first": "sync_requires_peer",
  "Greeter access required": "greeter_required",
  "Invalid admin claim request": "invalid_admin_claim",
  "Invalid admin secret": "invalid_admin_secret",
  "Invalid attachment upload request": "invalid_attachment_upload",
  "Invalid avatar image upload request": "invalid_avatar_upload",
  "Invalid channel create request": "invalid_channel_create",
  "Invalid channel update request": "invalid_channel_update",
  "Invalid config update request": "invalid_config_update",
  "Invalid config values": "invalid_config_values",
  "Invalid kill-switch request": "invalid_kill_switch",
  "Invalid member request": "invalid_member_request",
  "Invalid transfer request": "invalid_transfer_request",
  "Invalid message edit request": "invalid_message_edit",
  "Invalid message request": "invalid_message_request",
  "Invalid moderation request": "invalid_moderation_request",
  "Invalid request": "invalid_request",
  "Invalid roles update request": "invalid_roles_update",
  "Invalid sync request": "invalid_sync_request",
  "Invalid token": "invalid_token",
  "Invalid user update request": "invalid_user_update",
  "Message does not exist": "message_not_found",
  "Moderator access required": "moderator_required",
  "Not found": "not_found",
  "Only pending users can be denied": "deny_requires_pending",
  "Only people can be admins": "admin_humans_only",
  "Only private channels have a member list": "member_list_private_only",
  "Only the channel owner or an admin can change this channel": "channel_change_forbidden",
  "Only the channel owner or an admin can invite members": "member_invite_forbidden",
  "Only the channel owner or an admin can remove members": "member_remove_forbidden",
  "Only the channel owner or an admin can transfer ownership": "channel_transfer_forbidden",
  "Parent message belongs to a different channel": "parent_wrong_channel",
  "Parent message does not exist": "parent_not_found",
  "Private channels are disabled on this LOAM node": "private_channels_disabled",
  "Provide a search query (?q=)": "search_query_required",
  "Reactions are disabled on this LOAM node": "reactions_disabled",
  "Reactions cannot be edited": "reaction_not_editable",
  "Recipient user does not exist": "recipient_not_found",
  "Replies are disabled on this LOAM node": "replies_disabled",
  "Target message does not exist": "target_not_found",
  "That user has been removed from this node": "user_removed",
  "That user is not a member of this channel": "not_channel_member",
  "The channel owner cannot be removed from their own channel": "owner_not_removable",
  "The kill switch is not enabled on this LOAM node": "kill_switch_disabled",
  "The passphrase bootstrap strategy requires a passphrase": "passphrase_required",
  "This message is still being written": "message_streaming",
  "This session is no longer valid": "session_invalid",
  "This thread has replies from other people — only an admin can delete it": "thread_has_replies",
  "Too many attempts": "too_many_attempts",
  "Too many claim attempts; try again later": "too_many_claim_attempts",
  "Unable to create message": "message_create_failed",
  "Unauthenticated websocket": "websocket_unauthenticated",
  "Unknown attachment": "unknown_attachment",
  "User avatar uploads are disabled on this LOAM node": "user_avatar_upload_disabled",
  "User does not exist": "user_not_found",
  "User profile editing is disabled on this LOAM node": "user_profile_edit_disabled",
  "You can only delete your own messages": "delete_own_only",
  "You can only edit your own messages": "edit_own_only",
  "You cannot deny an admin or yourself": "deny_forbidden",
  "You cannot moderate an admin or yourself": "moderate_forbidden",
  // Participation gate (banned/pending) and channel-posting policy — these are returned via
  // participationError()/channelPostingError() and must localize like every other error.
  "You have been removed from this node": "removed_from_node",
  "Your join is awaiting approval": "awaiting_approval",
  "Channel is archived": "channel_archived",
  "Replies are disabled in this channel": "channel_replies_disabled",
  "Only the channel owner can post in this channel": "channel_owner_post_only",
  "Only admins can post in this channel": "channel_admins_post_only",
};

/** All stable error codes actually in use, exported so tests can assert client-catalog coverage. */
export const ALL_ERROR_CODES: readonly ServerErrorCode[] = Object.values(ERROR_CODES);

/**
 * Build an error response envelope, attaching the stable `code` for known messages. Unknown messages
 * carry no code, so the client falls back to the English `error` string. The `error` field is always
 * present and unchanged, so existing clients keep working.
 */
export function errorBody(message: string | undefined): { error: string; code?: string } {
  const text = message ?? "Unknown error";
  const code = ERROR_CODES[text];
  return code ? { error: text, code } : { error: text };
}
