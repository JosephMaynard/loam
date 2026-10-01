/**
 * Emergency Reset from the host menu: ask the launcher (main.js `loam-emergency-reset`) to run the server's
 * in-process wipe, and wait for its answer. Mirrors `requestDbStartFresh`'s round trip. Never throws: a
 * timeout, a host that isn't running yet, or a thrown `post()` all resolve to `{ ok: false, error }`.
 */
import { addOwnListener } from './bridge-listener';
import type { BridgeChannel } from './db-encryption';

export type EmergencyResetResult =
  /** The wipe ran; `complete` is false when deletion couldn't be fully verified (the node stays locked). */
  | { ok: true; complete: boolean }
  | { ok: false; error: string };

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
      const result = payload as { requestId?: unknown; ok?: unknown; complete?: unknown; error?: unknown } | undefined;
      if (!result || result.requestId !== requestId) {
        return;
      }
      finish(
        result.ok === true
          ? { ok: true, complete: result.complete === true }
          : { ok: false, error: typeof result.error === 'string' ? result.error : 'unknown error' },
      );
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: 'The host did not answer in time.' });
    }, timeoutMs);

    const removeListener = addOwnListener(channel, 'loam-emergency-reset-result', onResult);
    try {
      channel.post('loam-emergency-reset', { requestId });
    } catch (err) {
      finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}
