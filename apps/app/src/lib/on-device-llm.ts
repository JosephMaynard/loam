// RN-side glue for the optional on-device LLM (docs/06). Flow: when the operator enables
// `llm.onDevice`, the embedded Node server calls `global.__loamOnDeviceChat` (installed in
// `nodejs-project-template/main.js`), which posts a `loam-llm-request` over the rn-bridge channel.
// This module answers those requests by running a small model in the RN/native layer and streaming
// tokens back as `loam-llm-delta` / `loam-llm-end` / `loam-llm-error`, which the server turns into
// the same `StreamEvent`s the laptop-Ollama path uses.
//
// ── The engine is a SINGLE ACTOR (Fable-round-7 rewrite) ─────────────────────────────────────────────
// llama.rn's native calls (`initLlama`, `completion`, `release`) are async, un-cancellable, can hang, and
// carry hard invariants: only ONE native context may be resident at a time (a second `initLlama` while an
// old context lives = multi-GB double-residency → OOM), only one completion runs per context, and a
// model's file must not be unlinked while its context still maps it. Earlier rounds enforced these with
// several overlapping mechanisms (a promise chain, an engine-status enum, load/release paths, and an
// external "sync to active model" poke). Every review found a seam BETWEEN them.
//
// This module instead funnels EVERYTHING through one serialized command queue processed by a single
// `drain()` loop. The loop owns the native context and reconciles it toward one target: `desired`, the
// COMMITTED active model. The key discipline is that `desired` tracks COMMITTED truth, not the durable
// `activeId` the action layer writes OPTIMISTICALLY ahead of its launcher-bridge confirmation: `desired`
// moves only via `reconcileActiveModel` (called AFTER a bridge outcome) plus a one-time bootstrap on the
// first inference. An inference reads the optimistic `activeId` only to decide what may RUN — if it and
// `desired` disagree, the actor is in a provisional switch window and touches no native context at all, so
// a switch the bridge later rolls back can never have released the still-committed loaded model. The
// reconcile command releases a loaded context that no longer matches `desired` AT THE TIME IT RUNS (not a
// value it captured), so a burst of switches converges on the final target with no wrong-model churn.
// Because only one command runs at a time and each re-reads the latest truth when it acts, the whole class
// of interaction bugs (double-load, a stale load publishing/running, a switch that doesn't invalidate, a
// reconcile that forgets to notify, an optimistic write-ahead releasing a committed model) becomes
// impossible by construction rather than prevented by a guard. The entry points:
//   - `runInference`               enqueues one inference (load-if-needed → completion), fully bounded.
//   - `reconcileActiveModel(path)` after a DURABLE activeId change (switch/deactivate/rollback/reconcile):
//                                  set `desired` and release a now-stale loaded context. Called only once
//                                  the outcome is known, so a failed switch never destroys the old model.
//   - `invalidateStaleLoad(keep)`  at PERSIST time (before a fallible bridge call): synchronously abandon
//                                  an in-flight load of a model other than `keep`, WITHOUT releasing a
//                                  loaded context (so an optimistic switch that later rolls back is safe).
//   - `confirmActiveModelReleased` the delete BARRIER: release a model's context and confirm native
//                                  disposal (bounded) before the file is unlinked.
// It stays fully defensive: no active model, a load/inference failure, or a wedged native call surfaces as
// a graceful assistant error, never a crash, so crisis messaging is unaffected. The remaining DEVICE SEAM
// is only actual on-device token generation (a physical arm64 phone + a downloaded GGUF); everything up to
// and including the llama.rn calls is built and type-checked.

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

/** The confirmed outcome of the delete BARRIER — see {@link confirmActiveModelReleased}. */
export type ContextReleaseOutcome = 'released' | 'unconfirmed' | 'poisoned';

const NO_MODEL_MESSAGE = 'No on-device model is selected. Download and activate one from the AI model manager.';
/** Shown when a request arrives while the engine can't currently build/reuse a context (a release or an
 * abandoned load's native disposal is still in flight). Transient — a moment later it settles and the engine
 * is usable again; the restart hint covers the rare case where a native call is pathologically slow. */
const ENGINE_RECOVERING_MESSAGE =
  'The on-device model engine is still recovering — try again in a moment, or restart the LOAM host app if this persists.';
