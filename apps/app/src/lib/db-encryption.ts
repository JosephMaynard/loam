// RN-side key resolution for on-device DB encryption (PR B — docs/01, docs/21). This is the other half
// of `nodejs-project-template/main.js`'s key-handoff request/response: the embedded server has no
// Keystore access of its own, so the operator's chosen mode — and any generated/derived key material —
// lives entirely here, backed by `expo-secure-store` (Android Keystore). main.js REQUESTS a key at
// boot and this module ANSWERS; see `registerDbEncryption` below.
//
// Security invariants (do not relax without re-reading CLAUDE.md's transport/encryption sections):
//   - Key material for 'persistent'/'passphrase' modes lives ONLY in `expo-secure-store`, never in
//     AsyncStorage or a plain file. The mode selection itself is not secret, but is stored the same way
//     for simplicity (one storage primitive, one dependency).
//   - The ephemeral key is generated fresh on every call and is NEVER persisted anywhere.
//   - Nothing in this module ever logs key or passphrase material.
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

export type DbEncryptionMode = 'off' | 'ephemeral' | 'persistent' | 'passphrase';

export const DB_ENCRYPTION_MODES: readonly DbEncryptionMode[] = ['off', 'ephemeral', 'persistent', 'passphrase'];

/** One-line description shown next to each mode in the picker UI. */
export const DB_ENCRYPTION_MODE_DESCRIPTIONS: Record<DbEncryptionMode, string> = {
  off: 'The on-device database is stored in plain SQLite — todays default.',
  ephemeral: 'A random key generated at each launch, held only in memory. Wipes the database on every restart — nothing survives a reboot.',
  persistent: 'A random key generated once and stored in the device Keystore. Survives reboots; the database stays encrypted at rest.',
  passphrase: 'A key derived from an operator-chosen passphrase, stored in the device Keystore. Survives reboots; anyone who knows the passphrase can also derive the key.',
};

const MODE_ITEM = 'loam-db-encryption-mode';
const PERSISTENT_KEY_ITEM = 'loam-db-encryption-persistent-key';
const PASSPHRASE_ITEM = 'loam-db-encryption-passphrase';

export type ResolvedDbKey = { mode: DbEncryptionMode; key?: string };

/** The subset of the nodejs-mobile bridge channel this module uses (kept loose, matching the other
 * RN↔launcher bridges — on-device-llm.ts, mesh-courier.ts, model-manager-bridge.ts). */
export interface BridgeChannel {
  addListener(name: string, handler: (payload: unknown) => void): void;
  removeListener(name: string, handler: (payload: unknown) => void): void;
  post(name: string, payload: unknown): void;
}

function isDbEncryptionMode(value: unknown): value is DbEncryptionMode {
  return typeof value === 'string' && (DB_ENCRYPTION_MODES as readonly string[]).includes(value);
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

/** Read the operator's persisted mode choice. Defaults to `'off'` on any read failure or absent value —
 * a missing/corrupt setting must never be interpreted as "encrypt". */
export async function getDbEncryptionMode(): Promise<DbEncryptionMode> {
  try {
    const raw = await SecureStore.getItemAsync(MODE_ITEM);
    return isDbEncryptionMode(raw) ? raw : 'off';
  } catch {
    return 'off';
  }
}

/** Persist the operator's mode choice. Best-effort — a failed write just means the picker's next read
 * falls back to `'off'`, the safe default. */
export async function setDbEncryptionMode(mode: DbEncryptionMode): Promise<void> {
  try {
    await SecureStore.setItemAsync(MODE_ITEM, mode);
  } catch {
    // best-effort
  }
}

/** Whether an operator passphrase has already been entered (for the picker UI — it should prompt for
 * one only when this is false, and offer to change it when true). Never returns the passphrase itself. */
export async function hasStoredPassphrase(): Promise<boolean> {
  try {
    const raw = await SecureStore.getItemAsync(PASSPHRASE_ITEM);
    return typeof raw === 'string' && raw.length > 0;
  } catch {
    return false;
  }
}

/** Store (or overwrite) the operator's passphrase in the Keystore-backed secure store. Never written
 * anywhere else — no AsyncStorage, no plain file, no log line. */
export async function setStoredPassphrase(passphrase: string): Promise<void> {
  await SecureStore.setItemAsync(PASSPHRASE_ITEM, passphrase);
}

/** Forget the stored passphrase (e.g. the operator switches away from passphrase mode). Best-effort. */
export async function clearStoredPassphrase(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(PASSPHRASE_ITEM);
  } catch {
    // best-effort
  }
}

