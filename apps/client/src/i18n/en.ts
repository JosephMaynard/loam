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
  "members.makeOwner": "Make owner",
  "members.transferConfirm": "Transfer ownership to this person? You'll no longer be the owner.",
  "members.transferError": "Unable to transfer ownership.",
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

  // Settings view (join panel, profile, avatar, device wipe, admin access).
  "settings.profileError": "Unable to update profile.",
  "settings.joinEyebrow": "Local access",
  "settings.joinTitle": "Join this LOAM node",
  "settings.thisBrowser": "This browser",
  "settings.profileEyebrow": "Profile",
  "settings.profileTitle": "Local identity",
  "settings.displayName": "Display name",
  "settings.avatarStyle": "Avatar style",
  "settings.newAvatar": "New avatar",
  "settings.saveProfile": "Save profile",
  "settings.imageAvatarEyebrow": "Image avatar",
  "settings.cropUpload": "Crop upload",
  "settings.avatarUploadDisabled": "Image avatar uploads are disabled on this LOAM node.",
  "settings.profileEditingDisabled": "Profile editing is disabled on this LOAM node.",
  "settings.securityEyebrow": "Security",
  "settings.wipeTitle": "Wipe this device",
  "settings.wipeBody":
    "Erases this browser's local copy — messages, your identity, and cached data. It does not wipe the node or anyone else's device.",
  "settings.wipeConfirmBefore": "Type",
  "settings.wipeConfirmAfter": "to confirm",
  "settings.wiping": "Wiping…",
  "settings.adminEyebrow": "Administration",
  "settings.adminTools": "Admin tools",
  "settings.adminAccess": "Admin access",
  "settings.openAdmin": "Open the admin area →",
  "settings.claimLabel": "Setup code or passphrase",
  "settings.checking": "Checking",
  "settings.unlockAdmin": "Unlock admin",
  "settings.claimError": "Unable to claim admin access.",
  "settings.claimDisabled": "Admin claiming is not enabled on this LOAM node.",

  "common.refresh": "Refresh",

  // People view + greeter pending-approvals panel.
  "people.eyebrow": "People",
  "people.notAuthorizedTitle": "Not authorized",
  "people.notAuthorizedNote": "This area is for greeters, moderators, and admins.",
  "people.title": "People and moderation",
  "people.accessEyebrow": "Access",
  "people.pendingTitle": "Pending joins",
  "people.pendingLoadError": "Unable to load pending joins.",
  "people.pendingLoading": "Loading pending joins…",
  "people.pendingEmpty": "Nobody is waiting to join.",
  "people.approve": "Approve",
  "people.deny": "Deny",

  // Moderation panel + roster rows + state badges.
  "moderation.updateError": "Unable to update this person.",
  "moderation.loadError": "Unable to load people.",
  "moderation.eyebrow": "Moderation",
  "moderation.heading": "People",
  "moderation.loading": "Loading people…",
  "moderation.empty": "No people to show yet.",
  "moderation.promoteConfirm":
    "Make {name} an admin? Admin access can't be revoked from here — only by re-setting up the node.",
  "moderation.thatsYou": "That's you.",
  "moderation.adminsProtected": "Admins can't be moderated.",
  "moderation.roleModerator": "Moderator",
  "moderation.roleGreeter": "Greeter",
  "moderation.ban": "Ban",
  "moderation.unban": "Unban",
  "moderation.shadowban": "Shadow-ban",
  "moderation.unshadowban": "Un-shadow-ban",
  "moderation.makeAdmin": "Make admin",
  "moderation.badgeAdmin": "Admin",
  "moderation.badgePending": "Pending",
  "moderation.badgeBanned": "Banned",
  "moderation.badgeShadow": "Shadow-banned",

  // Admin view — feature-flag labels.
  "admin.flagPublicChannels": "Public channels",
  "admin.flagPrivateChannels": "Private channels (invite-only)",
  "admin.flagUserChannels": "User-created channels",
  "admin.flagReplies": "Thread replies",
  "admin.flagDMs": "Direct messages",
  "admin.flagReactions": "Reactions",
  "admin.flagMarkdown": "Markdown rendering",
  "admin.flagAttachments": "Image attachments",
  "admin.flagPresence": "Online presence (reveals who is connected — off for high-risk use)",
  // Admin view — identity-permission labels.
  "admin.identityDisplayName": "Users can edit their display name",
  "admin.identityAvatarEdit": "Users can edit their avatar",
  "admin.identityAvatarUpload": "Users can upload avatar images",
  "admin.identityAdminEdit": "Admins can edit other users",
  // Admin view — security profile titles + summaries.
  "admin.profileOpenTitle": "Open",
  "admin.profileOpenSummary":
    "Anyone joins and posts immediately. Messages are kept and the kill switch is off — maximum access, for disaster-relief style use.",
  "admin.profileStandardTitle": "Standard",
  "admin.profileStandardSummary":
    "Anyone with the join link participates; messages are kept and the kill switch is off. (Same enforced settings as Open until transport encryption lands.)",
  "admin.profileHardenedTitle": "Hardened",
  "admin.profileHardenedSummary":
    "New joiners must be approved, messages expire after 1 hour, and the kill switch is armed. For high-risk use.",
  "admin.profileCustomTitle": "Custom",
  "admin.profileCustomSummary":
    "Set who can join, message retention, and the kill switch individually in the sections below.",
  // Admin view — errors + shell.
  "admin.configInvalid": "Received an invalid config payload from the server.",
  "admin.configLoadError": "Unable to load the node config.",
  "admin.configUpdateFailed": "Config update failed: {status}",
  "admin.configUnrecognised": "The server accepted the update but returned an unrecognised config payload.",
  "admin.configSaveError": "Unable to save the node config.",
  "admin.killSwitchFailed": "Kill switch failed: {status}",
  "admin.killSwitchError": "Unable to trigger the kill switch.",
  "admin.eyebrow": "Admin",
  "admin.notAuthorizedNote":
    "This area is for node administrators. Claim admin access from the settings page if this node allows it.",
  "admin.title": "Node configuration",
  "admin.loading": "Loading node config…",
  // Admin view — getting-started panel.
  "admin.gettingStartedEyebrow": "Getting started",
  "admin.gettingStartedTitle": "Run your network in five steps",
  "admin.step1Title": "Name it",
  "admin.step1Body": "set a Network name below so joiners recognise where they are.",
  "admin.step2Title": "Choose a posture",
  "admin.step2Body":
    "pick a Security profile (Open for relief, Hardened for high-risk), or Custom to tune each control.",
  "admin.step3Title": "Invite people",
  "admin.step3Body":
    "share the join QR from the sidebar; under an Approval policy, greeters let newcomers in from People & moderation.",
  "admin.step4Title": "Set your team",
  "admin.step4Body": "grant moderator/greeter roles or promote a co-admin in People & moderation.",
  "admin.step5Title": "Grow the mesh",
  "admin.step5Body": "to cover more than one hotspot, enable Node-to-node sync and link another host by QR.",
  "admin.gettingStartedNoteBefore": "Everything here is optional and reversible. See the",
  "admin.gettingStartedGuideLink": "operator's guide",
  "admin.gettingStartedNoteAfter": "for the full walkthrough.",
  // Admin view — identity/network panel + language.
  "admin.networkEyebrow": "Network",
  "admin.identityHeading": "Identity",
  "admin.networkName": "Network name",
  "admin.networkNameNote":
    "Shown to everyone who joins — in the sidebar and on the join screen. Give your network a name people will recognise (e.g. \"Riverside Relief\").",
  "admin.language": "Interface language",
  "admin.languageNote": "Applies to everyone's interface on this node.",
  // Admin view — security profile panel.
  "admin.profileHeading": "Profile",
  "admin.posture": "Posture",
  "admin.whoCanJoin": "Who can join",
  "admin.joinOpen": "Open — anyone with the link joins",
  "admin.joinApproval": "Approval — a greeter or admin lets people in",
  "admin.axesManaged":
    "Access, retention, and the kill switch are managed by the {profile} profile. Switch to {custom} to edit them individually.",
  // Admin view — features + identity panels.
  "admin.featuresEyebrow": "Features",
  "admin.messagingHeading": "Messaging",
  "admin.identityEyebrow": "Identity",
  "admin.profilesHeading": "Profiles",
  // Admin view — LLM panel.
  "admin.llmEyebrow": "LLM",
  "admin.llmHeading": "Assistant (Ollama)",
  "admin.llmEnable": "Enable the LLM assistant",
  "admin.llmBaseUrl": "Ollama base URL",
  "admin.llmModel": "Model",
  "admin.llmBotName": "Bot display name",
  "admin.llmSystemPrompt": "System prompt (optional)",
  "admin.llmOnDeviceEnable": "Run the model on this device (Android host only)",
  "admin.llmOnDeviceModel": "On-device model name",
  "admin.llmOnDeviceNote": "Runs a small model on the phone itself instead of a laptop's Ollama. Works only on the Android host with a compatible model file added on-device (never shipped); a no-op elsewhere. Off by default.",
  // Admin view — retention panel.
  "admin.privacyEyebrow": "Privacy",
  "admin.retentionHeading": "Message retention",
  "admin.retentionLabel": "Delete messages after (minutes; blank = keep forever)",
  "admin.retentionNote":
    "Expired messages are deleted from the node and from connected clients (checked every 30 seconds). The proactive companion to the kill switch below.",
  // Admin view — kill switch panel.
  "admin.safetyEyebrow": "Safety",
  "admin.killSwitchHeading": "Kill switch",
  "admin.killSwitchEnable": "Enable the kill switch (instant wipe of all node data)",
  "admin.killSwitchRequireConfirm": "Require typed confirmation before firing",
  "admin.panicToken":
    "Panic token (optional, min 16 chars; enables unauthenticated POST /api/panic; leave blank to keep the current one)",
  "admin.killSwitchWarning":
    "Firing the kill switch permanently deletes all messages, users, sessions, and avatars on this node and remotely purges every connected client. Node settings survive.",
  "admin.killSwitchConfirmBefore": "Type",
  "admin.killSwitchConfirmAfter": "to arm the button",
  "admin.wipeNow": "Wipe this node now",
  // Admin view — sync panel.
  "admin.syncHeading": "Node-to-node sync",
  "admin.syncEnable": "Sync public channels with peer nodes",
  "admin.syncNote":
    "Pull-based: this node fetches public channels, their messages, and profiles from each peer. DMs and private channels never leave a node. A peer's join URL (from its join QR) is its sync address. Enabling this also lets peers pull this node's public content.",
  "admin.syncTokenLabel": "Shared mesh token",
  "admin.syncTokenPlaceholder": "Leave blank for open sync",
  "admin.syncTokenGenerate": "Generate",
  "admin.syncTokenNote": "When set, only peers presenting this exact token can sync. Give every node in your mesh the same token.",
  "admin.noPeers": "No peers yet.",
  "admin.peerChangesNote": "Peer changes apply when you save the node config below.",
  // Admin view — bootstrap panel.
  "admin.bootstrapEyebrow": "Admin access",
  "admin.bootstrapHeading": "Bootstrap",
  "admin.strategy": "Strategy",
  "admin.newPassphrase": "New admin passphrase (min 8 chars; leave blank to keep the current one)",
  "admin.bootstrapNote": "The setup-code strategy prints a one-time claim code in the server logs at startup.",
  "admin.saveConfig": "Save node config",
  "admin.saved": "Saved. Connected clients pick the change up live.",
  // Add-a-peer control.
  "admin.peerUrl": "Peer URL (its join URL)",
  "admin.peerLabel": "Label (optional)",
  "admin.peerLabelPlaceholder": "e.g. Depot Pi",
  "admin.addPeer": "Add peer",
  // Sync status panel.
  "admin.syncStatusUnrecognised": "The server returned an unrecognised sync status payload.",
  "admin.syncStatusLoadError": "Unable to load sync status.",
  "admin.syncFailed": "Sync failed: {status}",
  "admin.syncRunError": "Unable to run sync.",
  "admin.syncStatusEyebrow": "Status (saved peers)",
  "admin.syncing": "Syncing…",
  "admin.syncNow": "Sync now",
  "admin.peerError": "Error: {error}",
  "admin.peerLastSyncedAt": "Last synced {time}",
  "admin.peerImported": { one: "{n} message imported", other: "{n} messages imported" },
  "admin.peerNotSynced": "Not synced yet",
  // Channel management.
  "admin.channelUnrecognised": "The server returned an unrecognised channel payload.",
  "admin.channelsLoadError": "Unable to load channels.",
  "admin.channelCreateError": "Unable to create the channel.",
  "admin.channelsEyebrow": "Channels",
  "admin.createChannelHeading": "Create a channel",
  "admin.channelName": "Name",
  "admin.channelNamePlaceholder": "e.g. Logistics",
  "admin.channelDescription": "Description (optional)",
  "admin.whoCanPost": "Who can post",
  "admin.postEveryone": "Everyone",
  "admin.postAdmins": "Admins only",
  "admin.allowReplies": "Allow threaded replies",
  "admin.channelPrivate": "Private (invite-only; you start as the only member)",
  "admin.creating": "Creating…",
  "admin.createChannel": "Create channel",
  "admin.existingChannels": "Existing channels",
  "admin.channelsLoading": "Loading channels…",
  "admin.channelsEmpty": "No channels yet. Create one above.",
  "admin.channelUpdateError": "Unable to update the channel.",
  "admin.channelNameAria": "Channel name for {name}",
  "admin.metaAdminsPost": "Admins post",
  "admin.metaOpenPosting": "Open posting",
  "admin.metaPrivate": "Private",
  "admin.metaArchived": "Archived",
  "admin.rename": "Rename",
  "admin.restore": "Restore",
  "admin.archive": "Archive",

  // Sidebar.
  "sidebar.channels": "Channels",
  "sidebar.dms": "Direct Messages",
  "sidebar.online": "Online",
  "sidebar.searchMessages": "Search messages",
  "sidebar.meshMail": "Mesh mail",
  "sidebar.settings": "Join QR and settings",
  "sidebar.statusConnecting": "connecting",
  "sidebar.statusLive": "live",
  "sidebar.statusOffline": "offline",

  // New-channel control (sidebar).
  "newChannel.new": "+ New channel",
  "newChannel.nameAria": "New channel name",
  "newChannel.namePlaceholder": "Channel name",
  "newChannel.private": "Private (invite-only)",
  "newChannel.create": "Create",

  // Search view.
  "search.error": "Unable to search messages.",
  "search.dmWith": "DM with {name}",
  "search.eyebrow": "Search",
  "search.title": "Find messages",
  "search.placeholder": "Search channel messages and your DMs",
  "search.searching": "Searching…",
  "search.button": "Search",
  "search.noResults": "No messages matched.",

  // Mesh mail view (opportunistic-mesh sealed mailbox — docs/16).
  "mesh.eyebrow": "Mesh mail",
  "mesh.title": "Mesh mail",
  "mesh.myCardEyebrow": "Your address",
  "mesh.myCardTitle": "Your mesh card",
  "mesh.myCardNote": "Share this with someone you want to receive sealed mail from — scan the code or copy it and send it however you like.",
  "mesh.myCardLoading": "Loading your mesh card…",
  "mesh.myCardLoadError": "Unable to load your mesh card.",
  "mesh.myCardUnrecognised": "The server returned an unrecognised mesh card.",
  "mesh.myCardQrTooLarge": "This card is too long for a QR code here — copy it instead.",
  "mesh.copyCard": "Copy card",
  "mesh.copyCardCopied": "Copied",
  "mesh.addContactEyebrow": "Add a contact",
  "mesh.addContactTitle": "Add a contact's card",
  "mesh.addContactPlaceholder": "Paste a mesh card someone shared with you",
  "mesh.addContactButton": "Add contact",
  "mesh.addContactAdding": "Adding…",
  "mesh.addContactSuccess": "Contact added.",
  "mesh.addContactError": "Unable to add this contact.",
  "mesh.addContactInvalidJson": "That doesn't look like a valid mesh card.",
  "mesh.contactsEyebrow": "Contacts",
  "mesh.contactsTitle": "Your mesh contacts",
  "mesh.contactsLoading": "Loading contacts…",
  "mesh.contactsLoadError": "Unable to load your contacts.",
  "mesh.contactsEmpty": "You haven't added any mesh contacts yet.",
  "mesh.composeShow": "Send mail",
  "mesh.composeHide": "Close",
  "mesh.composePlaceholder": "Write a sealed message",
  "mesh.composeReplyNote": "Replies arrive as an ordinary direct message.",
  "mesh.composeSend": "Send",
  "mesh.composeSending": "Sending…",
  "mesh.composeSuccess": "Sealed and queued for delivery.",
  "mesh.composeError": "Unable to send this message.",

  // Invite control (sidebar).
  "invite.hide": "× Hide invite",
  "invite.show": "⧉ Invite someone",

  // Node-link control (admin sync panel).
  "nodeLink.hide": "× Hide link",
  "nodeLink.show": "⧉ Link another node",
  "nodeLink.note":
    "On the other node's admin screen, enable sync and add this address as a peer (scan the code or paste the URL).",
  "nodeLink.copied": "Copied",
  "nodeLink.copy": "Copy address",

  // Unread badge.
  "unreadBadge.label": "{n} unread",

  // Avatar image crop/upload editor (settings).
  "avatarEditor.loadError": "Unable to load image.",
  "avatarEditor.uploadError": "Unable to upload avatar.",
  "avatarEditor.tooLarge": "Avatar image is too large after resizing.",
  "avatarEditor.cropPreview": "Avatar crop preview",
  "avatarEditor.chooseImage": "Choose image",
  "avatarEditor.uploading": "Uploading",
  "avatarEditor.useCropped": "Use cropped image",
  "avatarEditor.zoom": "Zoom",
  "avatarEditor.rotate": "Rotate",
  "avatarEditor.invalidType": "Choose a PNG, JPEG, or WebP image.",

  // App-level error fallbacks.
  "app.userUnrecognised": "The server returned an unrecognised user payload.",
  "app.deleteError": "Unable to delete the message.",
  "app.editError": "Unable to edit the message.",
  "app.sendError": "Unable to send the message.",
  "app.sendInvalidJson": "Message send failed: invalid JSON response.",
  "app.sendInvalidPayload": "Message send failed: invalid response payload.",
  "app.attachmentUnrecognised": "The server returned an unrecognised attachment payload.",
  "app.serverUnreachable": "Unable to reach the LOAM server.",
  "app.messagesLoadError": "Unable to load messages.",

  // Full-screen gate states (wiped / disconnected / banned / pending).
  "gate.deviceWipedTitle": "Device wiped",
  "gate.deviceWipedBody": "This browser's local copy has been erased. Scan the join QR to reconnect.",
  "gate.disconnectedTitle": "Disconnected",
  "gate.disconnectedBody": "This node is no longer available.",
  "gate.bannedTitle": "Removed from this node",
  "gate.bannedBody": "A moderator has removed you. You can no longer post or read here.",
  "gate.pendingTitle": "You're in the queue",
  "gate.pendingBody":
    "Waiting for someone on this node to let you in. This screen updates the moment you're approved.",
  "gate.connection": "Connection: {status}",

  // Confirmation dialogs.
  "confirm.deleteMessage": "Delete this message? This can't be undone.",

  // Server error codes (localized from the {error, code} envelope; English mirrors the server text).
  "error.admin_required": "Admin access required",
  "error.admin_claim_disabled": "Admin claiming is not enabled on this LOAM node",
  "error.admin_user_edit_disabled": "Admin user editing is disabled on this LOAM node",
  "error.promote_requires_active": "Approve or unban this user before promoting them",
  "error.attachment_not_found": "Attachment does not exist",
  "error.attachment_too_large": "Attachment image must be 256KB or smaller",
  "error.attachment_type_mismatch": "Attachment image type does not match the uploaded data",
  "error.attachments_disabled": "Attachments are disabled on this LOAM node",
  "error.avatar_not_found": "Avatar image does not exist",
  "error.avatar_too_large": "Avatar image must be 128KB or smaller",
  "error.avatar_type_mismatch": "Avatar image type does not match the uploaded data",
  "error.roles_admin_immutable": "Cannot change the roles of an admin",
  "error.reaction_not_allowed": "Cannot react to this message",
  "error.channel_not_found": "Channel does not exist",
  "error.removed_from_node": "You have been removed from this node",
  "error.awaiting_approval": "Your join is awaiting approval",
  "error.channel_archived": "This channel is archived",
  "error.channel_replies_disabled": "Replies are disabled in this channel",
  "error.channel_owner_post_only": "Only the channel owner can post in this channel",
  "error.channel_admins_post_only": "Only admins can post in this channel",
  "error.channel_posting_disabled": "Channel posting is disabled on this LOAM node",
  "error.channel_create_disabled": "Creating channels is disabled on this LOAM node",
  "error.confirmation_required": "Confirmation required: send { \"confirm\": \"wipe\" }",
  "error.dms_disabled": "Direct messages are disabled on this LOAM node",
  "error.sync_requires_peer": "Enable sync and add at least one peer first",
  "error.greeter_required": "Greeter access required",
  "error.invalid_admin_claim": "Invalid admin claim request",
  "error.invalid_admin_secret": "Invalid admin secret",
  "error.invalid_attachment_upload": "Invalid attachment upload request",
  "error.invalid_avatar_upload": "Invalid avatar image upload request",
  "error.invalid_channel_create": "Invalid channel create request",
  "error.invalid_channel_update": "Invalid channel update request",
  "error.invalid_config_update": "Invalid config update request",
  "error.invalid_config_values": "Invalid config values",
  "error.invalid_kill_switch": "Invalid kill-switch request",
  "error.invalid_member_request": "Invalid member request",
  "error.invalid_transfer_request": "Invalid transfer request",
  "error.invalid_message_edit": "Invalid message edit request",
  "error.invalid_message_request": "Invalid message request",
  "error.invalid_moderation_request": "Invalid moderation request",
  "error.invalid_request": "Invalid request",
  "error.invalid_roles_update": "Invalid roles update request",
  "error.invalid_sync_request": "Invalid sync request",
  "error.invalid_token": "Invalid token",
  "error.invalid_user_update": "Invalid user update request",
  "error.message_not_found": "Message does not exist",
  "error.moderator_required": "Moderator access required",
  "error.not_found": "Not found",
  "error.deny_requires_pending": "Only pending users can be denied",
  "error.admin_humans_only": "Only people can be admins",
  "error.member_list_private_only": "Only private channels have a member list",
  "error.channel_change_forbidden": "Only the channel owner or an admin can change this channel",
  "error.member_invite_forbidden": "Only the channel owner or an admin can invite members",
  "error.member_remove_forbidden": "Only the channel owner or an admin can remove members",
  "error.channel_transfer_forbidden": "Only the channel owner or an admin can transfer ownership",
  "error.parent_wrong_channel": "Parent message belongs to a different channel",
  "error.parent_not_found": "Parent message does not exist",
  "error.private_channels_disabled": "Private channels are disabled on this LOAM node",
  "error.search_query_required": "Provide a search query (?q=)",
  "error.reactions_disabled": "Reactions are disabled on this LOAM node",
  "error.reaction_not_editable": "Reactions cannot be edited",
  "error.recipient_not_found": "Recipient user does not exist",
  "error.replies_disabled": "Replies are disabled on this LOAM node",
  "error.target_not_found": "Target message does not exist",
  "error.user_removed": "That user has been removed from this node",
  "error.not_channel_member": "That user is not a member of this channel",
  "error.owner_not_removable": "The channel owner cannot be removed from their own channel",
  "error.kill_switch_disabled": "The kill switch is not enabled on this LOAM node",
  "error.passphrase_required": "The passphrase bootstrap strategy requires a passphrase",
  "error.message_streaming": "This message is still being written",
  "error.session_invalid": "This session is no longer valid",
  "error.thread_has_replies": "This thread has replies from other people — only an admin can delete it",
  "error.too_many_attempts": "Too many attempts",
  "error.too_many_claim_attempts": "Too many claim attempts; try again later",
  "error.message_create_failed": "Unable to create message",
  "error.websocket_unauthenticated": "Unauthenticated websocket",
  "error.unknown_attachment": "Unknown attachment",
  "error.user_avatar_upload_disabled": "User avatar uploads are disabled on this LOAM node",
  "error.user_not_found": "User does not exist",
  "error.user_profile_edit_disabled": "User profile editing is disabled on this LOAM node",
  "error.delete_own_only": "You can only delete your own messages",
  "error.edit_own_only": "You can only edit your own messages",
  "error.deny_forbidden": "You cannot deny an admin or yourself",
  "error.moderate_forbidden": "You cannot moderate an admin or yourself",
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
