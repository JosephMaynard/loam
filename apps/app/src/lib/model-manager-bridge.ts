// RN-side glue that tells the embedded launcher (nodejs-project-template/main.js) which on-device
// model to use — the other half of the "how does the downloaded file's path reach
// `llm.onDevice.modelPath`" question (docs/06). Mirrors `on-device-llm.ts` / `mesh-courier.ts`: RN and
// the embedded Node process only ever talk over the nodejs-mobile channel here, never HTTP.
//
// That's deliberate, not just "simplest": main.js's own `waitForServer` comment explains that probing
// `/api/config` (or any other cookie-minting route) from this process would silently steal the
// one-time `firstUser` admin grant from the human operator on a fresh node. The model manager runs in
// this same RN/launcher process, so it's bound by the same constraint — it must never `fetch()` an
// authenticated server route. Instead it asks the launcher (which already knows its own on-device
// `dataDir`/`config.json` path) to merge `llm.onDevice` into that file directly — the same boot-time
// config layer an operator would otherwise hand-edit (see CLAUDE.md: "layered defaults ← config.json
// ← DB-persisted admin edits").
//
// IMPORTANT — what config.json's `llm.onDevice` actually drives, and what it doesn't: the server only
// reads `enabled` (whether the on-device assistant appears as a DM contact at all) and `model` (a
// cosmetic label shown to the operator). It does NOT read `modelPath`/`contextSize` to pick or
// configure the model that actually runs inference — the RN/native side is authoritative there:
// `on-device-llm.ts`'s `activeModelPath()` loads whatever the model manager's OWN local
// `model-manager-store.json` currently marks as `activeId`, entirely independent of this file (n_ctx
// is likewise a fixed constant in `on-device-llm.ts`, not read from `contextSize`). So an admin
// `POST /api/admin/config` PATCH of `llm.onDevice.modelPath`/`contextSize` has NO effect on which
// model actually loads or how — those fields are written here purely for operator visibility/
// debugging; only toggling `enabled`/`model` (the label) has any real effect server-side.
//
// Because nodejs-mobile can't restart its runtime in-process (see index.tsx), this takes effect the
// NEXT time the app (re)starts the embedded server — the caller is expected to say so in the UI.
export interface BridgeChannel {
  addListener(name: string, handler: (payload: unknown) => void): void;
  removeListener(name: string, handler: (payload: unknown) => void): void;
  post(name: string, payload: unknown): void;
}

export type SetActiveModelRequest = {
  modelPath: string;
  model?: string;
  contextSize?: number;
};

/**
 * Outcome of a bridge round trip, as a THREE-way discriminated result rather than a bare
 * `{ ok: boolean }` (P2-1 round 5). The distinction is load-bearing for the caller's rollback
 * decision:
 *   - `'ok'`     — the launcher explicitly reported success. The write landed.
 *   - `'failed'` — the launcher explicitly reported failure (`ok:false`), OR the request could not be
 *                  posted at all (a synchronous `channel.post` throw means it never went out). Either
 *                  way the write DEFINITELY did not happen, so the caller can safely roll back.
 *   - `'timeout'` — no result arrived within the window. This is AMBIGUOUS, not a failure: `main.js`
 *                  writes `config.json` and THEN posts its ack, so a dropped/late ack (or an overlay
 *                  that unmounted before it arrived) can leave the write having ALREADY landed. Rolling
 *                  back here is exactly the divergence the fix prevents — config.json holds the new
 *                  selection while RN state gets reverted to the old one. The caller must NOT roll back
 *                  on this; because these launcher writes are idempotent, `roundTripWithRetry` below
 *                  first retries, and only a persisted `'timeout'` reaches the caller as "couldn't
 *                  confirm".
 */
export type ActiveModelResult =
  | { status: 'ok'; error?: undefined }
  | { status: 'failed'; error?: string }
  | { status: 'timeout'; error?: string };

type ResultPayload = { requestId?: unknown; ok?: unknown; error?: unknown };

