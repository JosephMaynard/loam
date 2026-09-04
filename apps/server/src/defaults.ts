// Seed data and small tunables shared across the server. Extracted from app.ts (2026-09-04 split).
import type { Channel } from "@loam/schema";

export const sessionCookieName = "loam_session";

export const sessionCookieMaxAge = 60 * 60 * 24 * 365;

export const defaultChannelCreatedAt = 1_704_067_200_000;

export const claimAttemptLimit = 5;

export const claimAttemptWindowMs = 5 * 60_000;

// Default for `AppOptions.tombstoneHorizonMs` (docs/15 #7): how long a tombstone blocks re-import
// before it's GC'd. Deliberately generous — far longer than any realistic sync/courier interval —
// so within the horizon a deleted message can never resurface from a peer or a mesh carrier; only
// a peer offline longer than this window can hand it back, an accepted DTN limitation (not gated
// on `sync.enabled`: a delete made while sync is off must still stick once a peer/mesh link
// appears later, or moderation is bypassable).
export const defaultTombstoneHorizonMs = 30 * 24 * 60 * 60 * 1000;

export const defaultChannels: Channel[] = [
  {
    id: "announcements",
    name: "Announcements",
    description: "Local broadcast notes and coordination updates.",
    visibility: "public",
    allowPosting: "everyone",
    allowReplies: true,
    discoverable: true,
    createdAt: defaultChannelCreatedAt,
  },
  {
    id: "general",
    name: "General",
    description: "Open room for everyone on this local LOAM node.",
    visibility: "public",
    allowPosting: "everyone",
    allowReplies: true,
    discoverable: true,
    createdAt: defaultChannelCreatedAt,
  },
];

/** Fixed ids of the legacy demo users early builds planted so a fresh node had example DM contacts. A
 * live node must never ship fake users, so these are no longer seeded — and any that a pre-existing DB
 * still carries are removed at boot (see the cleanup in the store initializer). Real users are always
 * `user.<hex>`, so these constant ids are unambiguously the old seeds and safe to delete. */
export const legacyDemoUserIds = ["user.1234", "user.5678"];

/** Upper bound on how many of the most-recent DM messages between a user and the LLM bot are sent to the
 * model as context on each turn (see `llmMessagesForUser`). Prevents an unbounded history from growing the
 * request every turn and overflowing the model's context window. Deliberately generous — most models hold
 * far more, and dropping the oldest turns preserves what matters. */
export const MAX_LLM_CONTEXT_MESSAGES = 40;
