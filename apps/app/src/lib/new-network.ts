/**
 * The setup screens' side effects, before the embedded server starts: finding a previous network, keeping
 * the remembered answers, and preparing a new network (its storage mode, fresh keys, and the starting
 * configuration the launcher writes). The decisions themselves live in setup.ts.
 */
import * as FileSystem from 'expo-file-system/legacy';
import * as SecureStore from 'expo-secure-store';

import {
  clearStoredDbKeys,
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

async function exists(uri: string): Promise<boolean> {
  try {
    return (await FileSystem.getInfoAsync(uri)).exists;
  } catch {
    // Unknown: say yes, so a network that might exist is never treated as absent (and silently replaced).
    return true;
  }
}

/** Whether a previous network can be continued (see `hasContinuableNetwork`). */
export async function detectPreviousNetwork(): Promise<boolean> {
  const [database, ephemeralMarker] = await Promise.all([
    exists(`${DATA_DIR}loam.db`),
    exists(`${DATA_DIR}.loam-db-ephemeral`),
  ]);
  return hasContinuableNetwork({ database, ephemeralMarker });
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
 * the previous network's keys (so anything of it left on flash stays unreadable), and queue the starting
 * configuration, which also tells the launcher to empty the data folder first. A passphrase network chosen
 * through "Choose every setting myself" keeps its passphrase (it is asked for at start-up anyway).
 */
export async function prepareNewNetwork(record: SetupRecord, locale: AppLocale): Promise<PrepareResult> {
  const current = await getDbEncryptionMode();
  const target = presetDbMode(record.preset) ?? (current === DB_ENCRYPTION_MODE_READ_ERROR ? undefined : current);
  if (!target) {
    return { ok: false, error: "Couldn't read this phone's storage settings." };
  }
  if (target !== 'passphrase') {
    const cleared = await clearStoredDbKeys();
    if (!cleared.ok) {
      return { ok: false, error: cleared.error ?? "Couldn't clear the previous network's keys." };
    }
    if (current === 'passphrase') {
      await clearStoredPassphrase();
    }
  }
  if (target !== current) {
    const set = await setDbEncryptionMode(target);
    if (!set.ok) {
      return { ok: false, error: set.error ?? "Couldn't save the storage setting." };
    }
  }
  setPendingNewNetwork(presetConfig(record.preset, record.nodeName, locale, record.connection === 'join' ? record.peer : undefined));
  return { ok: true };
}
