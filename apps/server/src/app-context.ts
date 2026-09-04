// The composition seam of the server (2026-09-04 split). `buildApp` builds ONE object of this shape —
// its remaining closure state (accessor-backed, so writes land on the live bindings), its domain helpers,
// and the extracted subsystems — and hands it to every route/transport/realtime/kill-switch module.
// The member list is generated from app.ts's declarations; keep it in step when a helper's signature
// changes (the type-checker will tell you).
import type { TransportIdentity } from "@loam/crypto";
import type { AdminBootstrapStrategy, AvatarImageMimeType, Channel, ChannelCreateRequest, ChannelUpdateRequest, LoamConfig, LoamConfigUpdate, Message, MessageCreateRequest, NetworkConfig, StreamEvent, TransportEncryption, User, UserUpdateRequest } from "@loam/schema";
import type { LoamStore } from "./db.js";
import type { KillSwitchResult } from "./kill-switch.js";
import { createLlmLayer } from "./llm.js";
import type { MeshLayer } from "./mesh.js";
import type { Runtime } from "./runtime.js";
import { type DbKeyState, createStoreLifecycle } from "./store-lifecycle.js";
import { createSyncEngine } from "./sync.js";
import type { TransportSession } from "./transport-server.js";
import type { AppData, AppOptions, ClientEvent, SocketSession } from "./types.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export type AppContext = {
  server: FastifyInstance;
  options: AppOptions;
  dataDir: string;
  avatarsDir: string;
  attachmentsDir: string;
  configPath: string;
  resolveLanAddress: () => string;
  clientPort: number;
  devModeRequested: boolean;
  isProductionBuild: boolean;
  devMode: boolean;
  LARGE_BODY_LIMIT: number;
  sockets: Set<SocketSession>;
  unconfirmedByIp: Map<string, number>;
  pendingSockets: Set<{ userId: string; close: () => void }>;
  sessions: Map<string, string>;
  claimAttempts: Map<string, { count: number; resetAt: number }>;
  panicAttempts: Map<string, { count: number; resetAt: number }>;
  transportSessions: Map<string, TransportSession>;
  identityTokens: Map<string, string>;
  TRANSPORT_SESSION_TTL_MS: number;
  TRANSPORT_REPLAY_WINDOW: number;
  TRANSPORT_SESSION_CAP: number;
  transportRequestKeys: WeakMap<FastifyRequest, string>;
  transportRequestSessions: WeakMap<FastifyRequest, TransportSession>;
  transportRequestSeq: WeakMap<FastifyRequest, number>;
  transportRequestSyncToken: WeakMap<FastifyRequest, string>;
  internalTunnelToken: string;
  identityMintCounters: Map<string, { count: number; resetAt: number }>;
  maxNewIdentitiesPerWindow: number;
  identityWindowMs: number;
  tombstoneHorizonMs: number;
  attachmentOwners: Map<string, { userId: string; uploadedAt: number }>;
  attachmentPendingGraceMs: number;
  tombstones: Set<string>;
  syncedChannelIds: Set<string>;
  BASE64URL_RE: RegExp;
  DIRECT_SEALED_SYNC_ROUTES: Set<string>;
  MESH_LOOPBACK_BRIDGE_ROUTES: Set<string>;
  dbState: DbKeyState;
  lifecycle: ReturnType<typeof createStoreLifecycle>;
  rt: Runtime;
  llm: ReturnType<typeof createLlmLayer>;
  mesh: MeshLayer;
  sync: ReturnType<typeof createSyncEngine>;
  transportIdentity: TransportIdentity | undefined;
  wipeGeneration: number;
  wipeInProgress: boolean;
  wipeInFlight: Promise<KillSwitchResult> | undefined;
  awaitingWipeRestart: boolean;
  staticFilesRegistered: boolean;
  appConfig: LoamConfig;
  adminSetupCode: string | undefined;
  data: AppData;
  store: LoamStore;
  currentJoinHost(): string;
  isInternalTunnelRequest(request: FastifyRequest): boolean;
  tunnelBoundUserId(request: FastifyRequest): string | undefined;
  acceptTransportSeq(session: TransportSession, seq: number): boolean;
  effectiveTransportEncryption(): TransportEncryption;
  effectiveAdminBootstrap(): AdminBootstrapStrategy;
  presentsHostToken(request: FastifyRequest): boolean;
  parseConfigUpdate(raw: string, source: string): LoamConfigUpdate;
  loadAppConfig(): Promise<void>;
  anyAdminExists(): boolean;
  consumeIdentityBudget(ip: string): boolean;
  getSessionUserId(request: FastifyRequest, reply: FastifyReply): string;
  getSessionUserIdFromRequest(request: FastifyRequest): string | undefined;
  ensureUser(id: string, isAdmin?: boolean, pending?: boolean): User;
  ensureSessionUser(id: string): User;
  currentNetworkConfig(): NetworkConfig;
  redactedConfig(): LoamConfig;
  isValidTransportIdentity(value: unknown): value is TransportIdentity;
  ensureTransportIdentity(): TransportIdentity;
  rotateTransportIdentity(): void;
  transportSessionForRequest(request: FastifyRequest): TransportSession | undefined;
  wsTransportSession(url: string): TransportSession | undefined;
  requiresTransportSession(request: FastifyRequest): boolean;
  applyUserUpdate(user: User, update: UserUpdateRequest): User;
  canModerate(user: User): boolean;
  canGreet(user: User): boolean;
  isLocallyAuthoritative(userId: string): boolean;
  participationError(user: User): string | undefined;
  timeoutError(user: User): string | undefined;
  applyUserModeration(
  user: User,
  changes: Partial<Pick<User, "roles" | "banned" | "shadowBanned" | "pending" | "timeoutUntil">>,
): User;
  invalidateUserSessions(userId: string): void;
  closeSocketsForTransportSession(sid: string): void;
  revokeIdentityToken(tokenHash: string): string | undefined;
  applyChannelUpdate(channel: Channel, update: ChannelUpdateRequest): Channel;
  publicUser(user: User): User;
  rolesVisibleUser(user: User): User;
  sanitizeUserFor(viewer: User, user: User): User;
  isMeshSentinelUser(id: string): boolean;
  meshSenderVisibleTo(meshId: string, viewerId: string): boolean;
  visibleUsers(viewer: User): User[];
  avatarImagePath(imageId: string, mimeType: AvatarImageMimeType): string;
  ensureChannel(id: string): Channel | undefined;
  uniqueChannelId(name: string): string;
  channelMemberIds(channel: Channel): Set<string>;
  canAccessChannel(channel: Channel, userId: string): boolean;
  createChannelFromRequest(input: ChannelCreateRequest, ownerId: string): Channel;
  applyChannelMembers(channel: Channel, memberUserIds: string[]): Channel;
  channelPostingError(channel: Channel, authorId: string, isReply: boolean): string | undefined;
  messageMutationError(
  actor: User,
  target: Message,
  opts?: { adminOverride?: boolean; isDelete?: boolean },
): { code: number; error: string } | undefined;
  withoutShadowBanned(messages: Message[], viewerId: string): Message[];
  channelMessages(channelId: string, viewerId: string): Message[];
  dmMessages(peerId: string, currentUserId: string): Message[];
  messageAudienceUserIds(message: Message): Set<string> | undefined;
  socketCanReceiveEvent(userId: string, event: ClientEvent): boolean;
  wsSend(session: SocketSession, payload: string): void;
  broadcast(event: ClientEvent): void;
  onlineUserIds(): string[];
  broadcastPresence(): void;
  sendEventToUsers(audience: Set<string>, event: ClientEvent): void;
  broadcastStreamEvent(audience: Set<string>, event: StreamEvent): void;
  createMessage(
  input: MessageCreateRequest,
  authorId: string,
): { message?: Message; deletedMessage?: Message; deletedMessageId?: string; error?: string; forbidden?: boolean };
  updateMessage(message: Message, nextBody: string, streaming: boolean): Message;
  loadData(): void;
  attemptRateLimited(attempts: Map<string, { count: number; resetAt: number }>, key: string): boolean;
  pruneExpiredRateLimiters(): void;
  executeKillSwitch(): Promise<KillSwitchResult>;
  executeKillSwitchBody(): Promise<KillSwitchResult>;
  pruneTombstonesHorizon(): void;
  reapExpiredMessages(): void;
  reapOrphanedAttachments(): Promise<void>;
  reapOrphanedAvatars(): Promise<void>;
  collectDeletionSet(target: Message): Message[];
  deleteMessages(messages: Message[]): void;
  registerStaticFiles(): Promise<void>;
  semanticRateLimit(max: number): { config: { rateLimit: { max: number; timeWindow: string; allowList: () => boolean } } };
  requestFromLoopback(request: FastifyRequest): boolean;
  meshBridgeCallerAuthorized(request: FastifyRequest): boolean;
  syncPeerAuthorized(request: FastifyRequest): boolean;
};