/** How many times a timed-out (ack-lost) round trip is retried before giving up as "couldn't confirm".
 * Bounded so a genuinely-dead launcher can't loop forever; safe to retry because the underlying
 * launcher writes (`llm.onDevice` set/clear) are idempotent — writing the same value again is a no-op. */
export const MAX_BRIDGE_ATTEMPTS = 3;

const TIMEOUT_ERROR = 'The embedded host did not respond (it may not be running yet).';

/** Correlate a single request/result round trip over the channel, with a timeout so an old/missing
 * launcher build can't hang the UI forever. Resolves `'timeout'` on ack loss (AMBIGUOUS — see
 * `ActiveModelResult`), `'failed'` on an explicit `ok:false` or a post throw, `'ok'` on success. */
function roundTrip(
  channel: BridgeChannel,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<ActiveModelResult> {
  return new Promise((resolve) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let settled = false;

    const finish = (result: ActiveModelResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      channel.removeListener('loam-model-set-active-result', onResult);
      resolve(result);
    };

    const onResult = (raw: unknown) => {
      const result = raw as ResultPayload | undefined;
      if (!result || result.requestId !== requestId) {
        return;
      }
      const error = typeof result.error === 'string' ? result.error : undefined;
      finish(result.ok === true ? { status: 'ok' } : { status: 'failed', error });
    };

    const timer = setTimeout(() => {
      // Ack loss / no response — AMBIGUOUS, not a confirmed failure (the config.json write may already
      // have landed). Reported as its own status so the caller never rolls back on it.
      finish({ status: 'timeout', error: TIMEOUT_ERROR });
    }, timeoutMs);

    channel.addListener('loam-model-set-active-result', onResult);
    try {
      channel.post('loam-model-set-active', { requestId, ...payload });
    } catch (error) {
      // A synchronous post failure means the message never went out — the launcher never saw it, so the
      // write definitely did not happen. That IS a confirmed failure (safe to roll back), not a timeout.
      finish({ status: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
  });
}

/**
 * Round-trip with bounded idempotent retry (P2-1 round 5). A confirmed result (`'ok'` or `'failed'`)
 * returns immediately. A `'timeout'` (ack loss) is retried up to `maxAttempts` times — safe because
 * the launcher write is idempotent — since the likeliest cause is a dropped/late ack rather than the
 * write not happening. If every attempt times out, the final `'timeout'` is returned so the caller can
 * surface an explicit "couldn't confirm — will reconcile on next open" state instead of a wrong
 * rollback.
 */
async function roundTripWithRetry(
  channel: BridgeChannel,
  payload: Record<string, unknown>,
  timeoutMs: number,
  maxAttempts: number,
): Promise<ActiveModelResult> {
  let last: ActiveModelResult = { status: 'timeout', error: TIMEOUT_ERROR };
  for (let attempt = 0; attempt < Math.max(1, maxAttempts); attempt += 1) {
    const result = await roundTrip(channel, payload, timeoutMs);
    if (result.status !== 'timeout') {
      return result;
    }
    last = result;
  }
  return last;
}

/** Make `modelPath` (+ optional cosmetic `model` label / `contextSize`) the active on-device model. */
export function setActiveModel(
  channel: BridgeChannel,
  request: SetActiveModelRequest,
  timeoutMs = 5000,
  maxAttempts = MAX_BRIDGE_ATTEMPTS,
): Promise<ActiveModelResult> {
  return roundTripWithRetry(channel, { action: 'set', ...request }, timeoutMs, maxAttempts);
}

/** Disable the on-device backend (e.g. after deleting the currently-active model file). */
export function clearActiveModel(
  channel: BridgeChannel,
  timeoutMs = 5000,
  maxAttempts = MAX_BRIDGE_ATTEMPTS,
): Promise<ActiveModelResult> {
  return roundTripWithRetry(channel, { action: 'clear' }, timeoutMs, maxAttempts);
}
