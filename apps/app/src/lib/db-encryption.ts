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
/**
 * The one piece of key material a wipe can actually DISCARD (P1-1, Sol round 4). A user-chosen
 * passphrase can never itself be made cryptographically discardable — the operator can always type it
 * again — so `persistent`/`passphrase` mode both key off this random, device-generated secret instead:
 * `persistent` uses it directly, `passphrase` mixes it into the passphrase's digest (see `resolveDbKey`
 * below). Deleting THIS item (and minting a fresh one on next use) is what makes a wipe of either mode
 * genuinely rotate the key, even though the passphrase itself survives the wipe unchanged.
 */
const DEVICE_SECRET_ITEM = 'loam-db-encryption-device-secret';

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
 * Read (or mint) the device secret that makes `persistent`/`passphrase` mode's key genuinely
 * discardable (P1-1, Sol round 4): 'persistent' uses it AS the key; 'passphrase' mixes it into the
 * passphrase digest (see `resolveDbKey` below). A passphrase alone can never be made cryptographically
 * discardable — the operator can always type it again — so the actual "rotate on wipe" property has to
 * come from this random, device-generated value instead.
 *
 * Migration (not a new mint): a device that already had a `persistent`-mode key from BEFORE this device-
 * secret model (`PERSISTENT_KEY_ITEM`, generated directly as the key) reuses that value as its initial
 * device secret, so an already-encrypted DB keeps opening under the same effective key — only a wipe
 * (`clearStoredDbKeys`, which deletes both items) actually rotates it from here on. A device with
 * neither item mints 32 fresh random bytes.
 *
 * Can throw (Keystore/RNG failure) — callers wrap this in `resolveDbKey`'s outer try/catch, which is
 * the one place that must never let a Keystore failure propagate as a plaintext fallback for these modes.
 */
async function getOrCreateDeviceSecret(): Promise<string> {
  const existing = await SecureStore.getItemAsync(DEVICE_SECRET_ITEM);
  if (typeof existing === 'string' && existing.length > 0) {
    return existing;
  }
  const legacy = await SecureStore.getItemAsync(PERSISTENT_KEY_ITEM);
  if (typeof legacy === 'string' && legacy.length > 0) {
    await SecureStore.setItemAsync(DEVICE_SECRET_ITEM, legacy);
    return legacy;
  }
  const bytes = await Crypto.getRandomBytesAsync(32);
  const generated = bytesToHex(bytes);
  await SecureStore.setItemAsync(DEVICE_SECRET_ITEM, generated);
  return generated;
}

/** Result of {@link clearStoredDbKeys} — P1-2(b), Sol round 4: a REAL success/failure, not a swallowed
 *  best-effort, so `index.tsx` can only ever report the key as "cleared" once it's actually verified
 *  gone, and shows a real failure + Retry otherwise. `error` is a human-readable summary (item names and
 *  generic error messages only) — never the key/passphrase material itself. */
export type ClearDbKeysResult = { ok: boolean; error?: string };

/**
 * Forget the device secret (P1-1, Sol round 4) AND the legacy persistent-mode key item, VERIFYING each
 * is actually gone afterward — never the stored passphrase, which is designed to survive a wipe (see
 * `getOrCreateDeviceSecret`'s doc comment: the passphrase + a freshly-minted device secret together
 * still yield a brand-new key, so the passphrase itself has no reason to be forgotten). After this
 * resolves `{ ok: true }`: 'persistent' mode's next `resolveDbKey` call mints a NEW device secret (a new
 * key); 'passphrase' mode's next call combines the SAME passphrase with that new device secret (also a
 * new key). Either way the OLD ciphertext — already deleted server-side by the kill switch before this
 * is ever invoked — is undecryptable under the new key.
 *
 * Called from `index.tsx`'s `loam-wipe-restart` bridge listener (the server-side kill switch's
 * fixed-key handoff, P1-2) and from its WebView `loam-wipe` message handler (the client's own `wipe`
 * WS-event notice). Real success/failure, NOT swallowed (P1-2b): a delete or verify failure is reported
 * back so the caller can keep its own durable wipe-pending marker around and let the operator retry,
 * rather than silently claiming the key is gone when it might not be. Never logs `key`/passphrase
 * material — only item names and generic error messages.
 */
