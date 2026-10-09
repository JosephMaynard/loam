// Shared server types: the socket/session shapes, the in-memory data mirror, the client event union,
// and the public `buildApp` option/handle types.
import type { FastifyInstance } from "fastify";
import type { Channel, DbEncryptionMode, HostApi, Message, NetworkConfig, User } from "@loam/schema";

import type { LoamStore, StoreDriver } from "./db.js";

export type SocketClient = {
  OPEN: number;
  readyState: number;
  send: (payload: string) => void;
  close: () => void;
  on: {
    (event: "close", listener: () => void): void;
    (event: "message", listener: (data: unknown) => void): void;
  };
};

export type SocketSession = {
  socket: SocketClient;
  userId: string;
  /** The socket peer's IP as Fastify saw it (`request.ip`; `trustProxy` is off, so never a forwarded header).
   * Lets the Android launcher ask how many devices are connected from OFF the host (`GET /api/host/clients`). */
  remoteAddress?: string;
  /** Transport session key (docs/08) when the client connected `/ws?enc=<sid>`; outbound frames are
   * then XChaCha20-Poly1305-sealed. Undefined = plaintext frames (transport off / no session). */
  transportKey?: string;
  /** Fresh per-socket id (docs/20 §7). Application frames are sealed under an AAD that includes it, so
   * a frame captured on one connection can't be replayed on a reconnected socket sharing the same
   * transport session. Set only for an encrypted, key-confirmed socket. */
  connectionId?: string;
  /** Monotonic server→client frame sequence for this connection (docs/20 §7) — the client rejects a
   * replayed/stale frame. Starts at 0; `wsSend` pre-increments. */
  frameSeq?: number;
  /** The transport session id this (encrypted) socket rides, so it can be torn down when that session is
   * evicted/pruned (docs/20 §7 — a confirmed socket must not outlive its session key). */
  transportSessionId?: string;
};

export type AppData = {
  users: User[];
  channels: Channel[];
  messages: Message[];
};

export type ClientEvent =
  | {
      type: "messageCreated";
      message: Message;
    }
  | {
      type: "messageUpdated";
      message: Message;
    }
  | {
      type: "messageDeleted";
      messageId: string;
      message: Message;
    }
  | {
      type: "userUpserted";
      user: User;
    }
  | {
      type: "channelUpserted";
      channel: Channel;
    }
  | {
      type: "channelRemoved";
      channelId: string;
    }
  | {
      /** Content-free nudge to moderators and admins only: the report queue changed, so refresh its count. */
      type: "reportsChanged";
    }
  | {
      type: "presence";
      onlineUserIds: string[];
    }
  | {
      // Ephemeral "someone is composing" signal. Never persisted. `channelId` set for channel typing;
      // `dmUserId` (the OTHER participant) set for DM typing. Scoped to the conversation audience, minus
      // the typist, by socketCanReceiveEvent.
      type: "typing";
      userId: string;
      channelId?: string;
      dmUserId?: string;
    }
  | {
      type: "configUpdated";
      networkConfig: NetworkConfig;
    }
  | {
      type: "wipe";
    };

/**
 * Streaming callbacks for on-device LLM inference. The Android host's launcher
 * (`apps/app/nodejs-project-template/main.js`) installs a function of this shape on
 * `globalThis.__loamOnDeviceChat` before requiring the server bundle; it forwards chat messages to
 * the RN/native model over the `rn-bridge` channel and streams the reply back through these
 * callbacks. It is **absent on every other host** (desktop, Pi, CI) — the server checks for it and
 * degrades gracefully — so the server bundle never depends on `rn-bridge` or any native module.
 */
export type OnDeviceChatHook = (
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  callbacks: {
    onDelta: (text: string) => void;
    onEnd: () => void;
    onError: (message: string) => void;
  },
) => void;