/** Shown once the engine is `poisoned` (a native `release()` REJECTED). We refuse to build another context
 * this process, so only an app restart can recover — say so plainly rather than implying a retry will help. */
const ENGINE_POISONED_MESSAGE =
  'The on-device model engine needs a restart — close and reopen the LOAM host app to use on-device AI again.';
/** Shown when `initLlama` (the model load) exceeds `MODEL_LOAD_TIMEOUT_MS`. The load is abandoned so it
 * can't wedge the queue; a later request retries once the native load settles and is disposed. */
const ENGINE_LOAD_TIMEOUT_MESSAGE =
  'Loading the on-device model timed out — try again in a moment, or restart the LOAM host app if it persists.';

/** Bounded ceiling on a single `initLlama` load. A multi-GB model on a slow phone can legitimately take a
 * while, so this is generous — but a native load that NEVER settles must not wedge the queue forever. On
 * timeout the request errors, the load is abandoned (its late context disposed, never published), and the
 * queue advances. */
const MODEL_LOAD_TIMEOUT_MS = 3 * 60 * 1000;

/** Bounded ceiling on a single on-device completion. A slow phone can legitimately take a while to generate
 * 512 tokens, so this is deliberately long — but a `completion()` that never settles must not wedge the
 * queue. On timeout we stop (bounded), release the wedged context, and error; the next request recovers. */
const INFERENCE_TIMEOUT_MS = 3 * 60 * 1000;

/** On a completion timeout we ask the native side to `stopCompletion()`, but that call itself could hang
 * (the same wedged state that caused the timeout). Bound it so the cleanup can never stall the queue. */
const STOP_COMPLETION_BUDGET_MS = 2 * 1000;

/** How long a caller (`runInference`'s reconcile, or the delete barrier) waits for an in-flight native
 * release/disposal to settle before giving up and reporting recovering/unconfirmed. Bounds the queue and the
 * operation mutex against a slow/hung native release; the durable state (delete-pending) reconciles later. */
const RELEASE_CONFIRM_BUDGET_MS = 5 * 1000;

// ── Engine state (the whole thing) ──────────────────────────────────────────────────────────────────
/** The single loaded native context, or null. Only ever mutated inside the drain loop (and detached
 * synchronously by `beginReleaseLoaded`). */
let loaded: { path: string; ctx: LlamaContext } | null = null;
/** The COMMITTED active model (bare path), or null — the actor's authoritative target for native teardown.
 * It is changed ONLY by `reconcileActiveModel` (which the action layer calls AFTER a bridge outcome) and,
 * once, by the first inference's bootstrap (`desiredInitialized`). It is DELIBERATELY not overwritten from
 * the durable `activeId` on every inference: `activeId` is written OPTIMISTICALLY, ahead of the launcher-
 * bridge confirmation, so treating it as final would let a provisional switch release the still-committed,
 * loaded old model that a failed switch then rolls back to. */
let desired: string | null = null;
/** Whether `desired` has been seeded from durable truth yet. The first inference of the process adopts the
 * persisted `activeId` as the committed target (safe — nothing is loaded then, so it can only seed, never
 * release); thereafter only `reconcileActiveModel` moves `desired`. */
let desiredInitialized = false;
/** A native `release()` REJECTED — the context may still be resident, so we can never `initLlama` again this
 * process. Terminal until app restart. */
let poisoned = false;
/** The SINGLE in-flight native operation that must complete before a new context can be loaded (no double
 * residency): a load's disposal, or a context release. `settled` resolves when the native op finishes (never
 * rejects); `path` is the model it concerns (for the delete barrier). At most one exists at a time because a
 * new one is only ever started, inside the serial loop, after the previous has settled. */
let inFlightOp: { path: string; settled: Promise<void> } | null = null;
/** The path of an in-flight `initLlama`, or null. `loadEpoch` is bumped to ABANDON that load: the load
 * captures the epoch and, on resolve, disposes its context instead of publishing when the epoch has moved. */
let loadingPath: string | null = null;
let loadEpoch = 0;

/** The most recent load's hardware-acceleration outcome, as REPORTED BY llama.rn itself (never assumed).
 * `undefined` until a model has actually loaded once. */
