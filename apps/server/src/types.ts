// Shared server types: the socket/session shapes, the in-memory data mirror, the client event union,
// and the public `buildApp` option/handle types. Extracted from app.ts (2026-09-04 split).
import type { FastifyInstance } from "fastify";
import type { Channel, DbEncryptionMode, Message, NetworkConfig, User } from "@loam/schema";

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
      type: "presence";
      onlineUserIds: string[];
    }
  | {
      // Ephemeral "someone is composing" signal (P14). Never persisted. `channelId` set for channel typing;
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
   * host is instead re-resolved via `resolveLanAddress` on every request (docs/15 A7) — the embedded
   * Android host needs this because its Wi-Fi hotspot interface comes up *after* boot, so a
   * boot-frozen address served a stale (or missing) host to a QR generated once the hotspot is live.
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
   * A PRIOR key derivation to fall back to if `dbEncryptionKey` can't open the database on boot (P1-1,
   * Sol round 5): the Android launcher's passphrase-mode key derivation changed from `SHA256(passphrase)`
   * (pre-round-4) to `SHA256(passphrase + ':' + deviceSecret)` (round 4+), so an existing passphrase DB
   * only opens under the OLD derivation. `embedded.ts` threads its `LOAM_DB_KEY_MIGRATE_FROM` env
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
   * The caller's declared at-rest key strategy (P1-1/P2-1, docs/15) — the Android launcher threads its
   * `LOAM_DB_ENCRYPTION_MODE` env through here (`embedded.ts`). This is the AUTHORITATIVE mode for
   * `networkConfig.dbEncryption` reporting when present: unlike `appConfig.security.dbEncryption` (a
   * declarative admin-config axis that a headless launcher never PATCHes to match reality), this is
   * what the caller actually did with the key. When absent (desktop/Pi CLI, most tests), reporting
   * falls back to the declarative config axis as before. Never changes what encryption is actually
   * used — only `dbEncryptionKey`/`ephemeralDbKey` do that.
   */
  dbEncryptionMode?: DbEncryptionMode;
  /**
   * The launcher's IMMUTABLE per-boot key-handoff request id (Sol Fable-round-2 P1-B) — `embedded.ts`
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
  /** Sliding window (ms) for `maxNewIdentitiesPerWindow`. Defaults to 10 minutes. */
  identityWindowMs?: number;
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
   * A per-boot secret proving a caller IS the host process (review 2026-09-04). Set by the Android
   * launcher (`LOAM_HOST_TOKEN`, minted fresh every boot in `main.js` and handed only to the host's own
   * WebView + courier). When present it (1) forces the effective admin bootstrap to `hostDevice` — see
   * `effectiveAdminBootstrap` — so admin is claimable ONLY by presenting this token, never by being the
   * first LAN session; and (2) is REQUIRED (header `x-loam-host-token`) on the loopback mesh bridge
   * routes, since on Android loopback is reachable by every installed app, not just the launcher.
   * Unset on the desktop/Pi CLI and in tests, where the configured strategy applies unchanged.
   */
  hostToken?: string;
  logger?: boolean;
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
  /** Delete unreferenced/abandoned attachment files now (also runs on the reaper timer). */
  reapOrphanedAttachments(): Promise<void>;
  /** Delete avatar image files no user references now (also runs once at boot). */
  reapOrphanedAvatars(): Promise<void>;
  /** Retry attachments that failed to copy during a sync import now (also runs on the reaper timer;
   * docs/15 A6) — re-fetches missing files from their source peer without re-importing the message. */
  retryMissingAttachments(): Promise<void>;
  /** Drop expired per-IP rate-limit entries (identity budget + claim/panic attempt limiters) now
   * (also runs on the reaper timer) so the maps stay bounded to the IPs active within a window. */
  pruneExpiredRateLimiters(): void;
  /** Test/introspection hook: current entry counts of the per-IP rate-limit maps. */
  rateLimiterEntryCounts(): { claim: number; panic: number; identity: number };
  /** The host's static transport public key (docs/08) for building a keyed `#k=` join QR, or
   * `undefined` when the effective transport-encryption posture is `off` (Developer Mode). Lets
   * embedding hosts (the `loamnet` CLI, the Android launcher) print a MITM-resistant join QR
   * without an HTTP round-trip that would mint a session (and could consume the `firstUser`
   * admin grant). */
  getTransportPublicKey(): string | undefined;
  close(): Promise<void>;
};