export type AppOptions = {
  /** Directory holding the SQLite DB, avatars, and (by default) config.json. */
  dataDir: string;
  /** Config file path; defaults to `<dataDir>/config.json`. */
  configPath?: string;
  /** Built client directory to serve statically; skipped when absent. */
  clientDistDir?: string;
  /**
   * Host used in the join URL returned by /api/bootstrap and /api/config. When set, it's used
   * verbatim on every response (the desktop/Pi CLI resolves its LAN address once at boot and passes
   * it here — fine, since that address is up before the process starts). When left unset, the join
   * host is instead re-resolved via `resolveLanAddress` on every request — the embedded
   * Android host needs this because its Wi-Fi hotspot interface comes up *after* boot, so a
   * boot-frozen address would serve a stale (or missing) host to a QR generated once the hotspot is live.
   */
  joinHost?: string;
  /**
   * Resolves the current best LAN address for the join URL when `joinHost` isn't set. Defaults to a
   * live network-interface scan (`resolveLanIPv4`); overridable so tests can simulate the address
   * changing between requests without touching real interfaces.
   */
  resolveLanAddress?: () => string;
  /** Port used in the join URL returned by /api/config. */
  clientPort?: number;
  /** When set, encrypt the database at rest (SQLCipher). Requires a real data dir, not in-memory. */
  dbEncryptionKey?: string;
  /**
   * A PRIOR key derivation to fall back to if `dbEncryptionKey` can't open the database on boot: the
   * Android launcher's passphrase-mode key derivation changed from `SHA256(passphrase)` (older builds) to
   * `SHA256(passphrase + ':' + deviceSecret)` (current), so a passphrase DB an older build wrote only
   * opens under the OLD derivation. `embedded.ts` threads its `LOAM_DB_KEY_MIGRATE_FROM` env
   * through here. `openInitialStore` tries `dbEncryptionKey` first; only on failure, and only when this
   * is set, does it retry with this key — and on THAT success, `PRAGMA rekey`s the database to
   * `dbEncryptionKey` in place (see `LoamStore.rekey`) so every later boot uses the current key
   * directly, and reports the migration back to the launcher. Never logged.
   */
  dbEncryptionMigrateFromKey?: string;
  /**
   * Encrypt at rest with a **random, RAM-only key** generated at startup and never written to disk
   * (takes precedence over `dbEncryptionKey`). Data is readable only while this process runs — a
   * reboot loses the key permanently — and the kill switch rotates to a fresh key so any
   * flash-recoverable ciphertext becomes unreadable. See `docs/02-kill-switch.md`.
   */
  ephemeralDbKey?: boolean;
  /**
   * The caller's declared at-rest key strategy — both entry points (`embedded.ts`, `server.ts`) pass
   * `LOAM_DB_ENCRYPTION_MODE` through `resolveDbEncryptionMode`, which also treats an undeclared real
   * `LOAM_DB_KEY` as `passphrase`. This is the AUTHORITATIVE mode for
   * `networkConfig.dbEncryption` reporting when present: unlike `appConfig.security.dbEncryption` (a
   * declarative admin-config axis that a headless launcher never PATCHes to match reality), this is
   * what the caller actually did with the key. When absent (no key, most tests), reporting
   * falls back to the declarative config axis. Never changes what encryption is actually
   * used — only `dbEncryptionKey`/`ephemeralDbKey` do that.
   */
  dbEncryptionMode?: DbEncryptionMode;
  /**
   * The launcher's IMMUTABLE per-boot key-handoff request id — `embedded.ts`
   * reads it from `LOAM_DB_KEY_REQUEST_ID` once at boot. Captured here at buildApp time and forwarded in
   * the passphrase-migration ack ({@link reportDbKeyMigrated}) so the RN side promotes only the candidate
   * bound to the attempt that actually opened THIS DB, never a mutable global a later attempt overwrote.
   * Absent on non-launcher hosts (desktop/Pi CLI, tests) — the ack is then an un-correlated no-op RN-side.
   */
  dbKeyRequestId?: string;
  /**
   * Plaintext SQLite backend to use when no encryption key is set. Defaults to `node:sqlite`; the
   * Android host passes `"better-sqlite3"` because its embedded Node 18 lacks `node:sqlite`
   * (see `apps/server/src/db.ts` and docs/04). Ignored when a DB key is set (SQLCipher is used).
   */
  dbDriver?: StoreDriver;
  /** Node version string shown to clients (via `/api/config`). Defaults to `"dev"`. */
  version?: string;
  /**
   * Cap on how many *new* anonymous identities a single client IP may mint within
   * `identityWindowMs`, bounding the user-row/session growth an attacker can force by discarding its
   * session cookie and re-requesting. A device that keeps its cookie mints once and is unaffected; on
   * a LAN each device has its own IP, so this is effectively per-device. Defaults to 60.
   */
  maxNewIdentitiesPerWindow?: number;
  /**
   * Whether a person must agree to LOAM's member rules (the Welcome screen, `MEMBER_RULES_VERSION`) before
   * they can post, upload or create a channel. On by default; tests that aren't about the rules turn it off.
   */
  requireRulesAcceptance?: boolean;
  /** Sliding window (ms) for `maxNewIdentitiesPerWindow`. Defaults to 10 minutes. */
  identityWindowMs?: number;
  /**
   * How long (ms) an identity that nobody ever used may exist before the reaper removes it. Every cookie-less
   * request to `/api/config` (a monitoring probe, a curl, a HEAD) mints and persists a user record; one that
   * never agreed to the member rules, never posted or received a message, holds no role and has no open
   * socket is a ghost on the People list. Defaults to 24 hours; tests shorten it. Only applies while
   * `requireRulesAcceptance` is on (without the rules gate there is no "never agreed" signal).
   */
  unusedIdentityMaxAgeMs?: number;
  /**
   * Hard cap on live transport-encryption sessions (docs/08) — `POST /api/transport/handshake` is
   * deliberately unauthenticated (it's the bootstrap step before any session exists), so without a
   * real bound a flood of handshakes could grow the session map without limit. Expired sessions are
   * pruned on every handshake; once still at/over the cap, the oldest live sessions are evicted to
   * make room. Defaults to 5,000; lowered in tests to exercise eviction without 5,000 iterations.
   */
  transportSessionCap?: number;
  /**
   * How long (ms) a tombstone blocks re-import before the reaper GCs it (docs/15 #7). Defaults to
   * 30 days — deliberately generous, longer than any realistic sync/courier window. Overridable
   * only so tests can exercise the GC without waiting; production deployments should leave it at
   * the default.
   */
  tombstoneHorizonMs?: number;
  /**
   * A per-boot secret proving a caller IS the host process. Set by the Android launcher
   * (`LOAM_HOST_TOKEN`, minted fresh every boot in `main.js` and handed only to the host's own
   * WebView + courier) and by the `loamnet` CLI (`cli/bin/loam.js`, which never hands it out). When
   * present it (1) forces the effective admin bootstrap to `hostDevice` — see `effectiveAdminBootstrap` —
   * so admin comes only from the host (this token, or a host-issued one-time claim code), never from being
   * the first LAN session; and (2) is REQUIRED (header `x-loam-host-token`) on the loopback mesh bridge
   * routes, since on Android loopback is reachable by every installed app, not just the launcher.
   * Unset by the plain `server.ts` entry and in most tests, where the configured strategy applies
   * unchanged — and without it the mesh bridge does not exist at all.
   */
  hostToken?: string;
  /**
   * Request Developer Mode (plaintext transport + verbose logs) directly instead of via `LOAM_DEV_MODE`.
   * Still REFUSED when `NODE_ENV=production`, exactly like the env var, and still self-announcing
   * (`networkConfig.devMode`). Neither the CLI nor the Android host passes it; it exists so tests can
   * exercise the plaintext path now that `off` is not a configurable posture.
   */
  devMode?: boolean;
  logger?: boolean;
  /** Where server logs go (default stdout). Tests pass a capturing sink to assert what is (not) logged. */
  logStream?: { write(line: string): void };
};