let lastAccelerationInfo: { gpu: boolean; reasonNoGPU: string; devices?: string[] } | undefined;
/** Whether the one-shot `getBackendDevicesInfo()` diagnostic has been fired (after the first successful
 * load, so it can't race the first load's JSI install — CodeRabbit). */
let backendProbed = false;

// ── The serialized command queue + drain loop ───────────────────────────────────────────────────────
const queue: Array<() => Promise<void>> = [];
let draining = false;

/** Enqueue a command and ensure the drain loop is running. Commands run strictly one at a time. */
function enqueue(command: () => Promise<void>): void {
  queue.push(command);
  void drain();
}

async function drain(): Promise<void> {
  if (draining) {
    return;
  }
  draining = true;
  try {
    while (queue.length > 0) {
      const command = queue.shift();
      if (command) {
        // Commands own their error handling (they resolve callbacks); a defensive catch keeps one bad
        // command from wedging the whole queue.
        try {
          await command();
        } catch (error) {
          console.warn('LOAM on-device LLM: a queued command threw (should not happen)', error);
        }
      }
    }
  } finally {
    draining = false;
  }
}

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

/** Normalize a raw `file://` uri (or an already-bare path) to the bare path the engine stores. */
function bare(path: string): string {
  return path.replace(/^file:\/\//, '');
}

/**
 * The most recent on-device model load's acceleration outcome, straight from llama.rn's own
 * `LlamaContext.gpu`/`reasonNoGPU`/`devices` — exported for future UI surfacing. `undefined` before any
 * model has loaded.
 */
export function getLastAccelerationInfo(): { gpu: boolean; reasonNoGPU: string; devices?: string[] } | undefined {
  return lastAccelerationInfo;
}

// ── Native teardown (release) ───────────────────────────────────────────────────────────────────────
/**
 * Start tracking a native `context.release()` as the single in-flight op. `Promise.resolve().then(...)`
 * funnels even a SYNCHRONOUS throw from `release()` into the reject arm, so a synchronously-failing release
 * poisons the engine like an async one. On resolve the op clears (engine usable again); on reject the engine
 * is `poisoned` for the process. Reference-equality on the op object means a later op's completion can never
 * clear this one's (or vice versa).
 */
function startRelease(ctx: LlamaContext, path: string): void {
  const op: { path: string; settled: Promise<void> } = { path, settled: Promise.resolve() };
  op.settled = Promise.resolve()
    .then(() => ctx.release())
    .then(
      () => {
        if (inFlightOp === op) {
          inFlightOp = null;
        }
      },
      (error: unknown) => {
        poisoned = true;
        if (inFlightOp === op) {
          inFlightOp = null;
        }
        console.warn('LOAM on-device LLM: native context release() rejected — engine poisoned until app restart', error);
      },
    );
  inFlightOp = op;
}

/** Synchronously detach the loaded context and start tracking its native release. No-op when nothing is
 * loaded. After this returns, `loaded` is null and `inFlightOp` is the release (until it settles). */
function beginReleaseLoaded(): void {
  if (!loaded) {
    return;
  }
  const { ctx, path } = loaded;
  loaded = null;
  startRelease(ctx, path);
}

/** Await the current in-flight native op (if any), bounded by `budgetMs`. Returns once it settles or the
 * budget elapses — the caller re-checks `inFlightOp`/`poisoned` afterward. `settled` never rejects. */
async function settleInFlightOp(budgetMs: number): Promise<void> {
  const op = inFlightOp;
  if (!op) {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      op.settled,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, budgetMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

// ── Native model load (bounded) ─────────────────────────────────────────────────────────────────────
/**
 * Load `target` into a native context, BOUNDED by `MODEL_LOAD_TIMEOUT_MS`. Resolves with the published
 * context on success; THROWS a specific message otherwise (timeout / native failure / superseded), which the
 * caller surfaces via `onError`. A load abandoned by a timeout, or by a switch/delete that bumped
 * `loadEpoch`, has its late native context DISPOSED (through the release path) rather than published, so a
 * model the operator moved away from can never become active and no second context is ever built alongside
 * it. Must be called only when `inFlightOp` is null and `loaded` is not already `target`.
 */
async function loadTarget(target: string): Promise<LlamaContext> {
  const myEpoch = ++loadEpoch;
  loadingPath = target;

  const native = Promise.resolve().then(() => initLlama({ model: target, n_ctx: 4096, n_gpu_layers: 99 }));
  const op: { path: string; settled: Promise<void> } = { path: target, settled: Promise.resolve() };
  op.settled = native.then(
    (ctx) => onLoadResolved(ctx as LlamaContext, myEpoch, target, op),
    (error: unknown) => onLoadRejected(error, op),
  );
  inFlightOp = op;

  let loadTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      native.then(() => undefined),
      new Promise<never>((_resolve, reject) => {
        loadTimer = setTimeout(() => reject(new Error('__load_timeout__')), MODEL_LOAD_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message === '__load_timeout__') {
      // Abandon this load: bump the epoch so its late resolution DISPOSES the context (see `onLoadResolved`)
      // rather than publishing it. The native load stays tracked in `inFlightOp` until it settles, so no new
      // load starts meanwhile (no double residency).
      if (myEpoch === loadEpoch) {
        loadEpoch += 1;
      }
      throw new Error(ENGINE_LOAD_TIMEOUT_MESSAGE);
    }
    throw error instanceof Error ? error : new Error(String(error)); // native load rejected — surface it
  } finally {
    if (loadTimer !== undefined) {
      clearTimeout(loadTimer);
    }
  }

  // `native` won the race → `onLoadResolved` (registered first) already ran. It published only if this load
  // is still current (epoch unchanged, not poisoned). Return the published context; otherwise it was
  // superseded/abandoned during the load and has been routed to disposal.
  if (loaded && loaded.path === target && myEpoch === loadEpoch) {
    return loaded.ctx;
  }
  throw new Error(ENGINE_RECOVERING_MESSAGE);
}

/** A native load RESOLVED: publish it iff still current, else dispose it (routed through the release path). */
function onLoadResolved(ctx: LlamaContext, myEpoch: number, target: string, op: { path: string; settled: Promise<void> }): void {
  loadingPath = null;
  if (inFlightOp === op) {
    inFlightOp = null;
  }
  if (myEpoch === loadEpoch && !poisoned && !loaded) {
    // Take OWNERSHIP first (P3): a throwing native proxy getter or diagnostic serialization must NEVER leave
    // this context untracked — that would leak it AND let a second `initLlama` start (double residency / OOM).
    // The acceleration read + log are best-effort and wrapped so they can't affect ownership or reject
    // `op.settled` (its never-reject contract).
    loaded = { path: target, ctx };
    // Diagnostics probe (CodeRabbit): `getBackendDevicesInfo()` also drives llama.rn's `installJsi()`, whose
    // ready-guard is only set once its async install finishes — firing it ALONGSIDE the first `initLlama()`
    // (as loadTarget used to) can race cold-start JSI setup. Run it once here, after a load has completed, so
    // JSI is guaranteed installed. Fire-and-forget; never awaited; failures are swallowed.
    if (!backendProbed) {
      backendProbed = true;
      void getBackendDevicesInfo()
        .then((devices) => console.log('LOAM on-device LLM: detected backend devices', JSON.stringify(devices)))
        .catch((error) => console.warn('LOAM on-device LLM: getBackendDevicesInfo() failed', error));
    }
    try {
      lastAccelerationInfo = { gpu: ctx.gpu, reasonNoGPU: ctx.reasonNoGPU, devices: ctx.devices };
      console.log(
        'LOAM on-device LLM: model loaded — gpu=%s reasonNoGPU=%s devices=%s',
        ctx.gpu,
        ctx.reasonNoGPU,
        JSON.stringify(ctx.devices),
      );
    } catch (error) {
      console.warn('LOAM on-device LLM: reading load diagnostics failed (context still owned)', error);
    }
  } else {
    // Superseded (a switch/delete bumped the epoch) or the load timed out — dispose the late context so it
    // never becomes active and its RAM is reclaimed. This starts a NEW in-flight release op.
    startRelease(ctx, target);
  }
}

/** A native load REJECTED: nothing loaded. */
function onLoadRejected(error: unknown, op: { path: string; settled: Promise<void> }): void {
  loadingPath = null;
  if (inFlightOp === op) {
    inFlightOp = null;
  }
  console.warn('LOAM on-device LLM: initLlama() failed', error);
}

// ── Bounded completion ──────────────────────────────────────────────────────────────────────────────
/** Ask the native side to abandon the current completion, BOUNDED by `STOP_COMPLETION_BUDGET_MS` (the wedged
 * state that timed out could wedge `stopCompletion` too). Fully defensive: a sync throw or a rejected
 * promise is swallowed — the caller releases the context regardless. */
async function stopCompletionWithinBudget(ctx: LlamaContext): Promise<void> {
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve(ctx.stopCompletion()).catch(() => undefined),
      new Promise<void>((resolve) => {
        budgetTimer = setTimeout(resolve, STOP_COMPLETION_BUDGET_MS);
      }),
    ]);
  } catch {
    // stopCompletion threw synchronously / isn't available — nothing more we can do.
  } finally {
    if (budgetTimer !== undefined) {
      clearTimeout(budgetTimer);
    }
  }
}

/**
 * Run one bounded completion on `ctx`, streaming tokens. On timeout the race is settled IMMEDIATELY by a
 * sentinel (so a completion that resolves during cleanup can't win it and emit a late `onEnd`), late tokens
 * are dropped, the wedged context is stopped (bounded) and released, and a timeout error is thrown. `ctx` is
 * `loaded.ctx` (the only context; the serial loop guarantees nothing else touches it).
 */
async function runCompletion(ctx: LlamaContext, messages: ChatMessage[], callbacks: InferenceCallbacks): Promise<void> {
  const TIMED_OUT = Symbol('on-device-inference-timeout');
  let deltasEnabled = true;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timeoutTimer = setTimeout(() => {
      deltasEnabled = false; // drop late tokens (no onDelta after the onError below)
      resolve(TIMED_OUT); // settle the race NOW so completion() can no longer win it
    }, INFERENCE_TIMEOUT_MS);
  });
  try {
    const outcome = await Promise.race([
      ctx
        .completion(
          {
            messages,
            n_predict: 512,
            // Gemma's turn terminator (+ the generic end token); llama.rn stops on any match.
            stop: ['<end_of_turn>', '<eos>'],
          },
          (data) => {
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
      await stopCompletionWithinBudget(ctx);
      beginReleaseLoaded(); // release the wedged context (it is `loaded`); the next request gates on inFlightOp
      throw new Error(`On-device inference timed out after ${Math.round(INFERENCE_TIMEOUT_MS / 1000)}s.`);
    }
  } finally {
    if (timeoutTimer !== undefined) {
      clearTimeout(timeoutTimer);
    }
  }
  callbacks.onEnd();
}

// ── The Infer command ───────────────────────────────────────────────────────────────────────────────
/** Process one inference: reconcile the native context to the currently-active model, then run a bounded
 * completion. Never throws — every failure is reported via `onError`. */
async function processInfer(messages: ChatMessage[], callbacks: InferenceCallbacks): Promise<void> {
  try {
    const target = await activeModelPath();
    if (!desiredInitialized) {
      // First inference of the process: adopt durable truth as the committed target. Nothing is loaded yet,
      // so this can only SEED `desired` — it can never release a context off optimistic write-ahead state.
      desired = target;
      desiredInitialized = true;
    }
    if (poisoned) {
      callbacks.onError(ENGINE_POISONED_MESSAGE);
      return;
    }
    // `target` is the durable-but-OPTIMISTIC `activeId` (a set-active/deactivate/delete writes it AHEAD of
    // its launcher-bridge confirmation); `desired` is the COMMITTED model (moved only by reconcileActiveModel,
    // AFTER the bridge outcome). When they DISAGREE we are inside a provisional transition window: neither
    // build nor tear down any native context off optimistic state — that is exactly the failure where a
    // still-committed, loaded A is released for a switch to B the bridge then rolls back (Sol P2). Report
    // recovering; the action layer commits the transition via reconcileActiveModel once the bridge settles.
    if (target !== desired) {
      callbacks.onError(ENGINE_RECOVERING_MESSAGE);
      return;
    }
    if (target === null) {
      // COMMITTED inactive (a confirmed Deactivate / active-model delete): reclaim the loaded RAM and error.
      beginReleaseLoaded();
      callbacks.onError(NO_MODEL_MESSAGE);
      return;
    }
    // Release a loaded context that isn't the target, then wait (bounded) for that — and any prior abandoned
    // load's disposal — to settle before building a new one (never two native contexts at once).
    if (loaded && loaded.path !== target) {
      beginReleaseLoaded();
    }
    if (inFlightOp) {
      await settleInFlightOp(RELEASE_CONFIRM_BUDGET_MS);
    }
    if (poisoned) {
      callbacks.onError(ENGINE_POISONED_MESSAGE);
      return;
    }
    if (inFlightOp) {
      // A native release/disposal is still resident — cannot load without risking double residency. Recover
      // on a later request once it settles.
      callbacks.onError(ENGINE_RECOVERING_MESSAGE);
      return;
    }
    if (!loaded || loaded.path !== target) {
      await loadTarget(target); // publishes `loaded`, or throws (timeout/native-fail/superseded)
    }
    if (poisoned || !loaded || loaded.path !== target) {
      callbacks.onError(poisoned ? ENGINE_POISONED_MESSAGE : ENGINE_RECOVERING_MESSAGE);
      return;
    }
    // Defense in depth: the operator may have switched/cleared the active model WHILE we loaded. Re-read it
    // right before running completion; if it changed, do NOT generate a reply for a model they moved away
    // from — the next Infer reconciles (and a switch/delete already invalidated/will-release this context).
    const now = await activeModelPath();
    if (now !== target) {
      callbacks.onError(ENGINE_RECOVERING_MESSAGE);
      return;
    }
    await runCompletion(loaded.ctx, messages, callbacks);
  } catch (error) {
    callbacks.onError(error instanceof Error ? error.message : String(error));
  }
}

// ── Public API ──────────────────────────────────────────────────────────────────────────────────────
/**
 * Run the on-device model over `messages`, streaming reply text through the callbacks. Enqueues one Infer
 * command; the returned promise resolves when it finishes (always — failures go to `onError`, never a
 * throw). Serialized behind every other engine command.
 */
export function runInference(messages: ChatMessage[], callbacks: InferenceCallbacks): Promise<void> {
  return new Promise<void>((resolve) => {
    enqueue(async () => {
      await processInfer(messages, callbacks);
      resolve();
    });
  });
}

/**
 * Notify the engine of the DURABLE new active model (Fable-round-7) — call this AFTER every confirmed
 * activeId transition: a set-active whose bridge succeeded/timed-out (durable truth is the new model), a
 * deactivate (`null`), a rollback (the restored model), or a reconcile that cleared/changed the pointer.
 * Because it runs only once the outcome is known, a FAILED switch that rolls back to the previous model
 * synchronizes to that model and NEVER tears down the working context (Sol Fable-round-5 P2#2). Sets
 * `desired`, synchronously abandons an in-flight load of a now-stale model, and enqueues a release of a
 * loaded context that is no longer the target (reclaiming RAM without waiting for the next inference). It
 * does NOT load — loading happens lazily on the next inference.
 */
export function reconcileActiveModel(nextPath: string | null): void {
  const target = nextPath === null ? null : bare(nextPath);
  desired = target;
  desiredInitialized = true; // a bridge outcome is authoritative — commit it even before the first inference
  if (loadingPath !== null && loadingPath !== target) {
    loadEpoch += 1; // abandon the in-flight load of a now-stale model (its late context is disposed)
  }
  enqueue(async () => {
    if (poisoned) {
      return;
    }
    // Release against the LATEST `desired` at run time (not the `target` captured when this command was
    // enqueued): if a newer reconcile has since moved `desired` back to the loaded model, this command
    // correctly leaves it alone, so a burst of switches never churns the context that ends up desired.
    if (loaded && loaded.path !== desired) {
      beginReleaseLoaded();
    }
  });
}

/**
 * Synchronously abandon an in-flight load whose path differs from `keepPath` (Fable-round-7 / Sol
 * Fable-round-5 P2#2) — call this the instant a new active model is durably persisted, BEFORE a fallible
 * launcher-bridge call. It prevents a load of the OLD model from publishing during the bridge window, but
 * does NOT release a loaded context: if the bridge then fails and the selection rolls back, the previously
 * working (still-loaded) model is untouched. `reconcileActiveModel` handles the release once the outcome is
 * known.
 */
export function invalidateStaleLoad(keepPath: string | null): void {
  const keep = keepPath === null ? null : bare(keepPath);
  if (loadingPath !== null && loadingPath !== keep) {
    loadEpoch += 1;
  }
}

/**
 * The delete BARRIER (Fable-round-7): release `path`'s native context and CONFIRM its disposal before the
 * caller unlinks the file, so the GGUF is never removed while the native side may still map it. Returns:
 *   - `'released'`    — nothing maps `path` (never loaded/loading, or its release confirmed) → safe to unlink.
 *   - `'unconfirmed'` — still releasing/loading when the budget elapsed → keep the durable delete-pending and
 *                       retry at reconciliation (never blocks the operation mutex on a slow/hung release).
 *   - `'poisoned'`    — a native release rejected → keep the pending until an app restart.
 * Synchronously abandons an in-flight load of `path` (its late context is disposed, not published), enqueues
 * the release of a loaded `path`, and races the confirmation against `budgetMs`. Never throws.
 */
export function confirmActiveModelReleased(
  path: string,
  budgetMs: number = RELEASE_CONFIRM_BUDGET_MS,
): Promise<ContextReleaseOutcome> {
  const target = bare(path);
  // Synchronously abandon an in-flight load of the model being deleted, so a load resolving during the
  // barrier disposes its context rather than publishing (and mapping) a file we're about to unlink.
  if (loadingPath === target) {
    loadEpoch += 1;
  }

  let resolveConfirmed: (outcome: ContextReleaseOutcome) => void;
  const confirmed = new Promise<ContextReleaseOutcome>((resolve) => {
    resolveConfirmed = resolve;
  });
  enqueue(async () => {
    if (poisoned) {
      resolveConfirmed('poisoned');
      return;
    }
    if (loaded && loaded.path === target) {
      beginReleaseLoaded();
    }
    // Await the disposal of THIS model's context (a release started just now, or a still-settling abandoned
    // load of it) so the outcome reflects real native disposal, not merely its initiation — but BOUNDED by
    // `budgetMs`, so a native release that never settles can NEVER wedge the drain loop (a later inference
    // must still be able to run and report its own recovering error). If it hasn't disposed within the
    // budget, report 'unconfirmed' and let reconciliation retry; the release continues in the background.
    if (inFlightOp && inFlightOp.path === target) {
      await settleInFlightOp(budgetMs);
    }
    if (inFlightOp && inFlightOp.path === target) {
      resolveConfirmed('unconfirmed');
      return;
    }
    resolveConfirmed(poisoned ? 'poisoned' : 'released');
  });

  // Bound the caller's wait independently of queue position: if the release is queued behind a long
  // completion, or the native release hangs, return 'unconfirmed' so the caller defers to reconciliation.
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

// ── Bridge wiring ───────────────────────────────────────────────────────────────────────────────────
const CHAT_ROLES = new Set(['system', 'user', 'assistant']);

/** Validate a single message from the bridge (each entry's role + content, not just the array container) so
 * a malformed payload can never reach the model. */
function isChatMessage(value: unknown): value is ChatMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    CHAT_ROLES.has((value as { role?: unknown }).role as string) &&
    typeof (value as { content?: unknown }).content === 'string'
  );
}

/** `channel.post` can throw (the bridge torn down mid-stream, screen unmounted) — called from inside
 * `runInference`'s callbacks, that throw would otherwise become an unhandled rejection instead of a harmless
 * no-op (mirrors `db-encryption.ts`'s `registerDbEncryption`). */
function safePost(channel: BridgeChannel, name: string, payload: unknown): void {
  try {
    channel.post(name, payload);
  } catch {
    // the RN bridge isn't listening any more — nothing more to do.
  }
}

/**
 * Wire the on-device LLM request bridge onto the nodejs-mobile channel. Safe to call on any platform — if no
 * on-device requests ever arrive (backend disabled, or non-Android), it does nothing. Returns a cleanup that
 * removes the listener.
 */
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
