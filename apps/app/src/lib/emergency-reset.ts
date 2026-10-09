/**
 * Emergency Reset from the host menu: ask the launcher (main.js `loam-emergency-reset`) to run the server's
 * in-process wipe, and wait for its answer. Mirrors `requestDbStartFresh`'s round trip. Never throws: a
 * timeout, a host that isn't running yet, or a thrown `post()` all resolve to `{ ok: false, error }`.
 */
import { addOwnListener } from './bridge-listener';
import type { BridgeChannel } from './db-encryption';
import { hostErrorText, hostNoResponseText } from './host-errors';

export type EmergencyResetResult =
  /**
   * The wipe ran; `complete` is false when deletion couldn't be fully verified (the node stays locked).
   * `keyClear` is true when the launcher handed this app the device-key clear (`loam-wipe-restart`).
   * `journaled` is false when the server couldn't record the wipe on disk before starting it: an incomplete
   * wipe is then NOT finished by the next boot, and the reset has to be run again (main.js `resetReply`).
   */
  | { ok: true; complete: boolean; keyClear: boolean; journaled: boolean }
  | { ok: false; error: string };

/**
 * What the reset screen does with a result:
 *   - 'close'      everything is erased: close LOAM, so the next launch is a clean start on setup;
 *   - 'key-clear'  erased, but the device key is still being cleared (index.tsx `attemptWipeKeyClear`,
 *                  which closes LOAM once the clear is verified, or shows why it couldn't): never close
 *                  before that, or the clear could be cut off;
 *   - 'incomplete' some data couldn't be erased and verified gone: the node stays locked and the screen
 *                  says so (reopening LOAM finishes the erase from the wipe journal), never closing as if it
 *                  had worked;
 *   - 'unrecorded' the same, but the wipe journal couldn't be written first, so reopening does NOT finish
 *                  the erase: the screen says the reset didn't finish and asks for it to be run again;
 *   - 'failed'     the reset didn't run.
 */
export type ResetOutcome = 'close' | 'key-clear' | 'incomplete' | 'unrecorded' | 'failed';

export function resetOutcome(result: EmergencyResetResult): ResetOutcome {
  if (!result.ok) {
    return 'failed';
  }
  if (!result.complete) {
    return result.journaled ? 'incomplete' : 'unrecorded';
  }
  return result.keyClear ? 'key-clear' : 'close';
}

/**
 * Close LOAM after a reset, once the last shared file's cached copy is gone (lib/save-file.ts
 * `clearSharedFiles`): that folder is otherwise only emptied on the next launch, and a reset is meant to
 * leave nothing behind on this phone. Best effort: a clear that fails never keeps the app open. Dependencies
 * are injected (the native close, the file-system clear) so the ordering is testable without them.
 */
export async function closeAfterReset(clearSharedFiles: () => Promise<void>, closeApp: () => void): Promise<void> {
  try {
    await clearSharedFiles();
  } catch {
    // best effort: the app closes either way
  }
  closeApp();
}

/** Long enough for an encrypted wipe on a slow phone; the server answers as soon as it's done. */
const DEFAULT_TIMEOUT_MS = 30_000;

export function requestEmergencyReset(channel: BridgeChannel, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<EmergencyResetResult> {
  return new Promise((resolve) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let settled = false;

    const finish = (result: EmergencyResetResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      removeListener();
      resolve(result);
    };

    const onResult = (payload: unknown): void => {
      const result = payload as
        | {
            requestId?: unknown;
            ok?: unknown;
            complete?: unknown;
            keyClear?: unknown;
            journaled?: unknown;
            error?: unknown;
            errorCode?: unknown;
          }
        | undefined;
      if (!result || result.requestId !== requestId) {
        return;
      }
      finish(
        result.ok === true
          ? {
              ok: true,
              complete: result.complete === true,
              keyClear: result.keyClear === true,
              // Only an explicit false: an answer without it keeps the reopen-to-finish screen, as before.
              journaled: result.journaled !== false,
            }
          : { ok: false, error: hostErrorText(result) },
      );
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: hostNoResponseText() });
    }, timeoutMs);

    const removeListener = addOwnListener(channel, 'loam-emergency-reset-result', onResult);
    try {
      channel.post('loam-emergency-reset', { requestId });
    } catch (err) {
      finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}