export async function clearStoredDbKeys(): Promise<ClearDbKeysResult> {
  const errors: string[] = [];

  for (const item of [DEVICE_SECRET_ITEM, PERSISTENT_KEY_ITEM]) {
    try {
      await SecureStore.deleteItemAsync(item);
    } catch (err) {
      errors.push(`delete ${item} failed: ${err instanceof Error ? err.message : String(err)}`);
      continue; // no point verifying a delete that itself threw
    }
    try {
      const remaining = await SecureStore.getItemAsync(item);
      if (remaining !== null) {
        errors.push(`${item} is still present after delete`);
      }
    } catch (err) {
      // A failed verification READ is not proof the item is still there — but it's also not proof it's
      // gone, so it can't be reported as a verified success either. Surface it as its own failure.
      errors.push(`verifying ${item} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return errors.length > 0 ? { ok: false, error: errors.join('; ') } : { ok: true };
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
 *   - 'persistent' → the device secret itself (P1-1, Sol round 4 — see `getOrCreateDeviceSecret`),
 *                    minted once and stored in the Keystore-backed secure store; subsequent calls reuse
 *                    it so the DB stays openable across boots. A wipe (`clearStoredDbKeys`) deletes it,
 *                    so the NEXT boot after a wipe mints a genuinely different one.
 *   - 'passphrase' → `SHA256(passphrase + ':' + deviceSecret)` (Keystore-backed passphrase AND device
 *                    secret). Mixing in the device secret is what makes THIS mode discardable too, even
 *                    though the passphrase itself survives a wipe unchanged (P1-1): after a wipe, the
 *                    SAME passphrase combined with the NEW device secret still yields a brand-new key.
 *                    This is a SIMPLE KDF (a single SHA-256 pass, hex-encoded) — a deliberate v1
 *                    shortcut, not a hardened one; a proper scrypt/Argon2 derivation is a documented
 *                    follow-up (see docs/21). Note this single SHA-256 pass is less weak than it sounds
 *                    in isolation: the resulting hex string is handed to SQLCipher as a `PRAGMA key`,
 *                    and SQLCipher does NOT use it directly as the DB key — it re-derives the actual
 *                    encryption key from that pragma string via its own salted PBKDF2 (64k+ iterations
 *                    by default), so there IS a real KDF between this digest and the on-disk key; this
 *                    module's SHA-256 pass just normalizes the passphrase+secret pair into a
 *                    fixed-length pragma value ahead of that. A stronger app-side KDF is still a
 *                    documented follow-up (docs/21), but "no KDF at all" would overstate the gap. If no
 *                    passphrase has been entered yet, resolves with no key (the UI must collect one
 *                    first via `setStoredPassphrase`) — this module NEVER falls back to plaintext for
 *                    this mode itself; that decision belongs to main.js/index.tsx (see `resolveDbEncryptionAndBoot`'s
 *                    `db_encryption_locked` handling), which must also refuse to boot plaintext here.
 *
 * Never throws — any failure (Keystore unavailable, RNG failure) resolves to `{ mode, key: undefined }`
 * so the caller can decide how to handle a missing key (main.js: refuse to boot plaintext for
 * 'persistent'/'passphrase', see `db_encryption_locked`).
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
      const deviceSecret = await getOrCreateDeviceSecret();
      return { mode, key: deviceSecret };
    }

    // mode === 'passphrase'
    const passphrase = await SecureStore.getItemAsync(PASSPHRASE_ITEM);
    if (typeof passphrase !== 'string' || passphrase.length === 0) {
      // No passphrase entered yet — the picker UI (or the boot-time unlock prompt, see index.tsx) is
      // responsible for collecting one. Returning no key here is what makes main.js treat this as
      // locked (db_encryption_locked) rather than silently booting plaintext.
      return { mode };
    }
    const deviceSecret = await getOrCreateDeviceSecret();
    const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${passphrase}:${deviceSecret}`);
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

export type DbUnlockResult = { ok: boolean; error?: string };

/**
 * Ask the launcher (main.js) to retry boot right now — `db_encryption_locked` recovery (P1-1, Sol round
 * 4): a `persistent`/`passphrase` boot attempt found no usable key (typically passphrase mode before a
 * passphrase was ever entered) and, per the "never boot plaintext for these modes" rule, refused to
 * start the server at all rather than silently downgrade. `index.tsx` calls this after the operator has
 * done something that might now produce a key — for passphrase mode, having just called
 * `setStoredPassphrase`; for persistent mode, as a plain manual retry (e.g. after a transient Keystore
 * hiccup). Mirrors `requestDbStartFresh`'s request/response round trip.
 *
 * This only ever ACKS that the retry was kicked off — the retry's real outcome (ready / still locked /
 * `db_encryption_unreadable` / any other boot error) arrives the normal way, via `loam-status`. Never
 * throws — a timeout, an old launcher build with no handler, or a thrown `post()` all resolve to
 * `{ ok: false }` so the caller can tell the operator to retry rather than hang indefinitely.
 */
export function requestDbUnlock(channel: BridgeChannel, timeoutMs = 5000): Promise<DbUnlockResult> {
  return new Promise((resolve) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let settled = false;

    const finish = (result: DbUnlockResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      channel.removeListener('loam-db-unlock-result', onResult);
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

    channel.addListener('loam-db-unlock-result', onResult);
    try {
      channel.post('loam-db-unlock', { requestId });
    } catch (err) {
      finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}
