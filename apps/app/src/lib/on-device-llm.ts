// RN-side glue for the optional on-device LLM (docs/06). Flow: when the operator enables
// `llm.onDevice`, the embedded Node server calls `global.__loamOnDeviceChat` (installed in
// `nodejs-project-template/main.js`), which posts a `loam-llm-request` over the rn-bridge channel.
// This module answers those requests by running a small model in the RN/native layer and streaming
// tokens back as `loam-llm-delta` / `loam-llm-end` / `loam-llm-error`, which the server turns into
// the same `StreamEvent`s the laptop-Ollama path uses. Nothing else in the LLM path changes.
//
// `runInference` is now wired to a real engine via `llama.rn`: it loads the operator's active GGUF
// (from the model manager) and streams a completion. It ATTEMPTS hardware acceleration where the
// installed llama.rn build supports it, and falls back to CPU otherwise — see `ensureContext` below
// for exactly what's verified vs. assumed (Sol P2-5: this repo has no way to confirm which backends a
// given phone's llama.rn build actually exposes, so treat any GPU/DSP claim as best-effort, per-device).
// It stays fully defensive — no active model, or any load/inference failure, surfaces as a graceful
// assistant error (never a crash), so crisis messaging is unaffected. The remaining DEVICE SEAM is
// only actual on-device token generation (needs a physical arm64 phone + a downloaded GGUF);
// everything up to and including the llama.rn call is built and type-checked.

import { getBackendDevicesInfo, initLlama, type LlamaContext } from 'llama.rn';

import { loadModelManagerState } from './model-manager-store';

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

type LlmRequest = { id?: unknown; messages?: unknown };

/** The subset of the nodejs-mobile bridge channel this module uses (kept loose so it stays decoupled). */
interface BridgeChannel {
  addListener(name: string, handler: (payload: LlmRequest) => void): void;
  removeListener(name: string, handler: (payload: LlmRequest) => void): void;
  post(name: string, payload: unknown): void;
}

interface InferenceCallbacks {
  onDelta: (text: string) => void;
  onEnd: () => void;
  onError: (message: string) => void;
}

// The llama.rn context for the currently-loaded model, kept module-level so we load the (large) GGUF
// once and reuse it across DMs, only reloading when the operator switches the active model.
let loadedContext: LlamaContext | null = null;
let loadedModelPath: string | null = null;
// A llama.cpp context can't run concurrent completions; serialize DMs through a promise chain.
let inferenceChain: Promise<void> = Promise.resolve();

// A generous but bounded ceiling on a single on-device completion. A slow phone can legitimately take
// a while to generate 512 tokens, so this is deliberately long — but a native `completion()` that
// never settles (a wedged/crashed generation) would otherwise wedge `inferenceChain` forever: every
// later DM queues behind the unresolved run and eventually errors, until app restart. On timeout we
// ask the native side to stop (best-effort), DROP the context, and reject — all BEFORE the run settles —
// so the chain advances onto a FRESH context and the next DM runs (see `runInference`).
const INFERENCE_TIMEOUT_MS = 3 * 60 * 1000;

// On a timeout we ask the native side to `stopCompletion()`, but that call itself could hang (the same
// wedged native state that caused the timeout). Bound it so the timeout cleanup can never itself stall
// the inference chain: if `stopCompletion` hasn't settled within this budget we stop waiting and drop
// the context anyway (`releaseLoadedContext` rebuilds a fresh one on the next request regardless).
const STOP_COMPLETION_BUDGET_MS = 2 * 1000;

/** The active downloaded model's local filesystem path (from the model manager), or null if none is
 * selected. Strips the `file://` scheme expo-file-system uses — llama.rn wants a bare path. */
