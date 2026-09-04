
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import {
  type TransportIdentity,
} from "@loam/crypto";
import {
  ChannelSchema,
  LoamConfigUpdateSchema,
  MessageSchema,
  UserSchema,
  type AdminBootstrapStrategy,
  type AvatarImageMimeType,
  type Channel,
  type ChannelCreateRequest,
  type ChannelUpdateRequest,
  type LoamConfig,
  type LoamConfigUpdate,
  type Message,
  type MessageCreateRequest,
  type NetworkConfig,
  type TransportEncryption,
  type User,
  type UserUpdateRequest,
} from "@loam/schema";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";

import { importLegacyJsonData } from "./db.js";
import { createLlmLayer } from "./llm.js";
import { createMeshLayer } from "./mesh.js";
import type { Runtime } from "./runtime.js";
import { createStoreLifecycle } from "./store-lifecycle.js";
import type { AppContext } from "./app-context.js";
import { createKillSwitch, type KillSwitchResult } from "./kill-switch.js";
import { createRealtime, WS_MAX_INBOUND_FRAME_BYTES } from "./realtime.js";
import { registerAdminRoutes } from "./routes-admin.js";
import { registerChannelRoutes } from "./routes-channels.js";
import { registerMessageRoutes } from "./routes-messages.js";
import { registerSessionRoutes } from "./routes-session.js";
import { registerSyncMeshRoutes } from "./routes-sync-mesh.js";
import { registerUserRoutes } from "./routes-users.js";
import { createTransportServer, registerTransportHooks, registerTransportRoutes } from "./transport-server.js";
import { createSyncEngine } from "./sync.js";
import { resolveLanIPv4 } from "./net.js";

import type { AppData, AppOptions, LoamApp } from "./types.js";

import { IdentityLimitError, errorBody } from "./errors.js";
import { sessionCookieName, sessionCookieMaxAge, claimAttemptLimit, claimAttemptWindowMs, defaultTombstoneHorizonMs, defaultChannels, legacyDemoUserIds } from "./defaults.js";
import { defaultLoamConfig, mergeConfig, reconcileLegacyProfile } from "./config.js";

import { makeUser, makeSessionUserId, makeSessionToken, makeAdminSetupCode, encodeCookieValue, readCookie } from "./identity.js";
import { attachmentFileName, parseAttachmentFileName, avatarImageExtension, parseAvatarImageId } from "./media.js";
import { isChannelMessage, newMessageId } from "./ids.js";

export { ALL_ERROR_CODES } from "./errors.js";
export { defaultLoamConfig } from "./config.js";
export type { AppOptions, LoamApp, OnDeviceChatHook } from "./types.js";

/**
 * Build the LOAM Fastify application: opens the SQLite store, loads config (defaults ← config
 * file ← DB-persisted admin edits) and data, and registers every route. The caller owns
 * listening and shutdown (`close()`).
 *
 * @param options - Paths and join-URL settings; only `dataDir` is required
 * @returns The app handle with the Fastify instance, the store, and the one-time admin setup code when applicable
 */
