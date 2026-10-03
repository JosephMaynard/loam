/**
 * The setup screens' side effects, before the embedded server starts: finding a previous network, keeping
 * the remembered answers, and preparing a new network (its storage mode, fresh keys, and the starting
 * configuration the launcher writes). The decisions themselves live in setup.ts.
 */
import * as FileSystem from 'expo-file-system/legacy';
import * as SecureStore from 'expo-secure-store';

import {
  clearStoredDbKeys,
  type DbEncryptionMode,
  clearStoredPassphrase,
  DB_ENCRYPTION_MODE_READ_ERROR,
  getDbEncryptionMode,
  setDbEncryptionMode,
  setPendingNewNetwork,
} from '@/lib/db-encryption';
import type { AppLocale } from '@/lib/i18n';
import {
  hasContinuableNetwork,
  parseSetupRecord,
  presetConfig,
  presetDbMode,
  SETUP_RECORD_ITEM,
  type SetupRecord,
} from '@/lib/setup';

// The launcher's data folder: nodejs-mobile's `datadir()` and Expo's documentDirectory are both the app's
// `getFilesDir()`, and main.js keeps the node under `loam/` there.
const DATA_DIR = `${FileSystem.documentDirectory}loam/`;

/** Whether `uri` exists, or `ifUnknown` when that can't be read. */
async function exists(uri: string, ifUnknown: boolean): Promise<boolean> {
  try {
    return (await FileSystem.getInfoAsync(uri)).exists;
  } catch {
    return ifUnknown;
  }
}

/**
 * Whether a previous network can be continued (see `hasContinuableNetwork`). Every unknown errs towards
 * "there's a network to keep": an unreadable database counts as present, and an unreadable ephemeral marker
 * as absent, so a read failure can never make setup offer to start over without the hold-to-erase step.
 */
export async function detectPreviousNetwork(): Promise<boolean> {
  const [database, ephemeralMarker] = await Promise.all([
    exists(`${DATA_DIR}loam.db`, true),
    exists(`${DATA_DIR}.loam-db-ephemeral`, false),
  ]);
  return hasContinuableNetwork({ database, ephemeralMarker });
}

/**
 * Record the chosen storage mode where the launcher's boot decision reads it (main.js `readDbModeHint`),
 * before the runtime starts. Without it, a fresh install whose key handoff then failed (a timeout, a
 * Keystore read error) has no hint and no database, which the launcher treats as nothing to protect and
 * boots unencrypted; with it, an encrypted choice locks instead and Retry resends it. Written in place and
 * read back: a torn write reads as malformed, which the launcher also locks on, so the failure direction
 * is always safe. The launcher rewrites it once the mode is resolved.
 */
async function writeModeHint(mode: DbEncryptionMode): Promise<boolean> {
  const hint = `${DATA_DIR}.loam-db-mode-hint`;
  try {
    await FileSystem.makeDirectoryAsync(DATA_DIR, { intermediates: true });
    await FileSystem.writeAsStringAsync(hint, mode);
    return (await FileSystem.readAsStringAsync(hint)).trim() === mode;
  } catch {
    return false;
  }
}

export async function loadSetupRecord(): Promise<SetupRecord | undefined> {
  try {
    return parseSetupRecord(await SecureStore.getItemAsync(SETUP_RECORD_ITEM));
  } catch {
    return undefined;
  }
}

export function saveSetupRecord(record: SetupRecord): Promise<void> {
  return SecureStore.setItemAsync(SETUP_RECORD_ITEM, JSON.stringify(record)).catch(() => undefined);
}

export type PrepareResult = { ok: true } | { ok: false; error: string };

/**
 * Get everything ready for a new network, before the server starts: set the preset's storage mode, forget
 * the previous network's device keys (so anything of it left on flash stays unreadable, and a new
 * passphrase network derives a new key even from the same passphrase), record the mode for the launcher,
 * and queue the starting configuration, which also tells the launcher to empty the data folder first. A
 * passphrase network chosen through "Choose every setting myself" keeps its passphrase (it is asked for at
 * start-up anyway; `clearStoredDbKeys` never touches it).
 */
export async function prepareNewNetwork(record: SetupRecord, locale: AppLocale): Promise<PrepareResult> {
  const current = await getDbEncryptionMode();
  if (current === DB_ENCRYPTION_MODE_READ_ERROR) {
    return { ok: false, error: "Couldn't read this phone's storage settings." };
  }
  // "Choose every setting myself" keeps an encrypted mode already chosen, and otherwise encrypts like
  // Community: an unset mode reads as 'off' (that's how installs from before encryption read), and a new
  // network must never be unencrypted by default. Plaintext stays a later opt-in, in Encryption settings.
  const target = presetDbMode(record.preset) ?? (current === 'off' ? 'persistent' : current);
  const cleared = await clearStoredDbKeys();
  if (!cleared.ok) {
    return { ok: false, error: cleared.error ?? "Couldn't clear the previous network's keys." };
  }
  if (current === 'passphrase' && target !== 'passphrase') {
    await clearStoredPassphrase();
  }
  if (target !== current) {
    const set = await setDbEncryptionMode(target);
    if (!set.ok) {
      return { ok: false, error: set.error ?? "Couldn't save the storage setting." };
    }
  }
  if (!(await writeModeHint(target))) {
    return { ok: false, error: "Couldn't save the storage setting where the network reads it." };
  }
  setPendingNewNetwork(presetConfig(record.preset, record.nodeName, locale, record.connection === 'join' ? record.peer : undefined));
  return { ok: true };
}
