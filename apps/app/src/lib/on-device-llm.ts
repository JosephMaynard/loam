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

// ── Engine cleanup state machine (Sol P1: timeout recovery could double-load native contexts and OOM) ──
// A fresh native llama.rn context must NEVER be created while an OLDER context's `release()` is still
// unresolved. In llama.rn, `release()` waits for outstanding native tasks before it actually deletes the
// context, so calling `initLlama` in that window loads a second multi-GB model while the first is still
// resident — an OOM/crash on the constrained devices this targets, strictly worse than a temporary LLM
// error. So ALL context teardown funnels through one path (`beginRelease`) that drives this state, and
// `ensureContext` refuses to load unless the engine is `ready`:
//
//   'ready'      — no release outstanding; `ensureContext` may reuse or build a context.
//   'releasing'  — an old context's `release()` is in flight; `ensureContext` refuses (fail-fast recovery
//                  error) until it RESOLVES, which returns the engine to `ready` so a later request builds
//                  fresh. The next request gates on THIS state, not on awaiting the release — so nothing
//                  the timeout/cleanup path does can wedge the serialized inference chain.
//   'poisoned'   — an old `release()` REJECTED; the native context may still be resident and we can never
//                  safely `initLlama` again in this process. Terminal until app restart.
//   'loading'    — an `initLlama` is in flight (see `ensureContext`, Sol Fable-round-4 P1). Bounded for the
//                  operator-visible caller, but a native load that never settles must not wedge the chain or
//                  publish a stale context after the operator moved on. `ensureContext` refuses a SECOND load
//                  while one is in flight (no double-load/OOM); a load ABANDONED by a timeout / deactivate /
//                  delete (its `currentLoadId` bumped) has its late context routed through the release path
//                  instead of being published.
type EngineStatus = 'ready' | 'loading' | 'releasing' | 'poisoned';
let engineStatus: EngineStatus = 'ready';
// The in-flight `initLlama`'s model path (or null), and a monotonically-bumped id that identifies THIS load
// attempt. `invalidateLoad` bumps the id so a native load that resolves AFTER a timeout / deactivate / delete
// is recognised as stale and disposed rather than published as the active context (Sol Fable-round-4 P1).
let loadingPath: string | null = null;
let currentLoadId = 0;
// The bare path of the context whose native `release()` is CURRENTLY in flight, and its tracking promise
// (CodeRabbit). After `beginRelease` detaches the context, `loadedContext` is null — so a RETRY of the delete
// barrier for that same model would otherwise see "nothing loaded" and wrongly report 'released' while the
// native disposal is still ongoing, letting the caller unlink a still-mapped file. These let the barrier
// recognise "this model is still releasing" and await/inspect that release instead. Cleared when it settles.
let releasingPath: string | null = null;
let releasingPromise: Promise<void> | null = null;

/** Shown when a request arrives while a previous context is still being disposed (`releasing`). Transient —
 * a moment later the release resolves and the engine is usable again; the restart hint covers the rare case
 * where a native release is pathologically slow. */
const ENGINE_RECOVERING_MESSAGE =
  'The on-device model engine is still recovering — try again in a moment, or restart the LOAM host app if this persists.';
/** Shown once the engine is `poisoned` (a native `release()` rejected). We refuse to build another context
 * this process, so only an app restart can recover — say so plainly rather than implying a retry will help. */
const ENGINE_POISONED_MESSAGE =
  'The on-device model engine needs a restart — close and reopen the LOAM host app to use on-device AI again.';
/** Shown when `initLlama` (the model load) exceeds `MODEL_LOAD_TIMEOUT_MS` (Sol Fable-round-4 P1). The load
 * is abandoned so it can't wedge the inference chain; a later request retries once the native load settles. */
const ENGINE_LOAD_TIMEOUT_MESSAGE =
  'Loading the on-device model timed out — try again in a moment, or restart the LOAM host app if it persists.';

/** Bounded ceiling on a single `initLlama` load. A multi-GB model on a slow phone can legitimately take a
 * while, so this is generous — but a native load that NEVER settles must not wedge `inferenceChain` forever
 * (the same never-settling-async class as the completion timeout). On timeout the request errors and the
 * chain advances; the abandoned native load's late context is disposed, never published. */