export type LoamApp = {
  server: FastifyInstance;
  store: LoamStore;
  /** One-time admin claim code, present when bootstrap is `setupCode` and no admin exists yet. A
   * boot-time snapshot; use `getAdminSetupCode()` to read the value after it's re-minted/cleared at
   * runtime. */
  adminSetupCode?: string;
  /** The live one-time admin claim code (re-minted/cleared at runtime by the kill switch or a config
   * PATCH entering/leaving setupCode bootstrap) — survives the test wrapper's object spread. */
  getAdminSetupCode(): string | undefined;
  /** Delete messages older than the configured retention TTL now (also runs on a timer). */
  reapExpiredMessages(): void;
  /** Remove identities nobody ever used, older than `unusedIdentityMaxAgeMs` (also runs on the reaper timer). */
  reapUnusedIdentities(): void;
  /** Delete unreferenced/abandoned attachment files now (also runs on the reaper timer). */
  reapOrphanedAttachments(): Promise<void>;
  /** Delete avatar image files no user references now (also runs once at boot). */
  reapOrphanedAvatars(): Promise<void>;
  /** Retry attachments that failed to copy during a sync import now (also runs on the reaper timer)
   * — re-fetches missing files from their source peer without re-importing the message. */
  retryMissingAttachments(): Promise<void>;
  /** Drop expired per-IP rate-limit entries (identity budget + claim/panic attempt limiters) now
   * (also runs on the reaper timer) so the maps stay bounded to the IPs active within a window. */
  pruneExpiredRateLimiters(): void;
  /** Test/introspection hook: current entry counts of the per-IP rate-limit maps. */
  rateLimiterEntryCounts(): { claim: number; panic: number; identity: number };
  /** Test/introspection hook: the admitted WebSocket sessions (what `GET /api/host/clients` counts). */
  sockets: Set<SocketSession>;
  /** The host's static transport public key (docs/08) for building a keyed `#k=` join QR, or
   * `undefined` when the effective transport-encryption posture is `off` (Developer Mode). Lets
   * embedding hosts (the `loamnet` CLI, the Android launcher) print a MITM-resistant join QR
   * without an HTTP round-trip that would mint a session (and could consume the `firstUser`
   * admin grant). */
  getTransportPublicKey(): string | undefined;
  /**
   * Emergency Reset from the host device itself (the Android host's menu, through the launcher bridge):
   * the same wipe as `POST /api/admin/kill-switch`, but with no admin session, and regardless of
   * `killSwitch.enabled`, which gates the remote triggers. The phone's owner, holding the phone, can
   * always wipe it. Never reachable from the network. `keyClearRequested` and `journaled` (whether a restart
   * finishes an incomplete wipe): see `KillSwitchResult`.
   */
  emergencyReset(): Promise<{ complete: boolean; keyClearRequested: boolean; journaled: boolean }>;
  /** The in-process host API (host-api.ts) for a launcher on the host machine: the `loamnet` terminal UI. */
  host: HostApi;
  close(): Promise<void>;
};
