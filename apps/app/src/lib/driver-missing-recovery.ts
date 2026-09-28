// `db_encryption_driver_missing` recovery (pre-release review 2026-09-25) — the actions behind the host
// screen's lock notice (src/app/index.tsx), kept here so they're testable without a renderer
// (src/lib/driver-missing-recovery.test.ts). The SQLCipher module didn't load, so the launcher refused to
// start under an encrypted selection. Two ways out: Retry (re-probe the driver) or a CONFIRMED "Start
// without encryption" (persist mode 'off' and retry) — a real security downgrade, so never a single tap.
import {
  applyDbModeChange,
  type ApplyDbModeChangeDeps,
  type DbEncryptionMode,
  type DbUnlockResult,
} from './db-encryption';
import type { ShowAlert } from './show-alert';

export type StartUnencryptedConfirmation = { title: string; message: string; confirmLabel: string };

/**
 * The confirmation text for switching encryption off. What happens to the existing database depends on the
 * mode that locked: in `ephemeral` mode the launcher already deleted it when it locked (its RAM-only key
 * died with the previous launch, so nothing survives a restart anyway — boot-config.js
 * `deleteStaleEphemeralDb`); in `persistent`/`passphrase` mode it stays on disk, unreadable without
 * encryption. `undefined` = the mode couldn't be read, so the copy covers both.
 */
export function startUnencryptedConfirmation(lockedMode: DbEncryptionMode | undefined): StartUnencryptedConfirmation {
  const intro =
    'Encrypted storage is unavailable on this device. Switching encryption off stores the database ' +
    'UNENCRYPTED from now on.';
  const keptOnDisk =
    'An existing encrypted database stays on disk but cannot be opened without encryption — you will be ' +
    'offered to preserve it and start a fresh one.';
  const ephemeralGone =
    'Ephemeral mode keeps nothing across restarts, so the previous database is already gone and the host ' +
    'starts with an empty one.';
  let detail: string;
  if (lockedMode === 'ephemeral') {
    detail = ephemeralGone;
  } else if (lockedMode === undefined) {
    detail =
      'If this host used ephemeral encryption, its previous database is already gone. Otherwise the existing ' +
      'encrypted database stays on disk but cannot be opened without encryption — you will be offered to ' +
      'preserve it and start a fresh one.';
  } else {
    detail = keptOnDisk;
  }
  return { title: 'Start without encryption?', message: `${intro} ${detail}`, confirmLabel: 'Switch encryption off' };
}

/** Ask first; `onConfirm` runs only when the destructive button is pressed (Cancel does nothing). */
export function confirmStartUnencrypted(
  showAlert: ShowAlert,
  lockedMode: DbEncryptionMode | undefined,
  onConfirm: () => void,
): void {
  const text = startUnencryptedConfirmation(lockedMode);
  showAlert(text.title, text.message, [
    { text: 'Cancel', style: 'cancel' },
    { text: text.confirmLabel, style: 'destructive', onPress: onConfirm },
  ]);
}

export type RetryKeyResolutionDeps = {
  /** The configured mode, when it could be read (a read error leaves it undefined). */
  lockedMode: DbEncryptionMode | undefined;
  writeHint: (mode: DbEncryptionMode) => Promise<unknown>;
  requestUnlock: () => Promise<DbUnlockResult>;
};

/**
 * Retry: re-assert the mode-name hint for the known mode (so a transient key-request failure on the retry
 * locks rather than downgrading to plaintext — best-effort, not awaited), then ask main.js to retry key
 * resolution. The retry's OUTCOME arrives later via `loam-status`.
 */
export function retryKeyResolution(deps: RetryKeyResolutionDeps): Promise<DbUnlockResult> {
  if (deps.lockedMode) {
    void deps.writeHint(deps.lockedMode);
  }
  return deps.requestUnlock();
}

export type SwitchEncryptionOffOutcome = { ok: true } | { ok: false; failed: 'mode' | 'retry'; error: string };

/**
 * "Start without encryption" once confirmed: persist mode 'off' through the same serialized hint+mode
 * transaction the picker uses, and only when that applied ask main.js to retry the boot.
 */
export async function switchEncryptionOffAndRetry(
  deps: ApplyDbModeChangeDeps & { requestUnlock: () => Promise<DbUnlockResult> },
): Promise<SwitchEncryptionOffOutcome> {
  const outcome = await applyDbModeChange('off', {
    readMode: deps.readMode,
    writeMode: deps.writeMode,
    writeHint: deps.writeHint,
  });
  if (!outcome.applied) {
    return { ok: false, failed: 'mode', error: outcome.error ?? 'unknown error' };
  }
  const result = await deps.requestUnlock();
  if (!result.ok) {
    return { ok: false, failed: 'retry', error: result.error ?? 'unknown error' };
  }
  return { ok: true };
}