const MODEL_LOAD_TIMEOUT_MS = 3 * 60 * 1000;

// A generous but bounded ceiling on a single on-device completion. A slow phone can legitimately take
// a while to generate 512 tokens, so this is deliberately long — but a native `completion()` that
// never settles (a wedged/crashed generation) would otherwise wedge `inferenceChain` forever: every
// later DM queues behind the unresolved run and eventually errors, until app restart. On timeout we
// ask the native side to stop (best-effort), INITIATE the tracked release (see `beginRelease`), and
// reject — all BEFORE the run settles — so the chain advances; the NEXT request then gates on the
// engine state (`releasing`) rather than reusing the wedged context (see `runInference`).
const INFERENCE_TIMEOUT_MS = 3 * 60 * 1000;

// On a timeout we ask the native side to `stopCompletion()`, but that call itself could hang (the same
// wedged native state that caused the timeout). Bound it so the timeout cleanup can never itself stall
// the inference chain: if `stopCompletion` hasn't settled within this budget we stop waiting and start
// the (tracked) context release anyway — the engine state machine, not this budget, is what prevents a
// fresh context from loading before the native release actually resolves.
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
 * The SINGLE context-teardown path (Sol P1). Every release — the timeout cleanup, an explicit
 * Deactivate/Delete, a model SWITCH, and the no-active-model path — funnels through here so a fresh native
 * context can never be built alongside an old one that's still disposing.
 *
 * Two phases, deliberately separated:
 *   1. DETACH synchronously — capture the context, then null `loadedContext`/`loadedModelPath` and move the
 *      engine to `releasing` right now, so no concurrent/later `ensureContext` can reuse a context that is
 *      being torn down. This is the correctness-relevant step and it completes before we return.
 *   2. CONFIRM native disposal asynchronously — track the REAL `release()` promise and let its outcome drive
 *      the state machine: RESOLVE → back to `ready` (safe to build fresh); REJECT → `poisoned` (terminal:
 *      a failed release may have left the native context resident, so we must never `initLlama` again this
 *      process). The rejection is RECORDED in the state before it is swallowed, so it neither poisons
 *      silently nor escapes as an unhandled rejection.
 *
 * Returns the (always-settled, never-throwing) tracking promise so a caller MAY await disposal — but it is
 * the engine STATE, never this promise, that gates future context creation, so a caller that skips the await
 * (or awaits it under a budget) can never wedge the serialized `inferenceChain`. No-op (`ready`) when nothing
 * is loaded.
 */
function beginRelease(): Promise<void> {
  if (!loadedContext) {
    return Promise.resolve();
  }
  const context = loadedContext;
  const path = loadedModelPath;
  // Phase 1 — detach synchronously (separate from, and before, confirming native disposal below).
  loadedContext = null;
  loadedModelPath = null;
  return trackRelease(context, path);
}

/**
 * Track a native `context.release()` to completion, driving `engineStatus` + `releasingPath`/`releasingPromise`
 * (Sol Fable-round-4 P1: shared by {@link beginRelease}'s detach-and-release of the LOADED context AND the
 * disposal of an ABANDONED late `initLlama` result, so a stale load's context never leaks). Records the model
 * being released so a barrier RETRY for it recognises it's still disposing rather than seeing "nothing loaded"
 * and reporting 'released'. `Promise.resolve().then(...)` funnels even a SYNCHRONOUS throw from `release()`
 * into the reject arm, so a synchronously-failing release poisons the engine like an async one.
 */
function trackRelease(context: LlamaContext, path: string | null): Promise<void> {
  engineStatus = 'releasing';
  releasingPath = path;
  const track: Promise<void> = Promise.resolve()
    .then(() => context.release())
    .then(
      () => {
        // Native context actually disposed. Only clear `releasing` if we're still in it — a concurrent
        // poisoning (another release that rejected) must not be overwritten back to `ready`.
        if (engineStatus === 'releasing') {
          engineStatus = 'ready';
        }
        if (releasingPromise === track) {
          releasingPath = null;
          releasingPromise = null;
        }
      },
      (error: unknown) => {
        engineStatus = 'poisoned';
        if (releasingPromise === track) {
          releasingPromise = null; // poison is terminal — the path no longer matters, but stop pointing at it
        }
        console.warn('LOAM on-device LLM: native context release() rejected — engine poisoned until app restart', error);
      },
    );
  releasingPromise = track;
  return track;
}