/**
 * Forget the persisted 'persistent'-mode key AND the passphrase (Sol P1-1, second half). `resolveDbKey`
 * only ever ROTATES the ephemeral key (a fresh one is generated server-side per boot, see above) —
 * 'persistent'/'passphrase' key material is designed to survive across boots, which also means it
 * survives a kill-switch wipe unless something explicitly clears it: without this, the very next boot
 * after a wipe would re-derive/reuse the SAME key for the brand-new (post-wipe) database, silently
 * defeating a real "rotate the key on a wipe" story for those two modes.
 *
 * Called from the WebView `onMessage` handler in `index.tsx` when the client posts `loam-wipe` (see
 * `apps/client/src/app.tsx`'s `wipe` WS-event handler) — i.e. only on an actual server-side kill-switch
 * wipe, never on an ordinary boot or a local "forget passphrase" action. Best-effort and never throws;
 * a failed delete just means the old key material stays around, exactly as it would have before this
 * function existed. Device-verify: exercised in code, but the end-to-end "wipe → next boot re-derives a
 * genuinely different key" path needs a real device to confirm (this repo has no on-device test harness).
 */
export async function clearStoredDbKeys(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(PERSISTENT_KEY_ITEM);
  } catch {
    // best-effort
  }
  try {
    await SecureStore.deleteItemAsync(PASSPHRASE_ITEM);
  } catch {
    // best-effort
  }
}

/**
 * Resolve the DB-encryption key material for `mode`, generating/persisting it as needed:
 *   - 'off'        → no key.
 *   - 'ephemeral'  → NO key from this module any more (Sol P1-1). main.js recognizes `mode ===
 *                    'ephemeral'` itself and sets the embedded server's `LOAM_DB_KEY` to the LITERAL
 *                    string `'ephemeral'`; the server (apps/server/src/embedded.ts) then generates and
 *                    holds its OWN random RAM-only key. That key living server-side — not here — is
 *                    what lets the kill switch actually ROTATE it on wipe (`executeKillSwitch`): when
 *                    this module used to hand back a fresh key on every call, the key was regenerated
 *                    per BOOT (via this function), not per WIPE, so a wipe with no restart had no key
 *                    here to rotate at all, and "rotation" only ever happened as a side effect of the
 *                    next cold start. Returning no key keeps this module out of that loop entirely —
 *                    `resolveDbEncryptionAndBoot` in main.js special-cases 'ephemeral' and never
 *                    reaches the "no key" plaintext-downgrade path for it.
 *   - 'persistent' → a random 32-byte key, generated once and stored in the Keystore-backed secure
 *                    store; subsequent calls reuse the same key so the DB stays openable across boots.
 *   - 'passphrase' → derived from an operator-entered passphrase (Keystore-backed). This is a SIMPLE
 *                    KDF (single SHA-256 pass over the UTF-8 passphrase, hex-encoded) — a deliberate
 *                    v1 shortcut, not a hardened one; a proper scrypt/Argon2 derivation is a documented
 *                    follow-up (see docs/21). Note this single SHA-256 pass is less weak than it sounds
 *                    in isolation: the resulting hex string is handed to SQLCipher as a `PRAGMA key`,
 *                    and SQLCipher does NOT use it directly as the DB key — it re-derives the actual
 *                    encryption key from that pragma string via its own salted PBKDF2 (64k+ iterations
 *                    by default), so there IS a real KDF between the passphrase and the on-disk key;
 *                    this module's SHA-256 pass just normalizes an arbitrary-length passphrase into a
 *                    fixed-length pragma value ahead of that. A stronger app-side KDF is still a
 *                    documented follow-up (docs/21), but "no KDF at all" would overstate the gap. If no
 *                    passphrase has been entered yet, resolves with no key (the UI must collect one
 *                    first via `setStoredPassphrase`).
 *
 * Never throws — any failure (Keystore unavailable, RNG failure) resolves to `{ mode, key: undefined }`
 * so the caller can fall back to the safe unencrypted default.
 */
