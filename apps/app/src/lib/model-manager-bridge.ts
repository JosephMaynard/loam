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
// ← DB-persisted admin edits"). A later admin-UI PATCH still wins on top of this, same as any other
// config.json setting.
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

export type ActiveModelResult = { ok: boolean; error?: string };

type ResultPayload = { requestId?: unknown; ok?: unknown; error?: unknown };

/** Correlate a request/result round trip over the channel, with a timeout so an old/missing launcher
 * build can't hang the UI forever. */
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
      finish({ ok: result.ok === true, error: typeof result.error === 'string' ? result.error : undefined });
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: 'The embedded host did not respond (it may not be running yet).' });
    }, timeoutMs);

    channel.addListener('loam-model-set-active-result', onResult);
    try {
      channel.post('loam-model-set-active', { requestId, ...payload });
    } catch (error) {
      finish({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
}

/** Make `modelPath` (+ optional cosmetic `model` label / `contextSize`) the active on-device model. */
export function setActiveModel(
  channel: BridgeChannel,
  request: SetActiveModelRequest,
  timeoutMs = 5000,
): Promise<ActiveModelResult> {
  return roundTrip(channel, { action: 'set', ...request }, timeoutMs);
}

/** Disable the on-device backend (e.g. after deleting the currently-active model file). */
export function clearActiveModel(channel: BridgeChannel, timeoutMs = 5000): Promise<ActiveModelResult> {
  return roundTrip(channel, { action: 'clear' }, timeoutMs);
}