/**
 * Invalidate the in-flight `initLlama` load (if any) so its LATE resolution is disposed instead of published
 * (Sol Fable-round-4 P1) — called on a load timeout AND when a deactivate/delete removes the model mid-load,
 * so a native load that finishes after the operator moved on can never silently become the active context.
 * Bumps `currentLoadId`; the load compares its captured id and disposes on mismatch. Leaves `engineStatus`
 * 'loading' until the native load actually settles (no new `initLlama` may start meanwhile — no double-load).
 */
function invalidateLoad(): void {
  if (loadingPath !== null) {
    currentLoadId += 1;
  }
}

/**
 * Ask the native side to abandon the current completion, BOUNDED by `STOP_COMPLETION_BUDGET_MS` so the
 * stop request can't itself hang the timeout cleanup (the wedged native state that triggered the timeout
 * could just as easily wedge `stopCompletion`). Races the (possibly-never-settling) native call against a
 * short timer and returns once either wins. Fully defensive: a synchronous throw or a rejected promise
 * from `stopCompletion` is swallowed — the caller initiates the context release regardless, so a failed
 * stop can only cost us the old context, never correctness.
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
    // stopCompletion threw synchronously / isn't available — nothing more we can do; release the context.
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
 * uses) so it can't release a context out from under a running completion.
 *
 * It only INITIATES the tracked release (`beginRelease`) and returns PROMPTLY — it must NOT `await release()`,
 * because a native release that never settles would otherwise wedge `inferenceChain` and hang every later
 * request before its own timeout is even installed (the Sol P1 second failure mode). The engine is left in
 * `releasing`; a later request gates on that state and recovers once the release actually resolves. The chain
 * is kept alive across a rejection, and `beginRelease` never throws, so this is safe to call fire-and-forget
 * (`void`). The signature stays `(): Promise<void>` for the `model-manager.tsx` call sites.
 */
export function releaseActiveModelContext(): Promise<void> {
  // SCHEDULE the release behind any in-flight inference, but return PROMPTLY (don't await the chain): a
  // deactivate doesn't unlink bytes, so it needs no confirmation, and awaiting `inferenceChain` here would
  // couple the caller (the operation mutex) to whatever is currently on the chain — including a not-timeout-
  // wrapped `initLlama` load. `beginRelease` detaches synchronously when it runs; the engine state gates any
  // later load. Never throws.
  // Invalidate any in-flight load SYNCHRONOUSLY (Sol Fable-round-4 P1) — NOT inside the chained step, which
  // would queue behind the very load step that holds `inferenceChain`, so a native load that resolved first
  // could still publish + run a completion before the invalidation ran. Bumping the generation now means that
  // load's late result is disposed, not published. Then schedule the release of whatever is loaded behind the
  // chain (so it can't tear a context out from under a running completion).
  invalidateLoad();
  inferenceChain = inferenceChain
    .then(() => {
      beginRelease();
    })
    .catch(() => undefined);
  return Promise.resolve();
}

/** How long the delete BARRIER (`releaseModelContextIfLoaded`) waits for the native `release()` to CONFIRM
 * before giving up and deferring the byte deletion to reconciliation (CodeRabbit). Bounds the operation mutex
 * so a slow/hung native release (or a long in-flight completion the release queues behind) can never wedge a
 * delete — the durable delete-pending simply retries the release+unlink on a later reconcile pass. */
const RELEASE_CONFIRM_BUDGET_MS = 5 * 1000;

/**
 * PATH-AWARE release BARRIER used before the byte deletion of a SPECIFIC model (Finding 1 / CodeRabbit):
 * release the loaded context ONLY if the currently-loaded model is `modelPath`, and CONFIRM the outcome so
 * the caller can gate the irreversible unlink on the native `release()` actually completing — the file must
 * never be removed while the native side may still map it. Returns:
 *   - `'released'`    — the native release RESOLVED, or the model wasn't loaded (nothing maps the file) →
 *                       safe to unlink now.
 *   - `'unconfirmed'` — still releasing when the `budgetMs` window elapsed → the caller keeps the durable
 *                       delete-pending and retries at reconciliation (never blocks on a slow/hung release).
 *   - `'poisoned'`    — a native release rejected → keep the pending until an app restart.
 *
 * The release is SERIALIZED behind `inferenceChain` (so it can't tear a context out from under a running
 * completion), and the whole confirmation is BOUNDED by `budgetMs` — so even a hung `initLlama` load ahead of
 * it on the chain, or a native `release()` that never settles, can't wedge the operation mutex (the Sol P1
 * contract). `modelPath` is compared after stripping the `file://` scheme, the same way `activeModelPath`
 * does before storing `loadedModelPath`, so a caller may pass a raw `model.uri`. Never throws.
 */