async function activeModelPath(): Promise<string | null> {
  const state = await loadModelManagerState();
  if (!state.activeId) {
    return null;
  }
  const model = state.downloaded.find((entry) => entry.id === state.activeId);
  if (!model || typeof model.uri !== 'string' || model.uri.length === 0) {
    return null;
  }
  return model.uri.replace(/^file:\/\//, '');
}

// The most recent load's hardware-acceleration outcome, as REPORTED BY llama.rn itself (never assumed)
// — see `ensureContext` below. `undefined` until a model has actually been loaded once.
let lastAccelerationInfo: { gpu: boolean; reasonNoGPU: string; devices?: string[] } | undefined;

/** The most recent on-device model load's acceleration outcome, straight from llama.rn's own
 * `LlamaContext.gpu`/`reasonNoGPU`/`devices` — exported for future UI surfacing (today it's logged, see
 * `ensureContext`). `undefined` before any model has loaded. */
export function getLastAccelerationInfo(): { gpu: boolean; reasonNoGPU: string; devices?: string[] } | undefined {
  return lastAccelerationInfo;
}

/**
 * Release the currently-loaded llama.rn context (best-effort) and clear the cached context/path, so its
 * (multi-GB) RAM is reclaimed. Called both when SWITCHING models (see `ensureContext`) and when the
 * active model becomes null — Deactivate, or deleting the active model — so the context doesn't stay
 * resident until app restart (RAM pressure on a device also running the embedded server). The cached
 * references are cleared BEFORE awaiting `release()` so a throwing release still can't leave a stale
 * context that a later call would wrongly reuse.
 */
async function releaseLoadedContext(): Promise<void> {
  if (!loadedContext) {
    return;
  }
  const context = loadedContext;
  loadedContext = null;
  loadedModelPath = null;
  try {
    await context.release();
  } catch {
    // best-effort — a failed release must never block the caller; the cached references are already clear.
  }
}

/**
 * Ask the native side to abandon the current completion, BOUNDED by `STOP_COMPLETION_BUDGET_MS` so the
 * stop request can't itself hang the timeout cleanup (the wedged native state that triggered the timeout
 * could just as easily wedge `stopCompletion`). Races the (possibly-never-settling) native call against a
 * short timer and returns once either wins. Fully defensive: a synchronous throw or a rejected promise
 * from `stopCompletion` is swallowed — the caller drops the context regardless, so a failed stop can only
 * cost us the old context, never correctness.
 */
async function stopCompletionWithinBudget(context: LlamaContext): Promise<void> {
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve(context.stopCompletion()).catch(() => undefined),
      new Promise<void>((resolve) => {
        budgetTimer = setTimeout(resolve, STOP_COMPLETION_BUDGET_MS);
      }),
    ]);
  } catch {
    // stopCompletion threw synchronously / isn't available — nothing more we can do; drop the context.
  } finally {
    if (budgetTimer !== undefined) {
      clearTimeout(budgetTimer);
    }
  }
}

/**
 * Explicitly release the loaded context when the operator DEACTIVATES the on-device model, or DELETES the
 * model that was active (Fix 2). Without this the multi-GB context is only reclaimed when a LATER inference
 * happens to notice there's no active model — so a Deactivate followed by no further DM would leave it
 * resident indefinitely, and deleting the file could unlink bytes the old context still has mapped. Runs
 * SERIALIZED behind any in-flight inference (chained onto `inferenceChain`, the same lock `runInference`
 * uses) so it can't release a context out from under a running completion. The chain is kept alive across
 * a rejection so one failure can't wedge every later run; `releaseLoadedContext` swallows its own errors,
 * so this never throws and is safe to call fire-and-forget (`void`).
 */
export function releaseActiveModelContext(): Promise<void> {
  const run = inferenceChain.then(() => releaseLoadedContext());
  inferenceChain = run.catch(() => undefined);
  return run;
}

/**
 * Load (or reuse) the llama.rn context for `modelPath`, releasing a previously-loaded different model
 * first.
 *
 * Hardware acceleration (Sol P2-5): this ATTEMPTS acceleration, but never claims it's delivered.
 * `devices` is intentionally left unset — per llama.rn 0.12.6's own `ContextParams` doc comment, an
 * unset `devices` already defaults to the full result of `getBackendDevicesInfo()` (i.e. every backend
 * device the native build detects, GPU/accelerator included, with CPU as the implicit fallback), so
 * explicitly re-deriving and passing the same list would only add a chance of getting it wrong (e.g. on
 * a build/device where the detected device name doesn't match what the native side expects) for no
 * behavioural gain. `getBackendDevicesInfo()` is still called and logged below, purely for diagnostics
 * (verifiable over `adb logcat`, same as the rest of this launcher) — LOAM has no way to independently
 * confirm which backend a given phone's llama.rn build actually wires up (Q4_0/Q6_K are the OpenCL-
 * supported quants; every catalog entry today is Q4_K_M — see model-catalog.ts — so GPU offload via
 * OpenCL is unlikely even when a GPU device is detected; Hexagon/HTP needs its own device-side
 * extraction this module doesn't drive). `n_gpu_layers` is ALSO not a reliable Android lever — llama.rn's
 * own type doc marks it "Currently only for iOS" — so it's passed for parity but not relied on. The
 * actual outcome (`gpu`/`reasonNoGPU`/`devices`) is read back from the loaded context and captured in
 * `lastAccelerationInfo` (see `getLastAccelerationInfo`) rather than assumed from any of this.
 */
