// The shared view the extracted server subsystems (llm.ts, mesh.ts, sync.ts) get of the app's live
// state and domain helpers (2026-09-04 split). `buildApp` builds one of these with GETTERS over its
// mutable bindings (`appConfig`, `data`, `store`, the wipe counters) so a kill-switch reopen or a config
// reload is observed immediately, plus the hoisted helper functions the subsystems call back into.
import type { FastifyBaseLogger } from "fastify";

import type { Channel, LoamConfig, Message, MessageCreateRequest, StreamEvent, User } from "@loam/schema";

import type { LoamStore } from "./db.js";
import type { AppData, AppOptions, ClientEvent } from "./types.js";

/** What `createMessage` returns: the stored message, a deleted one (a reaction toggle-off), or an error. */
export type CreateMessageResult = {
  message?: Message;
  deletedMessage?: Message;
  deletedMessageId?: string;
  error?: string;
  forbidden?: boolean;
};

export type Runtime = {
  /** The effective config (live — re-read on every access). */
  readonly appConfig: LoamConfig;
  /** The in-memory mirror (live — replaced wholesale by a wipe/reload). */
  readonly data: AppData;
  /** The open store (live — reopened by an encrypted kill switch). */
  readonly store: LoamStore;
  /** Bumped by every kill-switch wipe; a long-running pass abandons itself when it changes. */
  readonly wipeGeneration: number;
  /** True for the duration of a kill-switch wipe. */
  readonly wipeInProgress: boolean;
  log: FastifyBaseLogger;
  options: AppOptions;
  attachmentsDir: string;
  /** Message ids deliberately deleted on this node — never re-imported. */
  tombstones: Set<string>;
  /** Channel ids imported from a sync peer (C1 provenance). */
  syncedChannelIds: Set<string>;
  broadcast(event: ClientEvent): void;
  sendEventToUsers(audience: Set<string>, event: ClientEvent): void;
  broadcastStreamEvent(audience: Set<string>, event: StreamEvent): void;
  createMessage(input: MessageCreateRequest, authorId: string): CreateMessageResult;
  updateMessage(message: Message, nextBody: string, streaming: boolean): Message;
  ensureChannel(id: string): Channel | undefined;
  ensureUser(id: string, isAdmin?: boolean, pending?: boolean): User;
  publicUser(user: User): User;
  visibleUsers(viewer: User): User[];
  channelPostingError(channel: Channel, authorId: string, isReply: boolean): string | undefined;
  isLocallyAuthoritative(userId: string): boolean;
  messageAudienceUserIds(message: Message): Set<string> | undefined;
  dmMessages(peerId: string, currentUserId: string): Message[];
};