export function releaseModelContextIfLoaded(
  modelPath: string,
  budgetMs: number = RELEASE_CONFIRM_BUDGET_MS,
): Promise<'released' | 'unconfirmed' | 'poisoned'> {
  const target = modelPath.replace(/^file:\/\//, '');
  // Schedule the path-aware release behind any in-flight inference. CRITICAL: `inferenceChain` must advance
  // after the synchronous DETACH (which `beginRelease` does before it awaits the native `release()`), NOT
  // after the release COMPLETES — otherwise a hung `release()` would wedge the chain (every later request
  // would block on it). So the step returns nothing (resolves post-detach); the native release is inspected
  // SEPARATELY for the confirmation below.
  // If the model being deleted is still LOADING, invalidate that load SYNCHRONOUSLY (Sol Fable-round-4 P1) —
  // outside the chained step (which would queue behind the load step holding `inferenceChain`), so a load that
  // resolves first can't publish + run a completion on a model whose file the caller is about to unlink. Its
  // late context is then disposed, not published; we report 'unconfirmed' until that disposal settles.
  if (loadingPath === target) {
    invalidateLoad();
  }
  const step = inferenceChain.then(() => {
    if (loadedContext && loadedModelPath === target) {
      beginRelease(); // detaches synchronously; sets releasingPath/Promise; resolves when release() settles
    }
  });
  inferenceChain = step.catch(() => undefined);

  // Confirm NATIVE disposal, BOUNDED so a slow/hung release can't block the caller (the operation mutex)
  // forever — on timeout the caller keeps the delete-pending and reconciles later. Inspects the RELEASING and
  // LOADING state, not just `loadedContext`: on a retry the context is already detached (null), but if THIS
  // model's release is still in flight we await it; if it's still (abandoned) loading, we defer — never report
  // 'released' and let the caller unlink a still-mapped or about-to-be-mapped file (CodeRabbit / Sol).
  const confirmed = step.then(async (): Promise<'released' | 'unconfirmed' | 'poisoned'> => {
    if (releasingPath === target && releasingPromise) {
      await releasingPromise; // resolves when release() settles; never rejects
    }
    // `as EngineStatus` re-widens past TS's stale flow-narrowing (the value can have flipped during the await).
    if ((engineStatus as EngineStatus) === 'poisoned') {
      return 'poisoned';
    }
    // Still loading this model (abandoned load not yet disposed) → NOT safe to unlink; defer to reconciliation,
    // which retries once the late context has been disposed (then this returns 'released').
    if (loadingPath === target) {
      return 'unconfirmed';
    }
    return 'released';
  });

  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<'unconfirmed'>((resolve) => {
    budgetTimer = setTimeout(() => resolve('unconfirmed'), budgetMs);
  });
  return Promise.race([confirmed, budget]).finally(() => {
    if (budgetTimer !== undefined) {
      clearTimeout(budgetTimer);
    }
  });
}

/**
 * Load (or reuse) the llama.rn context for `modelPath`. Refuses to build a fresh context unless the engine
 * is `ready`: while an older context is still `releasing` (or the engine is `poisoned` by a failed release)
 * building a new multi-GB context would double native residency and likely OOM (Sol P1) — so those states
 * fail fast with a recovery/restart error instead. A request for a DIFFERENT model than the one loaded
 * routes the old context through the SAME teardown path (`beginRelease`) and defers to a later request,
 * rather than releasing-and-reloading in one shot alongside the still-disposing old context.
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
  // Engine-state gate (Sol P1) — never `initLlama` while an old context is disposing/failed-to-dispose OR
  // while another load is already in flight (no double native residency → OOM).
  if (engineStatus === 'poisoned') {
    throw new Error(ENGINE_POISONED_MESSAGE);
  }
  if (engineStatus === 'releasing' || engineStatus === 'loading') {
    throw new Error(ENGINE_RECOVERING_MESSAGE);
  }
  if (loadedContext && loadedModelPath === modelPath) {
    return loadedContext;
  }
  if (loadedContext) {
    // Model SWITCH: tear the old context down through the shared path and refuse THIS request until the
    // release resolves — a later request (engine `ready` again) loads the new model. We never build the new
    // context alongside the still-releasing old one (P1 OOM).
    beginRelease();
    throw new Error(ENGINE_RECOVERING_MESSAGE);
  }

  // Fresh load, BOUNDED (Sol Fable-round-4 P1). A native `initLlama` that never settles must not wedge the
  // inference chain or block every later request forever.
  const myLoadId = ++currentLoadId;
  engineStatus = 'loading';
  loadingPath = modelPath;

  // Diagnostics ONLY — fire-and-forget, NEVER awaited (a hung `getBackendDevicesInfo` used to be able to
  // block the load here). n_ctx is a fixed constant (see the model-manager-bridge.ts config.json note).
  void getBackendDevicesInfo()
    .then((devices) => console.log('LOAM on-device LLM: detected backend devices', JSON.stringify(devices)))
    .catch((error) => console.warn('LOAM on-device LLM: getBackendDevicesInfo() failed', error));

  const nativeLoad = Promise.resolve().then(() => initLlama({ model: modelPath, n_ctx: 4096, n_gpu_layers: 99 }));
  // Track the native load's settlement SEPARATELY from the bounded wait below, so a load that resolves AFTER
  // its timeout (or after a deactivate/delete abandoned it) is DISPOSED, never published as the active context.
  void nativeLoad.then(
    (context) => finishLoad(context, myLoadId, modelPath),
    (error) => failLoad(error, myLoadId),
  );

  let loadTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    loadTimer = setTimeout(() => reject(new Error('__load_timeout__')), MODEL_LOAD_TIMEOUT_MS);
  });
  try {
    await Promise.race([nativeLoad, timeout]);
  } catch (error) {
    if (error instanceof Error && error.message === '__load_timeout__') {
      // ABANDON this load: bump the generation so its late resolution disposes the context instead of
      // publishing it (`finishLoad` checks the id), and LEAVE the engine 'loading' so no new `initLlama`
      // starts while the original native load may still be resident. When it settles, `finishLoad`/`failLoad`
      // dispose/clear the engine back to a usable state.
      if (myLoadId === currentLoadId) {
        currentLoadId += 1;
      }
      throw new Error(ENGINE_LOAD_TIMEOUT_MESSAGE);
    }
    throw error; // the native load rejected — `failLoad` already reset the engine state
  } finally {
    if (loadTimer !== undefined) {
      clearTimeout(loadTimer);
    }
  }
  // `nativeLoad` won the race → `finishLoad` ran first (registered before the race's `.then`) and published
  // the context if this load is still current. Return it if so; otherwise it was superseded/abandoned.
  if (loadedContext && loadedModelPath === modelPath && myLoadId === currentLoadId) {
    return loadedContext;
  }
  throw new Error(ENGINE_RECOVERING_MESSAGE);
}

/** Called when a native `initLlama` RESOLVES: publish the context iff this load is still the current,
 * non-abandoned one; otherwise DISPOSE it (a timeout / deactivate / delete moved on) so it never leaks and the
 * no-double-load invariant holds until it's gone (Sol Fable-round-4 P1). */
function finishLoad(context: LlamaContext, myLoadId: number, modelPath: string): void {
  loadingPath = null;
  if (myLoadId === currentLoadId && engineStatus === 'loading') {
    lastAccelerationInfo = { gpu: context.gpu, reasonNoGPU: context.reasonNoGPU, devices: context.devices };
    console.log(
      'LOAM on-device LLM: model loaded — gpu=%s reasonNoGPU=%s devices=%s',
      context.gpu,
      context.reasonNoGPU,
      JSON.stringify(context.devices),
    );
    loadedContext = context;
    loadedModelPath = modelPath;
    engineStatus = 'ready';
  } else {
    // Abandoned (timed out, or a deactivate/delete invalidated it) — dispose the late context through the
    // release machinery rather than publishing it (so nothing maps a deleted model's file, and no leak).
    trackRelease(context, modelPath);
  }
}

/** Called when a native `initLlama` REJECTS: nothing got loaded, so return the engine to `ready` (unless a
 * dispose/poison for an abandoned sibling load already moved it on). */
function failLoad(error: unknown, _myLoadId: number): void {
  loadingPath = null;
  console.warn('LOAM on-device LLM: initLlama() failed', error);
  if (engineStatus === 'loading') {
    engineStatus = 'ready';
  }
}

/**
 * Run the on-device model over `messages`, streaming reply text through the callbacks. Loads the
 * operator's active GGUF (from the model manager) via llama.rn, reusing the context across calls, and
 * serializes concurrent DMs (one llama.cpp context can't run parallel completions). Any failure — no
 * active model, a load error, an inference error, the engine still recovering from a prior release — is
 * reported via `onError`; this never throws, so a missing/broken model degrades to a graceful assistant
 * error and never affects crisis messaging.
 */
async function runInference(messages: ChatMessage[], callbacks: InferenceCallbacks): Promise<void> {
  const run = inferenceChain.then(async () => {
    try {
      const modelPath = await activeModelPath();
      if (!modelPath) {
        // No active model (Deactivate, or the active model was deleted): initiate release of the loaded
        // context through the shared path so its RAM is reclaimed rather than left resident until app
        // restart (it's otherwise only released on a model SWITCH). Not awaited — a hung release must not
        // prevent surfacing the error below (and the engine state, not this call, gates any later load).
        beginRelease();
        callbacks.onError('No on-device model is selected. Download and activate one from the AI model manager.');
        return;
      }
      const context = await ensureContext(modelPath);
      // Race the native completion against a bounded timeout so a wedged generation can't stall the
      // inference chain forever (see INFERENCE_TIMEOUT_MS). The completion callback still streams each
      // token to `onDelta` on the success path — unchanged; only the never-settles case is bounded.
      //
      // Fix 1: a timed-out completion must NOT let a SECOND completion run on the same native context.
      // The timeout promise resolves the race IMMEDIATELY with a sentinel the instant the timer fires
      // (CodeRabbit) — it does NOT await cleanup first. That determinism matters: if cleanup ran INSIDE the
      // timeout promise before it settled, a slow `stopCompletion` (bounded to 2s) could let the original
      // `completion()` WIN the race meanwhile, settle the run via `onEnd`, and advance the chain to the next
      // request while `loadedContext` was still the live (about-to-be-released) context — a release racing a
      // fresh completion on the SAME native context. With the sentinel winning first, the race is decided at
      // timer-fire; cleanup then runs in the awaited branch below, BEFORE this run settles, so the serialized
      // `inferenceChain` cannot reach the next request until the release has been INITIATED and the engine
      // moved to `releasing` (Sol P1) — the next request then gates on that state instead of reusing the
      // wedged context or building a fresh one before the old release resolves.
      const TIMED_OUT = Symbol('on-device-inference-timeout');
      let deltasEnabled = true;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
        timeoutTimer = setTimeout(() => {
          // Drop any further tokens from the still-running native completion (no late `onDelta` after the
          // `onError` below), then settle the race NOW so `completion()` can no longer win it.
          deltasEnabled = false;
          resolve(TIMED_OUT);
        }, INFERENCE_TIMEOUT_MS);
      });
      try {
        const outcome = await Promise.race([
          context
            .completion(
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
            )
            .then(() => 'completed' as const),
          timeout,
        ]);
        if (outcome === TIMED_OUT) {
          // The generation is wedged. Bounded best-effort stop, THEN INITIATE the tracked release of the
          // possibly-still-busy context (Sol P1: `beginRelease` detaches synchronously and moves the engine
          // to `releasing`, but does NOT block on the native `release()` resolving). Throw promptly right
          // after: the serialized chain advances on THIS run settling, and because the engine is now
          // `releasing`, the next request's `ensureContext` fails fast (recovery error) — it will not reuse
          // the wedged context nor build a fresh one until the old release actually resolves.
          await stopCompletionWithinBudget(context);
          beginRelease();
          throw new Error(`On-device inference timed out after ${Math.round(INFERENCE_TIMEOUT_MS / 1000)}s.`);
        }
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