export async function buildApp(options: AppOptions): Promise<LoamApp> {
  const dataDir = options.dataDir;
  const avatarsDir = join(dataDir, "avatars");
  const attachmentsDir = join(dataDir, "attachments");
  const configPath = options.configPath ?? join(dataDir, "config.json");
  const resolveLanAddress = options.resolveLanAddress ?? resolveLanIPv4;
  const clientPort = options.clientPort ?? 3000;

  // Developer Mode (LOAM_DEV_MODE) — a dev-only diagnostic posture: transport encryption is forced OFF
  // (plaintext on the wire, so traffic is inspectable) and logging is verbose. It is self-announcing —
  // `networkConfig.devMode` drives a persistent banner in every client warning that traffic is readable
  // on the LAN — and it REFUSES to engage in a production build (`NODE_ENV=production`), so a plaintext
  // node can never ship by accident. This is the ONLY path to plaintext now that `off` is not an
  // operator-settable posture (the default is `optional`; the admin UI omits `off`).
  const devModeRequested = process.env.LOAM_DEV_MODE === "1" || process.env.LOAM_DEV_MODE === "true";
  const isProductionBuild = process.env.NODE_ENV === "production";
  const devMode = devModeRequested && !isProductionBuild;

  /**
   * The host advertised in the join URL: an explicit `joinHost` wins outright (a caller that
   * resolved it at boot, or pinned a hostname); otherwise re-resolved on every call (docs/15 A7) so
   * the web-served QR reflects whatever's reachable right now, not whatever was up at listen() time.
   */
  function currentJoinHost(): string {
    return options.joinHost ?? resolveLanAddress();
  }

  const server = Fastify({
    // Developer Mode turns on verbose (`debug`) logging unless the caller passed an explicit logger.
    logger: options.logger ?? (devMode ? { level: "debug" } : true),
    // The global body ceiling stays at Fastify's 1 MiB default. Only the two routes that genuinely
    // carry large envelopes — `POST /api/attachments` and `POST /api/transport/tunnel` — raise it
    // per-route (`LARGE_BODY_LIMIT`); a blanket 4 MiB would hand every endpoint (including the
    // unauthenticated ones) a 4× transient-allocation amplifier on a Pi/phone host.
    serverFactory: (handler) => createServer(handler),
  });
  // Per-route body ceiling for the upload paths (Sol P2-7): the advertised 1 MiB attachment cap
  // base64-inflates (×4/3) inside its JSON envelope, and a tunnelled upload wraps that AGAIN in a
  // sealed+base64 `{ s, b }` envelope — so a 1 MiB file needs ≈2 MiB of headroom. 4 MiB keeps the
  // ceiling bounded while the real, decoded limits stay enforced semantically (avatar 128 KiB,
  // image 256 KiB, file 1 MiB).
  const LARGE_BODY_LIMIT = 4 * 1024 * 1024;
  if (devModeRequested && isProductionBuild) {
    server.log.error(
      "LOAM_DEV_MODE is set but IGNORED: refusing to disable transport encryption in a production build (NODE_ENV=production).",
    );
  }
  if (devMode) {
    server.log.warn(
      "⚠️  DEVELOPER MODE ACTIVE — transport encryption is OFF (plaintext, readable by anyone on the LAN) and logging is verbose. Never use this for real messaging; every client shows a Developer Mode banner.",
    );
  }
  const sessions = new Map<string, string>();
  const claimAttempts = new Map<string, { count: number; resetAt: number }>();
  const panicAttempts = new Map<string, { count: number; resetAt: number }>();
  // The host's static transport keypair (docs/08). Loaded/generated in loadData, persisted in the
  // config table (encrypted at rest when the DB is), rotated by the kill switch. Its public key goes
  // in the join QR + NetworkConfig.
  let transportIdentity: TransportIdentity | undefined;

  // Per-IP new-identity budget (RAM-only): bounds how many fresh anonymous users one address can mint
  // per window, so a client discarding its cookie can't grow the user table without limit. Pruned on
  // the reaper timer. On a LAN each device gets its own IP, so this reads as per-device.
  const identityMintCounters = new Map<string, { count: number; resetAt: number }>();
  const maxNewIdentitiesPerWindow = options.maxNewIdentitiesPerWindow ?? 60;
  const identityWindowMs = options.identityWindowMs ?? 10 * 60_000;
  const tombstoneHorizonMs = options.tombstoneHorizonMs ?? defaultTombstoneHorizonMs;
  // Uploaded-but-unattached attachment ids → uploader + upload time. A message may only reference
  // the uploader's own pending uploads; each id is consumed on first use. RAM-only: entries a
  // restart loses (and uploads abandoned past the grace period) are swept by
  // reapOrphanedAttachments, so unclaimed files never accumulate on disk.
  const attachmentOwners = new Map<string, { userId: string; uploadedAt: number }>();
  const attachmentPendingGraceMs = 15 * 60_000;
  // Message ids deliberately deleted on this node — node-to-node sync never re-imports these.
  const tombstones = new Set<string>();
  // Channel ids IMPORTED from a sync peer (C1 provenance) — only these are eligible for peer-driven
  // metadata re-sync, so a locally-created or default channel can never be clobbered. Loaded at boot.
  const syncedChannelIds = new Set<string>();
  // Bumped by every kill-switch wipe. A sync round captures it before its first await and abandons
  // itself the moment it changes, so an in-flight pull can't re-persist peer data onto the freshly
  // wiped store (docs/15 #2). A monotonic counter, never reset — only equality across a round matters.
  let wipeGeneration = 0;
  // True for the duration of executeKillSwitch (set before its first await, cleared in a `finally`).
  // A generation bump alone only catches a pass that was ALREADY RUNNING when a wipe starts; a pass
  // that starts partway through a wipe (e.g. between `store.close()` and the reopen) would capture the
  // POST-bump generation and see no further change, so it needs its own explicit "don't start" guard
  // (SF3) — `retryMissingAttachments` checks this before doing any work.
  let wipeInProgress = false;
  // Single-flight guard for `executeKillSwitch` (CodeRabbit round-10): the in-flight wipe promise, so
  // concurrent callers reuse it instead of racing a second destructive wipe. Cleared in its `finally`.
  let wipeInFlight: Promise<KillSwitchResult> | undefined;
  // RF1: set for the remainder of this process's life once a persistent/passphrase-encrypted node's
  // kill switch hands off to the RN launcher for a key-rotation restart (executeKillSwitchBody). The
  // ciphertext is already deleted and in-memory state is cleared at that point, but this process keeps
  // running until the launcher actually restarts it — so every route except the liveness probe must
  // refuse (503) rather than let a stale in-memory read or a surviving transport session serve content
  // in the gap between "wipe requested" and "process restarted".
  let awaitingWipeRestart = false;
  let staticFilesRegistered = false;
  let appConfig: LoamConfig = defaultLoamConfig();
  let adminSetupCode: string | undefined;

  /**
   * The transport-encryption posture actually ENFORCED and REPORTED right now — the *effective* value, not
   * the merely-stored one. In Developer Mode it is always `"off"` (plaintext) regardless of what config or
   * profile resolved to. Crucially this is a **read-time projection that never mutates `appConfig`**, so the
   * operator's real intent stays the single source of truth for persistence: a dev-mode PATCH or a
   * kill-switch re-seed can never bake `"off"` into the stored config and then leak plaintext into a later
   * NON-dev run of that same data dir (the bug an in-place override caused). `devMode` is false in any real
   * deployment (and always on the Android host), so there the effective value is exactly the configured one.
   */
  function effectiveTransportEncryption(): TransportEncryption {
    return devMode ? "off" : appConfig.security.transportEncryption;
  }

  /**
   * The admin-bootstrap strategy actually ENFORCED right now (review 2026-09-04). A launcher that hands
   * `buildApp` a per-boot `hostToken` (the Android host) forces `hostDevice`: admin is granted only to
   * the caller that presents that token via `POST /api/admin/claim`, never to "the first session". Like
   * `effectiveTransportEncryption` this is a read-time projection that never mutates `appConfig` — the
   * configured strategy stays the operator's persisted intent, and the same data dir booted without a
   * token (desktop/Pi) resolves to it unchanged. Why: the embedded server listens on every interface from
   * the moment it boots, but the host's own WebView (the operator) only reaches `/api/config` after the
   * readiness probe + bootstrap fetch + client load — under `firstUser` that gap let any LAN peer polling
   * the endpoint mint the admin identity on every fresh-DB boot (every boot in ephemeral mode).
   */
  function effectiveAdminBootstrap(): AdminBootstrapStrategy {
    return options.hostToken ? "hostDevice" : appConfig.admin.bootstrap;
  }

  /** Whether `request` presents the launcher's per-boot host token (constant-time). Always false when no
   * token was configured — callers must gate on `options.hostToken` to decide whether one is REQUIRED. */
  function presentsHostToken(request: FastifyRequest): boolean {
    const token = options.hostToken;
    const header = request.headers["x-loam-host-token"];
    if (!token || typeof header !== "string" || Buffer.byteLength(header) !== Buffer.byteLength(token)) {
      return false;
    }
    return timingSafeEqual(Buffer.from(header), Buffer.from(token));
  }

  let data: AppData = {
    users: [],
    channels: [],
    messages: [],
  };

  await mkdir(dataDir, { recursive: true });

  const lifecycle = createStoreLifecycle({
    dataDir,
    avatarsDir,
    attachmentsDir,
    options,
    configPath,
    log: server.log,
    markAwaitingWipeRestart: () => {
      awaitingWipeRestart = true;
    },
  });
  const dbState = lifecycle.state;
  const {
    resumeWipePhaseThenOpenStore,
  } = lifecycle;
  let store = resumeWipePhaseThenOpenStore();

  // ---- Subsystem composition (2026-09-04 split) ----------------------------------------------------
  // The shared `Runtime` view hands the extracted subsystems live access to the mutable app state
  // (getters, so a kill-switch reopen/reload is seen immediately) and to the domain helpers they call.
  // Function declarations below are hoisted, so referencing them here is safe.
  const rt: Runtime = {
    get appConfig() {
      return appConfig;
    },
    get data() {
      return data;
    },
    get store() {
      return store;
    },
    get wipeGeneration() {
      return wipeGeneration;
    },
    get wipeInProgress() {
      return wipeInProgress;
    },
    log: server.log,
    options,
    attachmentsDir,
    tombstones,
    syncedChannelIds,
    broadcast: (event) => broadcast(event),
    sendEventToUsers: (audience, event) => sendEventToUsers(audience, event),
    broadcastStreamEvent: (audience, event) => broadcastStreamEvent(audience, event),
    createMessage: (input, authorId) => createMessage(input, authorId),
    updateMessage: (message, nextBody, streaming) => updateMessage(message, nextBody, streaming),
    ensureChannel: (id) => ensureChannel(id),
    ensureUser: (id, isAdmin, pending) => ensureUser(id, isAdmin, pending),
    publicUser: (user) => publicUser(user),
    visibleUsers: (viewer) => visibleUsers(viewer),
    channelPostingError: (channel, authorId, isReply) => channelPostingError(channel, authorId, isReply),
    isLocallyAuthoritative: (userId) => isLocallyAuthoritative(userId),
    messageAudienceUserIds: (message) => messageAudienceUserIds(message),
    dmMessages: (peerId, currentUserId) => dmMessages(peerId, currentUserId),
  };
  const llm = createLlmLayer(rt);
  const { llmEnabled, ensureBotUser } = llm;
  const mesh = createMeshLayer(rt);
  const { meshIdentities, loadMeshIdentities, meshContacts, loadMeshContacts, ensureMeshIdentity, ensureAllMeshIdentities, reapExpiredSealed } = mesh;
  const sync = createSyncEngine(rt, mesh);

  // ---- The composition seam (2026-09-04 split) -------------------------------------------------
  // Everything the extracted modules (transport, realtime, kill switch, routes) need, as ONE object:
  // accessor-backed views of the mutable bindings above, the shared containers, the subsystems, and the
  // domain helpers (hoisted function declarations below). Modules created after this add their own
  // members via Object.assign — they are only ever dereferenced at call time.
  const base = {
    server,
    options,
    dataDir,
    avatarsDir,
    attachmentsDir,
    configPath,
    resolveLanAddress,
    clientPort,
    devModeRequested,
    isProductionBuild,
    devMode,
    LARGE_BODY_LIMIT,
    sessions,
    claimAttempts,
    panicAttempts,
    identityMintCounters,
    maxNewIdentitiesPerWindow,
    identityWindowMs,
    tombstoneHorizonMs,
    attachmentOwners,
    attachmentPendingGraceMs,
    tombstones,
    syncedChannelIds,
    dbState,
    lifecycle,
    rt,
    llm,
    mesh,
    sync,
    get transportIdentity() {
      return transportIdentity;
    },
    set transportIdentity(value) {
      transportIdentity = value;
    },
    get wipeGeneration() {
      return wipeGeneration;
    },
    set wipeGeneration(value) {
      wipeGeneration = value;
    },
    get wipeInProgress() {
      return wipeInProgress;
    },
    set wipeInProgress(value) {
      wipeInProgress = value;
    },
    get wipeInFlight() {
      return wipeInFlight;
    },
    set wipeInFlight(value) {
      wipeInFlight = value;
    },
    get awaitingWipeRestart() {
      return awaitingWipeRestart;
    },
    set awaitingWipeRestart(value) {
      awaitingWipeRestart = value;
    },
    get staticFilesRegistered() {
      return staticFilesRegistered;
    },
    set staticFilesRegistered(value) {
      staticFilesRegistered = value;
    },
    get appConfig() {
      return appConfig;
    },
    set appConfig(value) {
      appConfig = value;
    },
    get adminSetupCode() {
      return adminSetupCode;
    },
    set adminSetupCode(value) {
      adminSetupCode = value;
    },
    get data() {
      return data;
    },
    set data(value) {
      data = value;
    },
    get store() {
      return store;
    },
    set store(value) {
      store = value;
    },
    currentJoinHost,
    effectiveTransportEncryption,
    effectiveAdminBootstrap,
    presentsHostToken,
    parseConfigUpdate,
    loadAppConfig,
    anyAdminExists,
    consumeIdentityBudget,
    getSessionUserId,
    getSessionUserIdFromRequest,
    ensureUser,
    ensureSessionUser,
    currentNetworkConfig,
    redactedConfig,
    applyUserUpdate,
    canModerate,
    canGreet,
    isLocallyAuthoritative,
    participationError,
    timeoutError,
    applyUserModeration,
    invalidateUserSessions,
    revokeIdentityToken,
    applyChannelUpdate,
    publicUser,
    rolesVisibleUser,
    sanitizeUserFor,
    isMeshSentinelUser,
    meshSenderVisibleTo,
    visibleUsers,
    avatarImagePath,
    ensureChannel,
    uniqueChannelId,
    channelMemberIds,
    canAccessChannel,
    createChannelFromRequest,
    applyChannelMembers,
    channelPostingError,
    messageMutationError,
    withoutShadowBanned,
    channelMessages,
    dmMessages,
    messageAudienceUserIds,
    createMessage,
    updateMessage,
    loadData,
    attemptRateLimited,
    pruneExpiredRateLimiters,
    pruneTombstonesHorizon,
    reapExpiredMessages,
    reapOrphanedAttachments,
    reapOrphanedAvatars,
    collectDeletionSet,
    deleteMessages,
    registerStaticFiles,
  };
  const ctx = base as unknown as AppContext;
  const transport = createTransportServer(ctx);
  Object.assign(ctx, transport);
  const { ensureTransportIdentity, transportSessions, identityTokens, tunnelBoundUserId } = transport;
  const realtime = createRealtime(ctx);
  Object.assign(ctx, realtime);
  const { sendEventToUsers, broadcastStreamEvent, sockets, pendingSockets, broadcast } = realtime;
  const killSwitch = createKillSwitch(ctx);
  Object.assign(ctx, killSwitch);

  // Compile-time completeness check: every AppContext member is provided by one of the parts above.
  type MissingFromContext = Exclude<
    keyof AppContext,
    keyof typeof base | keyof typeof transport | keyof typeof realtime | keyof typeof killSwitch
  >;
  const contextIsComplete: MissingFromContext extends never ? true : MissingFromContext = true;
  void contextIsComplete;

  const { retryMissingAttachments, runSyncLoop } = sync;

  /**
   * Parse one PRESENT config layer, **aborting startup** if it's malformed or invalid. Silently ignoring
   * it and continuing from defaults is dangerous: a typo'd `security.transportEncryption: "required"` node
   * (e.g. a `sync.token` under the 16-char minimum invalidating the whole document) would fall back to the
   * `off` default and serve plaintext while the operator believes it's hardened. Fail closed instead — the
   * caller only invokes this when a config source actually exists (an absent file is a normal fresh boot).
   */
  function parseConfigUpdate(raw: string, source: string): LoamConfigUpdate {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error(`Invalid configuration in ${source}: not valid JSON. Fix or remove it; refusing to start from defaults.`);
    }

    const parsed = LoamConfigUpdateSchema.safeParse(json);
    if (parsed.success) {
      return parsed.data;
    }

    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid configuration in ${source}: ${detail}. Fix it; refusing to start from defaults.`);
  }

  /**
   * Load the effective configuration: defaults, overlaid by the config file (when present and
   * valid), overlaid by admin edits persisted in the DB `config` table.
   */
  async function loadAppConfig(): Promise<void> {
    let config = defaultLoamConfig();

    try {
      const raw = await readFile(configPath, "utf8");
      // A present-but-invalid config.json throws here (fail closed); an ABSENT file is ENOENT → a normal
      // fresh boot from defaults, handled by the catch below.
      const fileUpdate = parseConfigUpdate(raw, configPath);

      // Same reconciliation as the persisted path: a hand-authored config.json that pins a preset
      // profile *and* sets an explicit kill switch / approval / TTL keeps those explicit settings
      // (effective profile → custom) rather than letting the preset silently override them. The
      // file is the operator's own source, so we don't rewrite it — just resolve it in memory.
      const { update: reconciled, changed } = reconcileLegacyProfile(fileUpdate);
      if (changed) {
        server.log.warn(
          `${configPath} pins a security profile but also sets explicit access/retention/kill-switch values; keeping the explicit settings (effective profile: custom).`,
        );
      }
      config = mergeConfig(config, reconciled);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    const stored = store.getConfigValue("config");

    // `!== undefined` (not truthiness): a PRESENT empty string is a corrupt row that must fail closed
    // through `parseConfigUpdate` (JSON.parse("") throws → abort), not be silently skipped to defaults. An
    // absent key returns `undefined` → a normal fresh boot.
    if (stored !== undefined) {
      const storedUpdate = parseConfigUpdate(stored, "the persisted config table");

      // Heal configs saved before the profile became authoritative (see reconcileLegacyProfile):
      // preserve an explicitly-armed kill switch / approval / TTL by demoting the profile to custom.
      const { update: reconciled, changed } = reconcileLegacyProfile(storedUpdate);
      config = mergeConfig(config, reconciled);
      if (changed) {
        server.log.warn(
          "Security profile is now authoritative; kept explicit access/retention/kill-switch settings by switching this node's profile to 'custom'.",
        );
        store.setConfigValue("config", JSON.stringify(config));
      }
    }

    appConfig = config;
  }

  function anyAdminExists(): boolean {
    return data.users.some((user) => user.isAdmin);
  }

  /**
   * Consume one unit of a client IP's new-identity budget (fixed window). Returns false once the IP
   * has minted `maxNewIdentitiesPerWindow` identities within `identityWindowMs`; the window then
   * resets on its next expiry. Only reached on a genuine mint (requests with a valid session cookie
   * return earlier), so a well-behaved client that keeps its cookie never touches this.
   */
  function consumeIdentityBudget(ip: string): boolean {
    const now = Date.now();
    const entry = identityMintCounters.get(ip);

    if (!entry || entry.resetAt <= now) {
      identityMintCounters.set(ip, { count: 1, resetAt: now + identityWindowMs });
      return true;
    }

    entry.count += 1;
    return entry.count <= maxNewIdentitiesPerWindow;
  }

  function getSessionUserId(request: FastifyRequest, reply: FastifyReply): string {
    // A bound session's identity arrives via the internal tunnel (docs/20 §10) — trusted over any
    // cookie, and it mints nothing (the identity already exists from resume). Checked first so a
    // stale/forwarded cookie can never shadow the session-key-proven identity.
    const boundUserId = tunnelBoundUserId(request);
    if (boundUserId) {
      return boundUserId;
    }

    const cookieToken = readCookie(request.headers.cookie, sessionCookieName);
    const cookieUserId = cookieToken ? sessions.get(cookieToken) : undefined;

    if (cookieUserId) {
      return cookieUserId;
    }

    // No valid session — this request will mint a brand-new identity. Bound how fast one address can
    // do that (429) so an attacker can't flood the user table by discarding cookies.
    if (!consumeIdentityBudget(request.ip)) {
      throw new IdentityLimitError();
    }

    const userId = makeSessionUserId();
    const token = makeSessionToken();
    sessions.set(token, userId);
    store.putSession(token, userId);
    // Mark the cookie Secure only when the request actually arrived over TLS. Keying this on
    // NODE_ENV=production instead (as before) breaks sessions on LOAM's documented plain-http LAN
    // deployment: a Secure cookie is dropped by the browser, so every request mints a fresh session
    // and identity never persists. We read `request.protocol` (the real socket protocol) rather
    // than a client-supplied `x-forwarded-proto` header: LOAM runs without `trustProxy` on purpose
    // (so the per-IP rate limiter can't be evaded by a spoofed `x-forwarded-for`), which means a
    // self-hoster terminating TLS at a proxy must enable trustProxy themselves for this to flip.
    const secure = request.protocol === "https";
    const cookie = `${sessionCookieName}=${encodeCookieValue(
      token,
    )}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionCookieMaxAge}${secure ? "; Secure" : ""}`;
    reply.header("set-cookie", cookie);
    return userId;
  }

  function getSessionUserIdFromRequest(request: FastifyRequest): string | undefined {
    const boundUserId = tunnelBoundUserId(request);
    if (boundUserId) {
      return boundUserId;
    }
    const cookieToken = readCookie(request.headers.cookie, sessionCookieName);
    return cookieToken ? sessions.get(cookieToken) : undefined;
  }

  /**
   * Ensures a user with the specified id exists, creating, persisting, and broadcasting a new
   * user when absent.
   *
   * @param id - The unique user id to ensure exists
   * @param isAdmin - If a new user is created, whether they should be marked as an administrator
   * @param pending - If a new user is created, whether they start awaiting approval
   * @returns The existing or newly created User
   */
  function ensureUser(id: string, isAdmin = false, pending = false): User {
    const existing = data.users.find((user) => user.id === id);

    if (existing) {
      return existing;
    }

    // Persist first, then mirror in memory — if the store write throws, nothing diverges.
    const user = makeUser(id, isAdmin, pending);
    store.upsertUser(user);
    data.users.push(user);
    broadcast({ type: "userUpserted", user });
    return user;
  }

  /**
   * Ensure a session-originated user exists, applying the `firstUser` admin bootstrap and the join
   * policy: when `firstUser` is active and no admin exists yet, the first session user created
   * becomes admin; and under the `approval` join policy a newly created non-admin starts `pending`,
   * awaiting a greeter/admin's approval before they can participate. Admins are never pending.
   */
  function ensureSessionUser(id: string): User {
    const isAdmin = effectiveAdminBootstrap() === "firstUser" && !anyAdminExists();
    const pending = !isAdmin && appConfig.access.joinPolicy === "approval";
    const user = ensureUser(id, isAdmin, pending);
    // Give a real local user a mesh identity the first time we see them under mesh mode, so they can
    // send and receive sealed mail (no-op when mesh is off or they already have one).
    if (appConfig.mesh.enabled && user.type === "human" && !user.identityKey) {
      ensureMeshIdentity(user.id);
    }
    return user;
  }

  /**
   * Provides the current network configuration reflecting enabled features and identity permissions.
   */
  function currentNetworkConfig(): NetworkConfig {
    return {
      nodeName: appConfig.node.name,
      ...appConfig.features,
      enableMesh: appConfig.mesh.enabled,
      enableLLMChat: llmEnabled(),
      enableLLMStreaming: llmEnabled(),
      allowUserDisplayNameEdit: appConfig.identity.allowUserDisplayNameEdit,
      allowUserAvatarEdit: appConfig.identity.allowUserAvatarEdit,
      allowUserAvatarUpload: appConfig.identity.allowUserAvatarUpload,
      // Only advertise claiming when a usable secret actually exists (the setup code is
      // single-use, and passphrase mode may have no passphrase configured). `hostDevice` is deliberately
      // NOT advertised: its token reaches only the host's own WebView, which claims without a form.
      allowAdminClaim:
        (effectiveAdminBootstrap() === "setupCode" && adminSetupCode !== undefined) ||
        (effectiveAdminBootstrap() === "passphrase" && !!appConfig.admin.passphrase),
      joinPolicy: appConfig.access.joinPolicy,
      securityProfile: appConfig.security.profile,
      // Report the EFFECTIVE posture (Developer Mode forces "off"), matching what's actually enforced.
      transportEncryption: effectiveTransportEncryption(),
      // Publish the host's static public key only when transport encryption is in play, so the client
      // can handshake + show the fingerprint. The client still prefers the QR-delivered key (docs/08).
      transportPublicKey:
        effectiveTransportEncryption() === "off" ? undefined : transportIdentity?.publicKey,
      // Report the EFFECTIVE posture, not the merely-configured one (F5/P2-1): `security.dbEncryption`
      // is a declarative admin setting, decoupled from whether the store actually got opened with a
      // key — `dbState.encryptionEnabled` is boot-resolved truth (including the F4/SF2 fallback downgrade), so
      // when it's false the wire must say "off" regardless of what's configured. When it's true, prefer
      // the caller's boot-resolved `dbEncryptionMode` (P2-1: the Android launcher's actual key strategy,
      // which nobody PATCHes into the admin config) over the declarative axis, falling back to it only
      // when the caller didn't supply one (desktop/Pi CLI). Never claim encryption that isn't active.
      dbEncryption: dbState.encryptionEnabled ? options.dbEncryptionMode ?? appConfig.security.dbEncryption : "off",
      locale: appConfig.node.locale,
      // Self-announce Developer Mode so every client shows the "traffic is plaintext" banner. Always false
      // in a production build (see the `devMode` const — it refuses to engage when NODE_ENV=production).
      devMode,
    };
  }

  /** The effective config as exposed to admins — secret values are never returned. */
  function redactedConfig(): LoamConfig {
    return {
      ...appConfig,
      admin: { ...appConfig.admin, passphrase: undefined },
      killSwitch: { ...appConfig.killSwitch, panicToken: undefined },
    };
  }

  /**
   * Apply validated user update fields to an existing user object.
   *
   * @param user - The existing user object to update (mutated in-place)
   * @param update - Partial update fields for the user; `undefined` avatar preserves existing avatar
   * @returns The mutated and validated `User` object
   */
  function applyUserUpdate(user: User, update: UserUpdateRequest): User {
    const next = UserSchema.parse({
      ...user,
      displayName: update.displayName ?? user.displayName,
      avatar: update.avatar === undefined ? user.avatar : update.avatar,
    });
    store.upsertUser(next);
    Object.assign(user, next);
    broadcast({ type: "userUpserted", user });
    return user;
  }

  /**
   * Whether a user may moderate others (ban / shadow-ban / unban non-admins): admins always can,
   * as can anyone granted the `moderator` role — unless they are themselves banned or pending
   * (a banned moderator's lingering session must not keep its powers).
   */
  function canModerate(user: User): boolean {
    return !user.banned && !user.pending && (user.isAdmin || !!user.roles?.includes("moderator"));
  }

  /**
   * Whether a user may greet newcomers (approve / deny pending users, see the in-client join QR):
   * admins always can, as can anyone granted the `greeter` role. Banned/pending users never can.
   */
  function canGreet(user: User): boolean {
    return !user.banned && !user.pending && (user.isAdmin || !!user.roles?.includes("greeter"));
  }

  /**
   * Whether a user id belongs to a locally-authoritative identity (admin / moderator / greeter). Used
   * to reject sync-imported content that tries to impersonate one — a peer must never be able to make
   * a message render as authored by this node's admin. Imported users are always stripped of authority
   * (`importPeerUsers`), so an authoritative local id is by definition a real local identity.
   */
  function isLocallyAuthoritative(userId: string): boolean {
    const user = data.users.find((candidate) => candidate.id === userId);
    return !!user && (canModerate(user) || canGreet(user));
  }

  /**
   * Why a user may not read or create content on this node: banned users are fully locked out, and
   * under the `approval` join policy a pending user gets nothing until a greeter lets them in
   * (previously only *posting* was gated, so an unapproved or banned session could still read every
   * channel and DM feed over REST). `/api/config` stays open — it is how the client learns it is
   * banned/pending and shows the right screen.
   */
  function participationError(user: User): string | undefined {
    if (user.banned) {
      return "You have been removed from this node";
    }

    if (user.pending) {
      return "Your join is awaiting approval";
    }

    return undefined;
  }

  /**
   * Why a user may not POST right now even though they can still read: an active moderator timeout
   * (docs/26). Returns a user-facing message until `timeoutUntil` passes, else undefined. Unlike
   * `participationError`, this gates posting only — a timed-out member keeps reading the channel, and the
   * timeout auto-expires (a past `timeoutUntil` is simply not active). The client shows a composer countdown.
   */
  function timeoutError(user: User): string | undefined {
    if (user.timeoutUntil !== undefined && user.timeoutUntil > Date.now()) {
      return "You are timed out by a moderator and cannot post right now";
    }
    return undefined;
  }

  /**
   * Apply moderation / role state to a user (roles, banned, shadowBanned, pending), re-validating
   * the whole record against the schema, persisting, then broadcasting `userUpserted`. Mirrors
   * `applyUserUpdate`: persist first, then mutate the live object and broadcast, so a failed write
   * never leaves in-memory state or a broadcast ahead of what is stored. Only the provided fields
   * change.
   */
  function applyUserModeration(
    user: User,
    changes: Partial<Pick<User, "roles" | "banned" | "shadowBanned" | "pending" | "timeoutUntil">>,
  ): User {
    const next = UserSchema.parse({ ...user, ...changes });
    store.upsertUser(next);
    // Clearing works without deleting keys: a change like `timeoutUntil: undefined` is kept by Zod as an
    // undefined-valued key, Object.assign copies it onto the live record (so `isTimedOut` reads false), and
    // JSON.stringify omits it from what's persisted/broadcast.
    Object.assign(user, next);
    broadcast({ type: "userUpserted", user });
    return user;
  }

  /**
   * Tear down a user's sessions when they are banned/denied: delete their session tokens from the
   * store and close any live sockets they hold (mirrors how the kill switch tears sessions down,
   * scoped to one user). The in-memory session→user mapping is deliberately kept so the ban stays
   * enforced against that identity — dropping it would re-mint the banned user a fresh, clean id on
   * their next request, silently undoing the ban. The store deletion still invalidates the session
   * durably (it is gone after a restart).
   */
  function invalidateUserSessions(userId: string): void {
    for (const [token, sessionUserId] of sessions) {
      if (sessionUserId === userId) {
        store.deleteSession(token);
      }
    }

    // Tear down any BOUND transport sessions for this user (docs/20) so a banned user's live sealed
    // session stops working at once. The identity TOKEN is deliberately KEPT (like the cookie session
    // mapping above): a reconnect re-binds to the SAME banned identity, so the ban stays pinned rather
    // than being shed by a fresh handshake+resume.
    for (const [sid, session] of [...transportSessions]) {
      if (session.userId === userId) {
        transportSessions.delete(sid);
      }
    }

    for (const socketSession of [...sockets]) {
      if (socketSession.userId === userId) {
        socketSession.socket.close();
        sockets.delete(socketSession);
      }
    }

    // Also close any of this user's sockets still mid-challenge (docs/20 §7/§8) — otherwise a socket that
    // completes its proof after the ban would slip into the live feed.
    for (const pending of [...pendingSockets]) {
      if (pending.userId === userId) {
        pending.close();
      }
    }
  }

  /** Revoke a secure identity token (docs/20 §8) — for explicit logout / device wipe / rotation, where
   * the user is discarding the identity itself (unlike a ban, which keeps the token pinned). Deletes the
   * token row (memory + store), drops every transport session it bound, and closes that identity's
   * sockets. Returns the userId the token authenticated, or undefined if it was already gone. */
  function revokeIdentityToken(tokenHash: string): string | undefined {
    const userId = identityTokens.get(tokenHash);
    identityTokens.delete(tokenHash);
    store.deleteIdentityToken(tokenHash);

    for (const [sid, session] of [...transportSessions]) {
      if (session.identityTokenHash === tokenHash) {
        transportSessions.delete(sid);
      }
    }
    if (userId) {
      for (const socketSession of [...sockets]) {
        if (socketSession.userId === userId) {
          socketSession.socket.close();
          sockets.delete(socketSession);
        }
      }
      // Close this identity's mid-challenge sockets too (docs/20 §7/§8), so none confirms after logout.
      for (const pending of [...pendingSockets]) {
        if (pending.userId === userId) {
          pending.close();
        }
      }
    }
    return userId;
  }

  /**
   * Applies an admin channel update, re-validating the whole channel against the schema. Mirrors
   * `applyUserUpdate`: persist first, then mutate the live object and broadcast, so a failed write
   * never leaves in-memory state or a broadcast ahead of what is stored. Only fields present on
   * `update` change.
   */
  function applyChannelUpdate(channel: Channel, update: ChannelUpdateRequest): Channel {
    const next = ChannelSchema.parse({
      ...channel,
      name: update.name ?? channel.name,
      description: update.description === undefined ? channel.description : update.description,
      allowPosting: update.allowPosting ?? channel.allowPosting,
      allowReplies: update.allowReplies ?? channel.allowReplies,
      archived: update.archived === undefined ? channel.archived : update.archived,
      pinned: update.pinned === undefined ? channel.pinned : update.pinned,
      allowJoinRequests:
        update.allowJoinRequests === undefined ? channel.allowJoinRequests : update.allowJoinRequests,
      // `null` clears the per-channel TTL (back to the node default); a number sets it; omitted leaves it.
      messageTtlMs:
        update.messageTtlMs === undefined ? channel.messageTtlMs : (update.messageTtlMs ?? undefined),
      // Stamp the metadata-change time so a peer that IMPORTED this channel can re-sync the rename/archive
      // newer-wins (C1). Only ever applied to channels the peer marked as synced-origin (see syncWithPeer).
      updatedAt: Date.now(),
    });
    store.upsertChannel(next);
    // Turning join requests OFF clears any pending queue (they can no longer be fulfilled via the flow).
    if (update.allowJoinRequests === false) {
      store.removeJoinRequestsForChannel(channel.id);
    }
    // A cleared `messageTtlMs` (null → undefined) is kept by Zod as an undefined-valued key; Object.assign
    // copies it onto the live record (so `ttlForMessage` falls back to the node default) and JSON.stringify
    // omits it on persist/broadcast — no explicit key-delete needed.
    Object.assign(channel, next);
    broadcast({ type: "channelUpserted", channel });
    return channel;
  }

  /**
   * Determine which users should be exposed to clients: active participants only. Bots are hidden
   * unless the LLM is enabled, and banned/pending users are always hidden (they are not active
   * participants — moderators and greeters reach them via the dedicated moderation/access
   * endpoints). Shadow-banned users stay visible; only their messages are withheld.
   */
  /**
   * A user record safe to expose to ordinary clients: the `shadowBanned` flag is stripped, so a
   * *shadow*-banned user can't discover their own status (which would defeat the feature) and no one
   * can enumerate who is shadow-banned. Moderators still see it via the gated `/api/moderation/users`
   * endpoint, which returns the raw records. Applied at every public egress: the REST roster,
   * `/api/config`'s `currentUser`, and the `userUpserted` broadcast.
   */
  function publicUser(user: User): User {
    // Always drop the property (not just when truthy): if a restored user carried `shadowBanned:
    // false` while a shadow-banned user's copy omitted it, the field's mere presence/absence would
    // itself leak status. Removing it unconditionally makes every public record uniform. `roles`
    // (moderator/greeter) is stripped for the same reason a joiner must not be able to enumerate who
    // holds authority on the node — only the subject themselves and moderators see it (rolesVisibleUser).
    const clone = { ...user };
    delete clone.shadowBanned;
    delete clone.roles;
    // A moderator timeout is moderation metadata, like shadowBanned/banned: don't broadcast "X is muted
    // until T" to every peer. The subject still learns their own via rolesVisibleUser (so the composer
    // disables), and moderators see it there too — this only strips it from the fully-public record.
    delete clone.timeoutUntil;
    return clone;
  }

  /** Like `publicUser` but keeps `roles` — for the record's own owner (so their client can gate its
   * moderation UI) and for moderators (who legitimately manage roles). Still never leaks shadowBanned. */
  function rolesVisibleUser(user: User): User {
    const clone = { ...user };
    delete clone.shadowBanned;
    return clone;
  }

  /** The single record of `user` that `viewer` is allowed to see: `roles` only on the viewer's own
   * record or when the viewer is a moderator/admin; `shadowBanned` never. The one sanitizer every
   * user-egress path (roster, channel members, pending queue, approve/deny) routes through. */
  function sanitizeUserFor(viewer: User, user: User): User {
    return canModerate(viewer) || user.id === viewer.id ? rolesVisibleUser(user) : publicUser(user);
  }

  /** A mesh sender's display id (`mesh.<hash>`) — a sealed-mail delivery artifact, not a public roster
   * member (docs/16). Never a local session/seed/bot id (those are `user.`/`llm.`). */
  function isMeshSentinelUser(id: string): boolean {
    return id.startsWith("mesh.");
  }

  /** Whether `viewerId` has received sealed mail from mesh sender `meshId` — the only reason that
   * sender's display record is visible to them (it never joins the shared roster). */
  function meshSenderVisibleTo(meshId: string, viewerId: string): boolean {
    return data.messages.some(
      (message) => message.type === "dm" && message.authorId === meshId && message.recipientUserId === viewerId,
    );
  }

  /** The roster as `viewer` may see it: sanitized per-user, and with mesh sender artifacts hidden
   * except from the recipients they actually mailed. */
  function visibleUsers(viewer: User): User[] {
    const base = llmEnabled() ? data.users : data.users.filter((user) => user.type !== "bot");
    return base
      .filter((user) => !user.banned && !user.pending)
      .filter((user) => !isMeshSentinelUser(user.id) || meshSenderVisibleTo(user.id, viewer.id))
      .map((user) => sanitizeUserFor(viewer, user));
  }

  function avatarImagePath(imageId: string, mimeType: AvatarImageMimeType): string {
    return join(avatarsDir, `${imageId}.${avatarImageExtension(mimeType)}`);
  }

  /**
   * Finds the in-memory channel matching the provided id.
   */
  function ensureChannel(id: string): Channel | undefined {
    return data.channels.find((channel) => channel.id === id);
  }

  /**
   * Derives a stable, collision-free channel id from a display name: a URL-friendly slug (so routes
   * read `/channel/general`), with a short random suffix appended only when the slug is already
   * taken or empty (e.g. a name made entirely of emoji or punctuation).
   */
  function uniqueChannelId(name: string): string {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);

    // A tombstoned slug is never reused: delete is permanent, and a recreated channel with the SAME
    // id would inherit the old channel's ghosts — a peer's undelivered copies, stale references —
    // and would itself be refused by peers still holding the tombstone. Suffixed ids below are
    // random enough that a tombstone collision is not a practical concern.
    if (slug && !ensureChannel(slug) && !tombstones.has(slug)) {
      return slug;
    }

    let candidate: string;
    do {
      candidate = `${slug || "channel"}-${randomBytes(3).toString("hex")}`;
    } while (ensureChannel(candidate));

    return candidate;
  }

  /**
   * The full member roster of a channel as a set of user ids. The owner is always a member, even if
   * the stored `memberUserIds` predates an ownership change or omits them.
   */
  function channelMemberIds(channel: Channel): Set<string> {
    const members = new Set(channel.memberUserIds ?? []);

    if (channel.ownerUserId) {
      members.add(channel.ownerUserId);
    }

    return members;
  }

  /**
   * Whether a user may see, read, and post in a channel: public channels are open to everyone;
   * private channels are members-only. Deliberately, node admins get no implicit read access —
   * they manage private channels (archive, rename) through the admin endpoints without joining
   * their audience.
   */
  function canAccessChannel(channel: Channel, userId: string): boolean {
    return channel.visibility !== "private" || channelMemberIds(channel).has(userId);
  }

  /**
   * Builds a channel from a create request, persists it, and broadcasts it. Shared by admin
   * creation and (when `enableUserChannels` is on) user creation. Owner = the creator. Public
   * channels are discoverable by everyone; private channels start with the creator as the only
   * member and are only ever sent to their members (see socketCanReceiveEvent).
   */
  function createChannelFromRequest(input: ChannelCreateRequest, ownerId: string): Channel {
    const visibility = input.visibility ?? "public";
    const channel: Channel = {
      id: uniqueChannelId(input.name),
      name: input.name,
      description: input.description,
      ownerUserId: ownerId,
      visibility,
      allowPosting: input.allowPosting ?? "everyone",
      allowReplies: input.allowReplies ?? true,
      discoverable: visibility === "public",
      createdAt: Date.now(),
      ...(visibility === "private" ? { memberUserIds: [ownerId] } : {}),
    };

    // Persist before exposing in memory / broadcasting, so a failed write never surfaces a channel
    // that was not stored (mirrors applyUserUpdate).
    store.upsertChannel(channel);
    data.channels.push(channel);
    broadcast({ type: "channelUpserted", channel });
    return channel;
  }

  /**
   * Replace a private channel's member roster. Mirrors `applyChannelUpdate`: persist first, then
   * mutate the live object and broadcast — the `channelUpserted` reaches members only, so a newly
   * added member learns of the channel through it while outsiders never see it.
   */
  function applyChannelMembers(channel: Channel, memberUserIds: string[]): Channel {
    const next = ChannelSchema.parse({ ...channel, memberUserIds });
    store.upsertChannel(next);
    Object.assign(channel, next);
    broadcast({ type: "channelUpserted", channel });
    return channel;
  }

  /**
   * Enforce a channel's posting policy server-side.
   *
   * @param channel - The target channel
   * @param authorId - The user attempting to post
   * @param isReply - Whether the message is a thread reply
   * @returns A human-readable rejection reason, or `undefined` when posting is allowed
   */
  function channelPostingError(channel: Channel, authorId: string, isReply: boolean): string | undefined {
    if (channel.archived) {
      return "Channel is archived";
    }

    if (isReply && !channel.allowReplies) {
      return "Replies are disabled in this channel";
    }

    if (channel.allowPosting === "owner" && channel.ownerUserId !== authorId) {
      return "Only the channel owner can post in this channel";
    }

    if (channel.allowPosting === "admins") {
      const author = data.users.find((user) => user.id === authorId);

      if (!author?.isAdmin) {
        return "Only admins can post in this channel";
      }
    }

    return undefined;
  }

  /**
   * One shared gate for altering EXISTING content (edit / delete / react-to): the actor's moderation
   * state (ban / pending / timeout) plus the target's *current* conversation state (channel still
   * exists, actor still in its audience, channel not archived). The create path enforces the same
   * rules via `channelPostingError` and the audience checks; this is their mirror for mutations, so a
   * state *transition* — a member removed from a private channel, a moderator timeout, an archive —
   * can never be bypassed by editing or reacting to pre-transition messages (Sol review 2026-08-15).
   *
   * `adminOverride` preserves the trusted-host moderation model for DELETE only: an admin may remove
   * content anywhere (including archived channels and private channels they aren't a member of),
   * because moderating history is not "altering content" in the impersonation sense.
   *
   * Returns an HTTP status + message, or `undefined` when the mutation may proceed. Inaccessible
   * targets answer 404 with the same body as a missing message (the read paths' existence-hiding
   * parity); archived answers an honest 403 — archive is visible state to everyone who can read it.
   */
  function messageMutationError(
    actor: User,
    target: Message,
    opts: { adminOverride?: boolean; isDelete?: boolean } = {},
  ): { code: number; error: string } | undefined {
    const accessError = participationError(actor);

    if (accessError) {
      return { code: 403, error: accessError };
    }

    if (!opts.adminOverride) {
      const actorTimeout = timeoutError(actor);

      if (actorTimeout) {
        return { code: 403, error: actorTimeout };
      }

      // A runtime feature SHUTDOWN blocks edits — switching DMs or replies off must stop fresh
      // content broadcasting through PATCH on pre-shutdown messages (Sol round 2, P1) — but not
      // deletes: removing content a disabled feature created is cleanup, not use of the feature.
      if (!opts.isDelete) {
        if (target.type === "dm" && !appConfig.features.enableDMs) {
          return { code: 403, error: "Direct messages are disabled on this LOAM node" };
        }

        if (target.type === "channelReply" && !appConfig.features.enableReplies) {
          return { code: 403, error: "Replies are disabled on this LOAM node" };
        }
      }
    }

    // A reaction has no channelId of its own — its conversation is its TARGET's. Without resolving
    // it, deleting a reaction skipped every channel check (review finding: an ex-member or a user in
    // an archived channel could still toggle reactions off via DELETE). A reaction on a vanished
    // target has no live conversation to protect — deleting it is pure cleanup, so it falls through.
    const channelScoped =
      target.type === "channelPost" || target.type === "channelReply"
        ? target
        : target.type === "reaction"
          ? data.messages.find(
              (candidate): candidate is Message & { channelId: string } =>
                candidate.id === target.targetMessageId &&
                (candidate.type === "channelPost" || candidate.type === "channelReply"),
            )
          : undefined;

    if (channelScoped) {
      const channel = ensureChannel(channelScoped.channelId);

      if (!channel || (!opts.adminOverride && !canAccessChannel(channel, actor.id))) {
        return { code: 404, error: "Message does not exist" };
      }

      if (!opts.adminOverride) {
        // The FULL "may write here, now" policy, not just the archived bit: a channel locked down
        // after the fact (allowPosting owner/admins, replies disabled, channel posting disabled
        // node-wide) must also stop edits of pre-lockdown content — otherwise lockdown doesn't stop
        // content injection through PATCH (review finding). Reactions check their own posting rules
        // at create; for mutation purposes they inherit the target's channel state checked here.
        // Like the type-specific flags above, the node-wide shutdown blocks edits but not deletes.
        if (!opts.isDelete && !appConfig.features.enablePublicChannels) {
          return { code: 403, error: "Channel posting is disabled on this LOAM node" };
        }

        const policyError =
          channelScoped === target
            ? channelPostingError(channel, actor.id, target.type === "channelReply")
            : channel.archived
              ? "Channel is archived"
              : undefined;

        if (policyError) {
          return { code: 403, error: policyError };
        }
      }
    }

    return undefined;
  }

  /**
   * Hide messages (and reactions) authored by a shadow-banned user from everyone but that author —
   * the same rule `socketCanReceiveEvent` and search apply. Without this, the REST read paths (which
   * the client refetches on every channel open and reconnect) would return a shadow-banned author's
   * content to the whole network, making the WS-level concealment cosmetic.
   */
  function withoutShadowBanned(messages: Message[], viewerId: string): Message[] {
    return messages.filter((message) => {
      const author = data.users.find((candidate) => candidate.id === message.authorId);
      return !author?.shadowBanned || message.authorId === viewerId;
    });
  }

  function channelMessages(channelId: string, viewerId: string): Message[] {
    // Filter the root messages by shadow-ban FIRST, then keep only reactions that target a still-
    // visible root (and whose own author isn't shadow-banned). Deriving the reaction ids from the
    // unfiltered roots would leave orphan reactions pointing at a hidden message — leaking that a
    // shadow-banned author's post exists.
    const roots = withoutShadowBanned(
      data.messages.filter((message) => isChannelMessage(message, channelId)),
      viewerId,
    );
    const visibleRootIds = new Set(roots.map((message) => message.id));
    const reactions = withoutShadowBanned(
      data.messages.filter((message) => message.type === "reaction" && visibleRootIds.has(message.targetMessageId)),
      viewerId,
    );
    return [...roots, ...reactions].sort((a, b) => a.createdAt - b.createdAt);
  }

  function dmMessages(peerId: string, currentUserId: string): Message[] {
    // Same ordering as channelMessages: shadow-ban the roots first, then only reactions on visible
    // roots survive, so a hidden DM never leaks via a dangling reaction.
    const roots = withoutShadowBanned(
      data.messages.filter(
        (message) =>
          message.type === "dm" &&
          ((message.authorId === currentUserId && message.recipientUserId === peerId) ||
            (message.authorId === peerId && message.recipientUserId === currentUserId)),
      ),
      currentUserId,
    );
    const visibleRootIds = new Set(roots.map((message) => message.id));
    const reactions = withoutShadowBanned(
      data.messages.filter((message) => message.type === "reaction" && visibleRootIds.has(message.targetMessageId)),
      currentUserId,
    );
    return [...roots, ...reactions].sort((a, b) => a.createdAt - b.createdAt);
  }

  function messageAudienceUserIds(message: Message): Set<string> | undefined {
    if (message.type === "dm") {
      return new Set([message.authorId, message.recipientUserId]);
    }

    if (message.type === "reaction") {
      const target = data.messages.find((candidate) => candidate.id === message.targetMessageId);
      return target ? messageAudienceUserIds(target) : new Set([message.authorId]);
    }

    // Sealed mailbox mail is opaque and never broadcast to any client — it moves only over sync and is
    // delivered (decrypted) as a fresh DM. Empty audience = no socket receives the sealed blob itself.
    if (message.type === "sealed") {
      return new Set();
    }

    // Channel messages: a private channel's messages (and, via the reaction recursion above, the
    // reactions on them) are only ever for its members. Public channels have no audience limit.
    const channel = ensureChannel(message.channelId);
    return channel?.visibility === "private" ? channelMemberIds(channel) : undefined;
  }

  /**
   * Validate input and create a new message record, or remove an existing reaction when toggled.
   *
   * Enforces the feature flags server-side: message types whose feature is disabled are rejected.
   *
   * @param input - The message creation payload specifying type-specific fields
   * @param authorId - The ID of the user creating the message
   * @returns An object containing either `message`, `deletedMessageId`/`deletedMessage` for a toggled reaction, or `error`
   */
  function createMessage(
    input: MessageCreateRequest,
    authorId: string,
  ): { message?: Message; deletedMessage?: Message; deletedMessageId?: string; error?: string; forbidden?: boolean } {
    const author = ensureSessionUser(authorId);

    // Moderation gates run before any feature-flag checks. A banned author is fully blocked; a
    // pending author is blocked until approved (both are `forbidden`, so the endpoint answers 403).
    // A shadow-banned author is allowed through here — the message is created and returned to them
    // normally, and the broadcast filter withholds it from everyone else (see socketCanReceiveEvent).
    const authorAccessError = participationError(author);

    if (authorAccessError) {
      return { error: authorAccessError, forbidden: true };
    }

    // A moderator timeout blocks posting (but not reading) until it expires — the bot has none.
    const authorTimeoutError = timeoutError(author);

    if (authorTimeoutError) {
      return { error: authorTimeoutError, forbidden: true };
    }

    if (
      (input.type === "channelPost" || input.type === "channelReply") &&
      !appConfig.features.enablePublicChannels
    ) {
      return { error: "Channel posting is disabled on this LOAM node" };
    }

    if (input.type === "channelReply" && !appConfig.features.enableReplies) {
      return { error: "Replies are disabled on this LOAM node" };
    }

    if (input.type === "dm" && !appConfig.features.enableDMs) {
      return { error: "Direct messages are disabled on this LOAM node" };
    }

    if (input.type === "reaction" && !appConfig.features.enableReactions) {
      return { error: "Reactions are disabled on this LOAM node" };
    }

    if (input.type !== "reaction" && input.attachments?.length) {
      if (!appConfig.features.enableAttachments) {
        return { error: "Attachments are disabled on this LOAM node" };
      }

      // Only the uploader's own pending uploads may be attached, and each exactly once — so a
      // guessed/leaked id can't attach someone else's image or double-reference a file whose
      // deletion would break another message.
      for (const attachment of input.attachments) {
        if (attachmentOwners.get(attachment.id)?.userId !== authorId) {
          return { error: "Unknown attachment" };
        }
      }
    }

    if (input.type !== "reaction" && input.location && !appConfig.features.enableLocationSharing) {
      return { error: "Location sharing is disabled on this LOAM node" };
    }

    if (input.type === "channelPost" || input.type === "channelReply") {
      const channel = ensureChannel(input.channelId);

      if (!channel) {
        return { error: "Channel does not exist" };
      }

      // Non-members get the same answer as a missing channel, so a private channel's existence is
      // never leaked by probing the message endpoint.
      if (!canAccessChannel(channel, authorId)) {
        return { error: "Channel does not exist" };
      }

      const policyError = channelPostingError(channel, authorId, input.type === "channelReply");

      if (policyError) {
        return { error: policyError };
      }
    }

    if (input.type === "channelReply") {
      const parent = data.messages.find((message) => message.id === input.parentMessageId);

      if (!parent || !("channelId" in parent)) {
        return { error: "Parent message does not exist" };
      }

      if (parent.channelId !== input.channelId) {
        return { error: "Parent message belongs to a different channel" };
      }
    }

    if (input.type === "reaction") {
      const target = data.messages.find((message) => message.id === input.targetMessageId);

      if (!target) {
        return { error: "Target message does not exist" };
      }

      // DM (and DM-reaction) targets are only reactable by their participants.
      const audience = messageAudienceUserIds(target);

      if (audience && !audience.has(authorId)) {
        return { error: "Cannot react to this message" };
      }

      // A channel-scoped target is only reactable while the reactor can still write there: the
      // channel must exist, be accessible, and not be archived (archive = read-only). Mirrors
      // channelPostingError for posts — without this, reactions were the one create path that
      // ignored the channel's current state (Sol review 2026-08-15).
      if (target.type === "channelPost" || target.type === "channelReply") {
        const targetChannel = ensureChannel(target.channelId);

        if (!targetChannel || !canAccessChannel(targetChannel, authorId)) {
          return { error: "Target message does not exist" };
        }

        if (targetChannel.archived) {
          return { error: "Channel is archived" };
        }
      }

      const existingIndex = data.messages.findIndex(
        (message) =>
          message.type === "reaction" &&
          message.authorId === authorId &&
          message.targetMessageId === input.targetMessageId &&
          message.reaction === input.reaction,
      );

      if (existingIndex >= 0) {
        const deleted = data.messages[existingIndex];

        if (deleted) {
          // Tombstone the toggled-off reaction so sync peers don't hand it straight back.
          store.transaction(() => {
            store.deleteMessage(deleted.id);
            store.addTombstone(deleted.id);
          });
          tombstones.add(deleted.id);
          data.messages.splice(existingIndex, 1);
        }

        return { deletedMessageId: deleted?.id, deletedMessage: deleted };
      }
    }

    if (input.type === "dm") {
      const recipient = data.users.find((user) => user.id === input.recipientUserId);

      if (!recipient) {
        return { error: "Recipient user does not exist" };
      }
    }

    const base = {
      id: newMessageId(input.type === "reaction" ? "react" : "msg"),
      authorId,
      createdAt: Date.now(),
      meta:
        input.type === "reaction"
          ? undefined
          : { markdown: appConfig.features.enableMarkdown, source: "human" as const },
    };
    const message = MessageSchema.parse({ ...input, ...base });
    store.insertMessage(message);
    data.messages.push(message);

    if (input.type !== "reaction") {
      for (const attachment of input.attachments ?? []) {
        attachmentOwners.delete(attachment.id);
      }
    }

    return { message };
  }

  /**
   * Update a message's body and edited metadata in-place, persist it, and broadcast the update.
   *
   * @param message - The message object to update
   * @param nextBody - The new body content to set on the message
   * @param streaming - Whether the message is currently streaming (sets `meta.streaming`)
   * @returns The updated message instance
   */
  function updateMessage(message: Message, nextBody: string, streaming: boolean): Message {
    if (!("body" in message)) {
      return message;
    }

    const updated = MessageSchema.parse({
      ...message,
      body: nextBody,
      editedAt: Date.now(),
      meta: {
        ...message.meta,
        streaming,
      },
    });
    store.updateMessage(updated);
    Object.assign(message, updated);
    broadcast({ type: "messageUpdated", message });
    return message;
  }

  /**
   * Loads persisted application data into memory: runs the one-time legacy JSON import, loads all
   * tables, seeds default channels on first boot, ensures (non-admin) seed users — demoting any
   * legacy admin seed, since admin now comes only from the bootstrap strategies — and ensures the
   * Ollama bot user if configured.
   */
  function loadData(): void {
    if (importLegacyJsonData(store, dataDir)) {
      server.log.info("Imported legacy .loam JSON data into SQLite (originals renamed to *.json.bak)");
    }

    data = {
      users: store.loadUsers(),
      channels: store.loadChannels(),
      messages: store.loadMessages(),
    };
    tombstones.clear();

    for (const id of store.loadTombstones()) {
      tombstones.add(id);
    }

    syncedChannelIds.clear();

    for (const id of store.loadSyncedChannelIds()) {
      syncedChannelIds.add(id);
    }

    transportIdentity = undefined;
    ensureTransportIdentity();

    meshIdentities.clear();
    loadMeshIdentities();
    meshContacts.clear();
    loadMeshContacts();

    sessions.clear();

    for (const session of store.loadSessions()) {
      sessions.set(session.token, session.userId);
    }

    identityTokens.clear();
    for (const record of store.loadIdentityTokens()) {
      identityTokens.set(record.tokenHash, record.userId);
    }

    if (!data.channels.length) {
      // Re-seed the defaults on an empty node — but never resurrect one the operator DELETED
      // (delete is permanent; its tombstone survives restarts). A kill-switch wipe clears the
      // tombstones along with everything else, so a post-reset node still seeds fresh defaults.
      data.channels = defaultChannels
        .filter((channel) => !tombstones.has(channel.id))
        .map((channel) => ({ ...channel }));
      store.transaction(() => {
        for (const channel of data.channels) {
          store.upsertChannel(channel);
        }
      });
    }

    // Remove the legacy demo users (user.1234/user.5678) that early builds seeded — a live node shouldn't
    // ship fake DM contacts. Delete every message that references them (authored by, or a DM to, the demo
    // user) AND every reaction/reply targeting those messages — via `collectDeletionSet` + `deleteMessages`,
    // the same machinery the normal delete path uses, so removals are tombstoned (a peer can't re-import
    // them over sync), attachment-swept, and persist-before-mirror ordered. Message cleanup runs even when
    // the user row is already gone (a partial prior state can still leave orphan messages). A fresh node
    // never creates these; this only cleans up a pre-existing DB.
    for (const id of legacyDemoUserIds) {
      const involvesDemoUser = (message: Message): boolean =>
        message.authorId === id || (message.type === "dm" && message.recipientUserId === id);
      const deletionSet = new Map<string, Message>();
      for (const message of data.messages.filter(involvesDemoUser)) {
        for (const casualty of collectDeletionSet(message)) {
          deletionSet.set(casualty.id, casualty);
        }
      }
      deleteMessages(Array.from(deletionSet.values()));

      // Purge the user row (only if still present) AND any auth mappings. The credential purge is NOT
      // gated on the row existing, so a stale session/identity token can't linger — or resurrect the id via
      // `ensureSessionUser` — after a partial prior cleanup that dropped the row but not its tokens. Persist
      // in one transaction, then mirror the in-memory maps only AFTER it succeeds. Seed users never
      // authenticate, so the mappings are normally empty — cleared anyway so the removal is provably complete.
      const userExists = data.users.some((user) => user.id === id);
      const doomedTokens = [...sessions].filter(([, userId]) => userId === id).map(([token]) => token);
      store.transaction(() => {
        if (userExists) {
          store.deleteUser(id);
        }
        store.deleteIdentityTokensForUser(id);
        for (const token of doomedTokens) {
          store.deleteSession(token);
        }
      });
      if (userExists) {
        data.users = data.users.filter((user) => user.id !== id);
      }
      for (const token of doomedTokens) {
        sessions.delete(token);
      }
      for (const [tokenHash, userId] of identityTokens) {
        if (userId === id) {
          identityTokens.delete(tokenHash);
        }
      }
    }

    ensureBotUser();
    ensureAllMeshIdentities();
  }

  /**
   * Track a secret-guess attempt under the given key (session user id or IP) and report whether
   * that key is over the limit for the current window.
   */
  function attemptRateLimited(attempts: Map<string, { count: number; resetAt: number }>, key: string): boolean {
    const now = Date.now();

    // Opportunistic pruning so a long-lived node doesn't accumulate one entry per source IP forever.
    if (attempts.size > 1000) {
      for (const [staleKey, entry] of attempts) {
        if (entry.resetAt <= now) {
          attempts.delete(staleKey);
        }
      }
    }

    const entry = attempts.get(key);

    if (!entry || entry.resetAt <= now) {
      attempts.set(key, { count: 1, resetAt: now + claimAttemptWindowMs });
      return false;
    }

    entry.count += 1;
    return entry.count > claimAttemptLimit;
  }

  /**
   * Drop expired entries from the per-IP rate-limit maps: the claim and panic attempt limiters and
   * the new-identity budget. Each keys on source IP and is written only on its semantic path, so
   * without periodic pruning a long-lived node facing many distinct peers would retain one dead entry
   * per IP forever. Runs on the 30s reaper timer, bounding growth to the IPs active within a single
   * window rather than every IP ever seen (docs/15 #9). Behaviour is otherwise unchanged: an expired
   * entry and a pruned one both reset on the next access.
   */
  function pruneExpiredRateLimiters(): void {
    const now = Date.now();
    for (const counters of [claimAttempts, panicAttempts, identityMintCounters]) {
      for (const [key, entry] of counters) {
        if (entry.resetAt <= now) {
          counters.delete(key);
        }
      }
    }
  }

  /**
   * Horizon GC for the `tombstones` table (docs/15 #7): a tombstone is added forever on every
   * delete (so sync/mesh never re-hands a locally deleted message back), which would otherwise
   * grow without bound on a long-lived node. Pruning is unconditional — not gated on
   * `sync.enabled` — because a delete made while sync is off must still block re-import once sync
   * or a mesh link comes on later; gating it reintroduces a moderation bypass. Runs on every
   * reaper tick, so a tombstone is only ever vulnerable to resurrection once its peer has been
   * unreachable for longer than the horizon.
   */
  function pruneTombstonesHorizon(): void {
    const cutoff = Date.now() - tombstoneHorizonMs;
    const pruned = store.pruneTombstonesOlderThan(cutoff);

    for (const id of pruned) {
      tombstones.delete(id);
    }

    if (pruned.length) {
      server.log.info(`Tombstone GC pruned ${pruned.length} entr${pruned.length === 1 ? "y" : "ies"} past the horizon`);
    }
  }

  function reapExpiredMessages(): void {
    reapExpiredSealed();
    pruneTombstonesHorizon();

    const globalTtl = appConfig.retention.messageTtlMs;
    // A channel may override the node default with its own `messageTtlMs` (P12). Fast-path out only when
    // there is neither a global TTL nor any per-channel override, so a channel TTL works even with the
    // node default off.
    const anyChannelTtl = data.channels.some((channel) => channel.messageTtlMs);

    if (!globalTtl && !anyChannelTtl) {
      return;
    }

    const now = Date.now();
    // Index channels once per cycle so the per-message TTL lookup is O(1), not an O(channels) find each.
    const channelsById = new Map(data.channels.map((channel) => [channel.id, channel]));
    /** The retention TTL that applies to a message: its channel's override if set, else the node default. */
    const ttlForMessage = (message: Message): number | undefined => {
      const channelId =
        message.type === "channelPost" || message.type === "channelReply" ? message.channelId : undefined;
      const channelTtl = channelId ? channelsById.get(channelId)?.messageTtlMs : undefined;
      // `|| undefined` (not `??`) so a zero/NaN global TTL is treated as OFF, never as "expire everything
      // now" — a 0 would make `createdAt < now - 0` true for every message in a non-TTL channel.
      return channelTtl ?? (globalTtl || undefined);
    };
    const expired = data.messages.filter((message) => {
      if (message.meta?.streaming) {
        return false;
      }
      const ttl = ttlForMessage(message);
      return ttl !== undefined && message.createdAt < now - ttl;
    });

    if (!expired.length) {
      return;
    }

    // Expand each expired message through the same cascade the delete endpoint uses, so an expired
    // thread root takes its replies and reactions with it instead of orphaning them against a
    // missing parent until their own TTL passes. In-flight streaming messages stay spared.
    const doomed = new Map<string, Message>();

    for (const message of expired) {
      for (const casualty of collectDeletionSet(message)) {
        if (!casualty.meta?.streaming) {
          doomed.set(casualty.id, casualty);
        }
      }
    }

    deleteMessages([...doomed.values()]);
    server.log.info(`Retention reaper deleted ${doomed.size} expired message(s)`);
  }

  /**
   * Delete attachment files no message references and no fresh pending upload claims: uploads
   * whose send was abandoned (past the grace period) and files orphaned by a restart (the pending
   * map is RAM-only, so at boot every unreferenced file is an orphan). Runs at boot and on the
   * reaper timer.
   */
  async function reapOrphanedAttachments(): Promise<void> {
    let files: string[];

    try {
      files = await readdir(attachmentsDir);
    } catch {
      return; // No attachments directory yet — nothing uploaded.
    }

    const referenced = new Set<string>();

    for (const message of data.messages) {
      if (message.type !== "reaction" && message.type !== "sealed") {
        for (const attachment of message.attachments ?? []) {
          referenced.add(attachment.id);
        }
      }
    }

    const now = Date.now();

    for (const fileName of files) {
      const parsed = parseAttachmentFileName(fileName);

      if (!parsed || referenced.has(parsed.id)) {
        continue;
      }

      const pending = attachmentOwners.get(parsed.id);

      if (pending && now - pending.uploadedAt < attachmentPendingGraceMs) {
        continue;
      }

      attachmentOwners.delete(parsed.id);
      await rm(join(attachmentsDir, fileName), { force: true }).catch((error: unknown) =>
        server.log.warn(error),
      );
    }
  }

  /**
   * Boot-time sweep of avatar image files no user record references (review 2026-09-04). Avatars are
   * written to disk on upload and only ever removed with their user or by the kill switch — so any path
   * that drops user rows without touching the files (an ephemeral-mode restart deleting the DB, a
   * preserve-and-start-fresh recovery, a crash between the file write and the user upsert) strands
   * plaintext images on disk indefinitely. Mirrors `reapOrphanedAttachments`; runs once at boot, after
   * the store is loaded, so `data.users` is authoritative. Best-effort — a delete failure is logged.
   */
  async function reapOrphanedAvatars(): Promise<void> {
    let files: string[];

    try {
      files = await readdir(avatarsDir);
    } catch {
      return; // No avatars directory yet — nothing uploaded.
    }

    const referenced = new Set<string>();

    for (const user of data.users) {
      if (user.avatar?.imageId) {
        referenced.add(user.avatar.imageId);
      }
    }

    for (const fileName of files) {
      const parsed = parseAvatarImageId(fileName);

      if (!parsed || referenced.has(parsed.imageId)) {
        continue;
      }

      await rm(join(avatarsDir, fileName), { force: true }).catch((error: unknown) => server.log.warn(error));
    }
  }

  /**
   * Collects a message together with everything that deleting it would orphan: reactions targeting
   * it, and — for a channel post that roots a thread — its replies plus the reactions on those.
   */
  function collectDeletionSet(target: Message): Message[] {
    const set = new Map<string, Message>([[target.id, target]]);
    const reactionTargets = new Set<string>([target.id]);

    if (target.type === "channelPost") {
      for (const message of data.messages) {
        if (message.type === "channelReply" && message.parentMessageId === target.id) {
          set.set(message.id, message);
          reactionTargets.add(message.id);
        }
      }
    }

    for (const message of data.messages) {
      if (message.type === "reaction" && reactionTargets.has(message.targetMessageId)) {
        set.set(message.id, message);
      }
    }

    return Array.from(set.values());
  }

  /**
   * Deletes a set of messages: persist the removals in one transaction, broadcast `messageDeleted`
   * for each while the in-memory mirror is still intact (so reaction DM-audience lookups can resolve
   * their target), then drop them from memory. Shared by the reaper and the delete endpoint.
   */
  function deleteMessages(messages: Message[]): void {
    if (!messages.length) {
      return;
    }

    const ids = new Set(messages.map((message) => message.id));
    // Tombstone alongside the delete: a peer that still holds these must not re-import them. This is
    // unconditional (NOT gated on sync.enabled) — sync is a runtime toggle, so a node that deletes
    // while sync is off and joins a mesh later must still refuse the resurrected copy (docs/11). Bounding
    // tombstone growth is a horizon-GC problem, not a skip-when-off one (docs/15 #7).
    store.transaction(() => {
      for (const id of ids) {
        store.deleteMessage(id);
        store.addTombstone(id);
      }
    });

    for (const id of ids) {
      tombstones.add(id);
    }

    // Best-effort removal of the deleted messages' attachment files.
    for (const message of messages) {
      if (message.type !== "reaction" && message.type !== "sealed") {
        for (const attachment of message.attachments ?? []) {
          rm(join(attachmentsDir, attachmentFileName(attachment)), { force: true }).catch(
            (error: unknown) => server.log.warn(error),
          );
        }
      }
    }

    for (const message of messages) {
      broadcast({ type: "messageDeleted", messageId: message.id, message });
    }

    data.messages = data.messages.filter((message) => !ids.has(message.id));
  }

  /**
   * Registers the client distribution directory as the server's static file root when it exists.
   */
  async function registerStaticFiles(): Promise<void> {
    if (!options.clientDistDir) {
      return;
    }

    try {
      const stats = await stat(options.clientDistDir);

      if (!stats.isDirectory()) {
        return;
      }
    } catch {
      return;
    }

    await server.register(fastifyStatic, {
      root: options.clientDistDir,
      prefix: "/",
    });
    staticFilesRegistered = true;
  }

  try {
    await loadAppConfig();
    loadData();
    reapExpiredMessages();
  } catch (error) {
    // Startup aborted (e.g. `loadAppConfig` fails closed on an invalid config source) — release the SQLite
    // handle opened above so a rejected `buildApp` doesn't leak an open store / lock file (matters under
    // repeated test builds and a supervisor that retries boot).
    store.close();
    throw error;
  }

  if (effectiveAdminBootstrap() === "setupCode" && !anyAdminExists()) {
    adminSetupCode = makeAdminSetupCode();
  }

  void reapOrphanedAttachments();
  void reapOrphanedAvatars().catch((error: unknown) => server.log.error(error));

  const reaperTimer = setInterval(() => {
    // P1-2(c): once a fixed-key kill switch has handed off to the launcher for a restart, `store` is
    // closed and its files are being (or already are) deleted — every one of these calls touches the
    // store or the in-memory mirrors that `awaitingWipeRestart` deliberately froze at `{}` (RF1). A tick
    // that lands in the gap between "wipe requested" and "process actually restarted" must be a pure
    // no-op, not a crash against a closed handle or a resurrection of the frozen (empty) in-memory state.
    if (awaitingWipeRestart) {
      return;
    }

    try {
      reapExpiredMessages();
    } catch (error) {
      server.log.error(error);
    }

    // Drop expired per-IP rate-limit entries (identity budget + claim/panic attempt limiters) so the
    // maps can't grow unbounded across many source IPs (docs/15 #9).
    pruneExpiredRateLimiters();

    void reapOrphanedAttachments().catch((error: unknown) => server.log.error(error));
    void retryMissingAttachments().catch((error: unknown) => server.log.error(error));
  }, 30_000);

  // Sync ticker: a fixed 5s heartbeat; runSyncLoop itself enforces the configured interval (so an
  // admin shortening sync.intervalMs takes effect without re-arming a timer).
  const syncTimer = setInterval(() => {
    // P1-2(c): same reasoning as the reaper gate above — a sync round touches the store and peer
    // sessions, neither of which this process may read/write once a wipe-restart is pending.
    if (awaitingWipeRestart) {
      return;
    }
    void runSyncLoop().catch((error: unknown) => server.log.error(error));
  }, 5_000);

  await registerTransportHooks(ctx);

  // `maxPayload` bounds what `ws` will buffer per inbound frame (see WS_MAX_INBOUND_FRAME_BYTES); a
  // larger frame closes the socket with 1009 before any handler sees it.
  await server.register(fastifyWebsocket, { options: { maxPayload: WS_MAX_INBOUND_FRAME_BYTES } });
  await registerStaticFiles();

  registerSessionRoutes(ctx);
  registerTransportRoutes(ctx);
  registerUserRoutes(ctx);
  registerChannelRoutes(ctx);
  registerMessageRoutes(ctx);
  registerSyncMeshRoutes(ctx);
  registerAdminRoutes(ctx);
  realtime.registerWebSocketRoute();

  server.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      void reply.code(404).send(errorBody("Not found"));
      return;
    }

    if (staticFilesRegistered) {
      void reply.sendFile("index.html");
      return;
    }

    void reply.type("text/html").send("<h1>LOAM server is running</h1><p>Start the client with pnpm dev and open http://localhost:3000.</p>");
  });

  return {
    server,
    // Getter, not a snapshot: the kill switch may close and reopen the store (encrypted wipe).
    get store() {
      return store;
    },
    // Boot-time snapshot (kept for existing callers). The code is also (re)minted/cleared at runtime
    // (kill switch, a config PATCH entering/leaving setupCode), so read the LIVE value via
    // getAdminSetupCode() — a method survives the test wrapper's `{ ...app }` spread, a getter wouldn't.
    adminSetupCode,
    getAdminSetupCode: () => adminSetupCode,
    reapExpiredMessages,
    reapOrphanedAttachments,
    reapOrphanedAvatars,
    retryMissingAttachments,
    pruneExpiredRateLimiters,
    rateLimiterEntryCounts: () => ({
      claim: claimAttempts.size,
      panic: panicAttempts.size,
      identity: identityMintCounters.size,
    }),
    getTransportPublicKey: () =>
      effectiveTransportEncryption() === "off" ? undefined : ensureTransportIdentity().publicKey,
    async close() {
      clearInterval(reaperTimer);
      clearInterval(syncTimer);
      await server.close();
      store.close();
    },
  };
}