export async function resolveDbKey(mode: DbEncryptionMode): Promise<ResolvedDbKey> {
  try {
    if (mode === 'off') {
      return { mode };
    }

    if (mode === 'ephemeral') {
      // No key generated here (see the doc comment above) — main.js sets LOAM_DB_KEY to the literal
      // string 'ephemeral' itself and the server generates its own RAM-only key.
      return { mode };
    }

    if (mode === 'persistent') {
      const existing = await SecureStore.getItemAsync(PERSISTENT_KEY_ITEM);
      if (typeof existing === 'string' && existing.length > 0) {
        return { mode, key: existing };
      }
      const bytes = await Crypto.getRandomBytesAsync(32);
      const generated = bytesToHex(bytes);
      await SecureStore.setItemAsync(PERSISTENT_KEY_ITEM, generated);
      return { mode, key: generated };
    }

    // mode === 'passphrase'
    const passphrase = await SecureStore.getItemAsync(PASSPHRASE_ITEM);
    if (typeof passphrase !== 'string' || passphrase.length === 0) {
      // No passphrase entered yet — the picker UI is responsible for collecting one. Returning no key
      // here is what makes main.js fall back to the safe unencrypted default.
      return { mode };
    }
    const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, passphrase);
    return { mode, key: digest };
  } catch {
    return { mode };
  }
}

/**
 * Wire the DB-encryption key-handoff responder onto the nodejs-mobile channel: on each
 * `loam-db-key-request` from main.js, read the persisted mode, resolve its key material, and post
 * `loam-db-key-response`. Register this in `index.tsx` alongside the other bridge responders
 * (`registerOnDeviceLlm`, `registerMeshCourier`) — order relative to `nodejs.start()` doesn't matter
 * because main.js REQUESTS and waits (with its own timeout), rather than relying on this being
 * registered before the request is posted.
 *
 * Never logs `key` or the passphrase. Returns a cleanup that removes the listener.
 */
export function registerDbEncryption(channel: BridgeChannel): () => void {
  const onRequest = (): void => {
    void (async () => {
      let response: ResolvedDbKey;
      try {
        const mode = await getDbEncryptionMode();
        response = await resolveDbKey(mode);
      } catch {
        response = { mode: 'off' };
      }
      try {
        channel.post('loam-db-key-response', response.key ? { mode: response.mode, key: response.key } : { mode: response.mode });
      } catch {
        // main.js isn't listening (unlikely — it just posted the request) — nothing more to do.
      }
    })();
  };

  channel.addListener('loam-db-key-request', onRequest);
  return () => channel.removeListener('loam-db-key-request', onRequest);
}

export type StartFreshResult = { ok: boolean; error?: string };

/**
 * Ask the launcher (main.js) to write the `.loam-db-start-fresh` confirmation marker into its data
 * directory (design#1 / AF8, docs/01, docs/15). When boot fails with `db_encryption_unreadable` (an
 * encrypted DB that the current key can't open), the operator can explicitly choose "preserve the old
 * database as-is and start a fresh one" — the server consumes and deletes this marker on the next boot
 * as confirmation that a human actually asked for that, rather than the app silently doing it on its
 * own. This module has no direct filesystem access to main.js's `dataDir`
 * (`rnBridge.app.datadir()/loam`), so the write has to happen over there — this is a request/response
 * round trip over the bridge, mirroring `model-manager-bridge.ts`'s `roundTrip` helper.
 *
 * Never throws — a timeout, an old launcher build with no handler, or a thrown `post()` all resolve to
 * `{ ok: false }` so the caller can tell the operator to retry rather than hang indefinitely.
 */
export function requestDbStartFresh(channel: BridgeChannel, timeoutMs = 5000): Promise<StartFreshResult> {
  return new Promise((resolve) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let settled = false;

    const finish = (result: StartFreshResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      channel.removeListener('loam-db-start-fresh-result', onResult);
      resolve(result);
    };

    const onResult = (payload: unknown): void => {
      const result = payload as { requestId?: unknown; ok?: unknown; error?: unknown } | undefined;
      if (!result || result.requestId !== requestId) {
        return;
      }
      finish({ ok: result.ok === true, error: typeof result.error === 'string' ? result.error : undefined });
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: 'The embedded host did not respond (it may not be running yet).' });
    }, timeoutMs);

    channel.addListener('loam-db-start-fresh-result', onResult);
    try {
      channel.post('loam-db-start-fresh', { requestId });
    } catch (err) {
      finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}