async function ensureContext(modelPath: string): Promise<LlamaContext> {
  if (loadedContext && loadedModelPath === modelPath) {
    return loadedContext;
  }
  await releaseLoadedContext();
  try {
    const devices = await getBackendDevicesInfo();
    console.log('LOAM on-device LLM: detected backend devices', JSON.stringify(devices));
  } catch (error) {
    // Diagnostic-only — a probe failure must never block loading the model.
    console.warn('LOAM on-device LLM: getBackendDevicesInfo() failed', error);
  }
  // n_ctx is a fixed constant, not read from config.json's llm.onDevice.contextSize: this module reads
  // the active model from its OWN local model-manager-store.json (see activeModelPath above), not from
  // config.json, and nothing in the RN model-manager UI currently collects a context-size choice from
  // the operator — threading contextSize through would need new UI + storage plumbing, not just
  // reading a field (see model-manager-bridge.ts's header comment for the full config.json story).
  // Left as a documented follow-up rather than half-wired.
  const context = await initLlama({ model: modelPath, n_ctx: 4096, n_gpu_layers: 99 });
  lastAccelerationInfo = { gpu: context.gpu, reasonNoGPU: context.reasonNoGPU, devices: context.devices };
  console.log(
    'LOAM on-device LLM: model loaded — gpu=%s reasonNoGPU=%s devices=%s',
    context.gpu,
    context.reasonNoGPU,
    JSON.stringify(context.devices),
  );
  loadedContext = context;
  loadedModelPath = modelPath;
  return context;
}

/**
 * Run the on-device model over `messages`, streaming reply text through the callbacks. Loads the
 * operator's active GGUF (from the model manager) via llama.rn, reusing the context across calls, and
 * serializes concurrent DMs (one llama.cpp context can't run parallel completions). Any failure — no
 * active model, a load error, an inference error — is reported via `onError`; this never throws, so a
 * missing/broken model degrades to a graceful assistant error and never affects crisis messaging.
 */
