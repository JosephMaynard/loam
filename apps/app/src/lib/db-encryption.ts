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
 * Resolve the DB-encryption key material for `mode`, generating/persisting it as needed:
 *   - 'off'        → no key.
 *   - 'ephemeral'  → a fresh random 32-byte key, hex-encoded, NEVER stored (in memory only, for the
 *                    life of this resolution — the caller hands it straight to main.js over the bridge).
 *   - 'persistent' → a random 32-byte key, generated once and stored in the Keystore-backed secure
 *                    store; subsequent calls reuse the same key so the DB stays openable across boots.
 *   - 'passphrase' → derived from an operator-entered passphrase (Keystore-backed). This is a SIMPLE
 *                    KDF (single SHA-256 pass over the UTF-8 passphrase, hex-encoded) — a deliberate
 *                    v1 shortcut, not a hardened one; a proper scrypt/Argon2 derivation is a documented
 *                    follow-up (see docs/21). If no passphrase has been entered yet, resolves with no
 *                    key (the UI must collect one first via `setStoredPassphrase`).
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
      const bytes = await Crypto.getRandomBytesAsync(32);
      return { mode, key: bytesToHex(bytes) };
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