async function runInference(messages: ChatMessage[], callbacks: InferenceCallbacks): Promise<void> {
  const run = inferenceChain.then(async () => {
    try {
      const modelPath = await activeModelPath();
      if (!modelPath) {
        // No active model (Deactivate, or the active model was deleted): release the loaded context so
        // its RAM is reclaimed rather than left resident until app restart (it's otherwise only released
        // on a model SWITCH). Best-effort — a release failure must not prevent surfacing the error below.
        await releaseLoadedContext();
        callbacks.onError('No on-device model is selected. Download and activate one from the AI model manager.');
        return;
      }
      const context = await ensureContext(modelPath);
      // Race the native completion against a bounded timeout so a wedged generation can't stall the
      // inference chain forever (see INFERENCE_TIMEOUT_MS). The completion callback still streams each
      // token to `onDelta` on the success path — unchanged; only the never-settles case is bounded.
      //
      // Fix 1: a timed-out completion must NOT let a SECOND completion run on the same native context.
      // `stopCompletion()` is best-effort and the original native `completion()` may keep running after
      // it, so we (a) flip `deltasEnabled` false so the wedged run's late tokens are dropped rather than
      // posted after `onError`, and (b) do the stop + `releaseLoadedContext()` BEFORE the timeout promise
      // rejects. Because the serialized `inferenceChain` only advances once THIS run settles, and because
      // `releaseLoadedContext` nulls `loadedContext` before awaiting `release()`, the next request's
      // `ensureContext` builds a FRESH native context — so "no two completions on the same context" holds
      // even while the old native completion is still winding down, and only one context is ever resident.
      let deltasEnabled = true;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timeoutTimer = setTimeout(() => {
          // Drop any further tokens from the still-running native completion (no late `onDelta` after the
          // `onError` below).
          deltasEnabled = false;
          // Do the async cleanup BEFORE settling: bounded best-effort stop, THEN drop the possibly-still-
          // busy context so it can never be reused. Only after both does the timeout reject — so the chain
          // (which advances on this run settling) cannot reach the next request until the context is gone.
          // Neither helper rejects (both swallow their own errors), so `reject` is always reached.
          void (async () => {
            await stopCompletionWithinBudget(context);
            await releaseLoadedContext();
            reject(new Error(`On-device inference timed out after ${Math.round(INFERENCE_TIMEOUT_MS / 1000)}s.`));
          })();
        }, INFERENCE_TIMEOUT_MS);
      });
      try {
        await Promise.race([
          context.completion(
            {
              messages,
              n_predict: 512,
              // Gemma's turn terminator (+ the generic end token); llama.rn stops on any match.
              stop: ['<end_of_turn>', '<eos>'],
            },
            (data) => {
              // After a timeout the original completion can still fire callbacks while it winds down —
              // drop them so no token is posted after the run already reported `onError` (Fix 1).
              if (!deltasEnabled) {
                return;
              }
              const token = data?.token;
              if (typeof token === 'string' && token.length > 0) {
                callbacks.onDelta(token);
              }
            },
          ),
          timeout,
        ]);
      } finally {
        // Always clear the timer — on the success path so it can't fire after we've resolved, and on
        // the timeout/error path it's a harmless no-op.
        if (timeoutTimer !== undefined) {
          clearTimeout(timeoutTimer);
        }
      }
      callbacks.onEnd();
    } catch (error) {
      callbacks.onError(error instanceof Error ? error.message : String(error));
    }
  });
  // Keep the chain alive regardless of this run's outcome so the next DM still queues behind it.
  inferenceChain = run.catch(() => undefined);
  return run;
}

/**
 * Wire the on-device LLM request/response bridge onto the nodejs-mobile channel. Safe to call on any
 * platform — if no on-device requests ever arrive (backend disabled, or non-Android), it does
 * nothing. Returns a cleanup that removes the listener.
 */
const CHAT_ROLES = new Set(['system', 'user', 'assistant']);

/** Validate a single message from the bridge (defensive — each entry's role + content, not just the
 * array container) so a malformed payload can never reach the model. */
function isChatMessage(value: unknown): value is ChatMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    CHAT_ROLES.has((value as { role?: unknown }).role as string) &&
    typeof (value as { content?: unknown }).content === 'string'
  );
}

/** `channel.post` can throw (e.g. the bridge is torn down mid-stream, screen unmounted) — called from
 * inside `runInference`'s callbacks, that throw would otherwise become an unhandled rejection deep in
 * a promise chain instead of a harmless no-op (mirrors `db-encryption.ts`'s `registerDbEncryption`). */
function safePost(channel: BridgeChannel, name: string, payload: unknown): void {
  try {
    channel.post(name, payload);
  } catch {
    // the RN bridge isn't listening any more — nothing more to do.
  }
}

export function registerOnDeviceLlm(channel: BridgeChannel): () => void {
  const onRequest = (payload: LlmRequest): void => {
    const id = payload?.id;

    if (id === undefined || id === null) {
      return;
    }

    const messages: ChatMessage[] = (Array.isArray(payload?.messages) ? payload.messages : []).filter(isChatMessage);

    void runInference(messages, {
      onDelta: (text) => safePost(channel, 'loam-llm-delta', { id, text }),
      onEnd: () => safePost(channel, 'loam-llm-end', { id }),
      onError: (message) => safePost(channel, 'loam-llm-error', { id, error: message }),
    }).catch((error: unknown) => {
      safePost(channel, 'loam-llm-error', { id, error: error instanceof Error ? error.message : String(error) });
    });
  };

  channel.addListener('loam-llm-request', onRequest);
  return () => channel.removeListener('loam-llm-request', onRequest);
}
