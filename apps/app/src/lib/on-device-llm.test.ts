// The on-device LLM engine (docs/06) is a SINGLE ACTOR: one serialized command queue drains
// `runInference` / `reconcileActiveModel` / `invalidateStaleLoad` / `confirmActiveModelReleased` one at a
// time, owning the single native context and reconciling it toward the operator's active model. These tests
// exercise the invariants that would otherwise only surface on-device:
//   1. A native `completion()` that never settles must not wedge the queue — it's raced against a bounded
//      timeout that calls `stopCompletion()`, releases the wedged context, and advances, so later DMs run.
//   2. Timeout / release recovery must never double-load native contexts and OOM. A new context is NEVER
//      built while an older context's `release()` is still unresolved or has FAILED (`poisoned`); the
//      request fails fast with a recovering / restart error instead. Only once the old `release()` actually
//      RESOLVES does a later request build fresh.
//   3. `initLlama` (the load) is bounded too: a never-settling load is abandoned (its late context disposed,
//      never published or run), the request errors, and the queue advances.
//   4. A model switch / deactivate / delete invalidates an in-flight load of the OLD model and releases a
//      loaded old context — target-aware, so it never tears down the model the operator just moved TO.
//   5. When no model is active the loaded multi-GB context is released so its RAM is reclaimed.
// All exercised through the bridge's public `registerOnDeviceLlm` surface plus the actions-layer entry
// points, with `llama.rn` and the model-manager store replaced by in-memory fakes (no native module runs).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type TokenCallback = (data: { token?: string }) => void;
type CompletionImpl = (params: unknown, onToken?: TokenCallback) => Promise<unknown>;

// Hoisted so the (hoisted) `vi.mock` factories below can read them; tests mutate these to script each
// run's active-model state and the native completion's behaviour.
const mocks = vi.hoisted(() => ({
  // Default: one active model available.
  state: {
    downloaded: [
      { id: "m", displayName: "Test model", uri: "file:///models/m.gguf", sizeBytes: 1, isCustom: false, sourceUrl: "", downloadedAt: 0 },
    ],
    activeId: "m" as string | undefined,
  } as { downloaded: { id: string; uri: string; [k: string]: unknown }[]; activeId: string | undefined },
  // Default completion streams a token then resolves (a normal success).
  completionImpl: (async (_params: unknown, onToken?: TokenCallback) => {
    onToken?.({ token: "ok" });
    return { text: "ok" };
  }) as CompletionImpl,
  stopCompletion: vi.fn(async () => {}),
  release: vi.fn(async () => {}),
  // How many native contexts `initLlama` has built this test — lets the OOM-guard tests assert that a
  // released context is REBUILT fresh (a different native context) only after the old release resolved, and
  // that NO fresh context is built while a release/abandoned-load disposal is still in flight or `poisoned`.
  contextsCreated: 0,
  // Overridable per-test so the bounded-load tests can make `initLlama` hang/reject and `getBackendDevicesInfo`
  // hang. `initLlamaImpl` returns the native context (or throws / never-settles); `backendDevicesImpl` is the
  // diagnostic probe (must never gate the load).
  initLlamaImpl: undefined as undefined | (() => Promise<unknown>),
  backendDevicesImpl: undefined as undefined | (() => Promise<unknown[]>),
  loadStateImpl: undefined as
    | undefined
    | (() => Promise<{ downloaded: { id: string; uri: string; [k: string]: unknown }[]; activeId: string | undefined }>),
}));

vi.mock("llama.rn", () => ({
  getBackendDevicesInfo: vi.fn(() => (mocks.backendDevicesImpl ? mocks.backendDevicesImpl() : Promise.resolve([]))),
  initLlama: vi.fn(() => {
    if (mocks.initLlamaImpl) {
      return mocks.initLlamaImpl();
    }
    mocks.contextsCreated += 1;
    return Promise.resolve({
      gpu: false,
      reasonNoGPU: "test",
      devices: [],
      completion: (params: unknown, onToken?: TokenCallback) => mocks.completionImpl(params, onToken),
      stopCompletion: mocks.stopCompletion,
      release: mocks.release,
    });
  }),
}));

/** Build a native-context double (as `initLlama` would return), incrementing `contextsCreated`. */
function makeNativeContext() {
  mocks.contextsCreated += 1;
  return {
    gpu: false,
    reasonNoGPU: "test",
    devices: [],
    completion: (params: unknown, onToken?: TokenCallback) => mocks.completionImpl(params, onToken),
    stopCompletion: mocks.stopCompletion,
    release: mocks.release,
  };
}

vi.mock("@/lib/model-manager-store", () => ({
  // `loadStateImpl` (when set) lets a test return DIFFERENT active-model state on successive reads, so the
  // processInfer re-read of the active model (defense-in-depth) can be exercised.
  loadModelManagerState: vi.fn(() => (mocks.loadStateImpl ? mocks.loadStateImpl() : Promise.resolve(mocks.state))),
}));

interface FakeChannel {
  addListener(name: string, handler: (payload: unknown) => void): void;
  removeListener(name: string, handler: (payload: unknown) => void): void;
  post(name: string, payload: unknown): void;
  emit(name: string, payload: unknown): void;
  posts: { name: string; payload: { id?: unknown; text?: unknown; error?: unknown } }[];
}

/** A minimal in-memory nodejs-mobile channel: records every `post`, and `emit` drives the handler that
 * `registerOnDeviceLlm` registered for `loam-llm-request`. */
function makeChannel(): FakeChannel {
  const handlers = new Map<string, (payload: unknown) => void>();
  const posts: FakeChannel["posts"] = [];
  return {
    addListener: (name, handler) => handlers.set(name, handler),
    removeListener: (name) => handlers.delete(name),
    post: (name, payload) => posts.push({ name, payload: payload as { id?: unknown } }),
    emit: (name, payload) => handlers.get(name)?.(payload),
    posts,
  };
}

/** Flush pending microtasks + one macrotask turn (real timers only). */
const flush = async () => {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setImmediate(resolve));
};

/** Find the `loam-llm-error` posted for a request id (or undefined). */
const errorFor = (channel: FakeChannel, id: string) =>
  channel.posts.find((p) => p.name === "loam-llm-error" && p.payload.id === id);
/** Did the request id post a `loam-llm-end` (a clean success)? */
const endedFor = (channel: FakeChannel, id: string) =>
  channel.posts.some((p) => p.name === "loam-llm-end" && p.payload.id === id);

// Module timing constants mirrored from on-device-llm.ts (kept in sync for the fake-timer tests).
const LOAD_TIMEOUT = 3 * 60 * 1000;
const INFERENCE_TIMEOUT = 3 * 60 * 1000;
const RELEASE_CONFIRM_BUDGET = 5 * 1000;

// Re-import the module under test per test so its module-level state (the loaded context, the desired
// target, the in-flight op, and the command queue) is fresh — a wedged run in one test must not chain into
// the next.
let registerOnDeviceLlm: typeof import("@/lib/on-device-llm").registerOnDeviceLlm;
let reconcileActiveModel: typeof import("@/lib/on-device-llm").reconcileActiveModel;
let invalidateStaleLoad: typeof import("@/lib/on-device-llm").invalidateStaleLoad;
let confirmActiveModelReleased: typeof import("@/lib/on-device-llm").confirmActiveModelReleased;
let getLastAccelerationInfo: typeof import("@/lib/on-device-llm").getLastAccelerationInfo;

beforeEach(async () => {
  vi.resetModules();
  mocks.state = {
    downloaded: [
      { id: "m", displayName: "Test model", uri: "file:///models/m.gguf", sizeBytes: 1, isCustom: false, sourceUrl: "", downloadedAt: 0 },
    ],
    activeId: "m",
  };
  mocks.completionImpl = async (_params, onToken) => {
    onToken?.({ token: "ok" });
    return { text: "ok" };
  };
  mocks.stopCompletion.mockClear();
  mocks.stopCompletion.mockImplementation(async () => {});
  mocks.release.mockClear();
  // Reset the base implementation too (not just call history): several tests install a persistent /
  // once hang or reject on `release`, and `mockClear` alone would leave that implementation in place.
  mocks.release.mockImplementation(async () => {});
  mocks.contextsCreated = 0;
  mocks.initLlamaImpl = undefined;
  mocks.backendDevicesImpl = undefined;
  mocks.loadStateImpl = undefined;
  ({ registerOnDeviceLlm, reconcileActiveModel, invalidateStaleLoad, confirmActiveModelReleased, getLastAccelerationInfo } =
    await import("@/lib/on-device-llm"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("on-device-llm inference", () => {
  it("streams completion tokens as deltas and ends (success path)", async () => {
    mocks.completionImpl = async (_params, onToken) => {
      onToken?.({ token: "Hel" });
      onToken?.({ token: "lo" });
      onToken?.({ token: "" }); // empty tokens are dropped, not forwarded
      return { text: "Hello" };
    };
    const channel = makeChannel();
    registerOnDeviceLlm(channel);

    channel.emit("loam-llm-request", { id: "x", messages: [{ role: "user", content: "hi" }] });
    await flush();

    const deltas = channel.posts.filter((p) => p.name === "loam-llm-delta" && p.payload.id === "x").map((p) => p.payload.text);
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(endedFor(channel, "x")).toBe(true);
    expect(channel.posts.some((p) => p.name === "loam-llm-error")).toBe(false);
  });

  it("exposes the load's acceleration info after a successful load (llama.rn-reported)", async () => {
    expect(getLastAccelerationInfo()).toBeUndefined(); // nothing loaded yet
    const channel = makeChannel();
    registerOnDeviceLlm(channel);
    channel.emit("loam-llm-request", { id: "x", messages: [{ role: "user", content: "hi" }] });
    await flush();
    expect(getLastAccelerationInfo()).toEqual({ gpu: false, reasonNoGPU: "test", devices: [] });
  });

  it("times out a wedged completion, calls stopCompletion, and reports a timeout error (invariant 1)", async () => {
    vi.useFakeTimers();
    // The completion never settles — the exact wedge that would otherwise block every later DM.
    mocks.completionImpl = () => new Promise(() => {});
    const channel = makeChannel();
    registerOnDeviceLlm(channel);

    channel.emit("loam-llm-request", { id: "a", messages: [{ role: "user", content: "hi" }] });
    // Advance past INFERENCE_TIMEOUT_MS (3 min); advanceTimersByTimeAsync flushes the intervening microtasks
    // (activeModelPath / initLlama / bounded stop / release) around the timer.
    await vi.advanceTimersByTimeAsync(INFERENCE_TIMEOUT);

    expect(mocks.stopCompletion).toHaveBeenCalledTimes(1);
    const errored = errorFor(channel, "a");
    expect(errored).toBeDefined();
    expect(String(errored?.payload.error)).toMatch(/timed out/i);
    // The wedged context was torn down (its release was initiated + resolved with the default mock).
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("release() that NEVER settles: a later request gets a recovery error and builds NO new context (OOM guard)", async () => {
    vi.useFakeTimers();
    mocks.completionImpl = () => new Promise(() => {}); // request A wedges
    // The native release() never resolves — the in-flight op never clears, so a fresh context must never load.
    mocks.release.mockImplementationOnce(() => new Promise(() => {}));

    const channel = makeChannel();
    registerOnDeviceLlm(channel);

    channel.emit("loam-llm-request", { id: "a", messages: [{ role: "user", content: "hi" }] });
    await vi.advanceTimersByTimeAsync(INFERENCE_TIMEOUT); // A times out → beginReleaseLoaded → release hangs → inFlightOp set
    expect(String(errorFor(channel, "a")?.payload.error)).toMatch(/timed out/i);
    const contextsAfterA = mocks.contextsCreated; // A's one context — never to be torn down (release hung)

    // Request B arrives while the release is still in flight: after bounding its wait on the in-flight op it
    // must NOT call initLlama (no second multi-GB context alongside the un-disposed one) and must get the
    // recovering error, not a hang.
    channel.emit("loam-llm-request", { id: "b", messages: [{ role: "user", content: "yo" }] });
    await vi.advanceTimersByTimeAsync(RELEASE_CONFIRM_BUDGET); // bound elapses; in-flight op still unsettled

    expect(mocks.contextsCreated).toBe(contextsAfterA);
    expect(String(errorFor(channel, "b")?.payload.error)).toMatch(/still recovering/i);
    expect(endedFor(channel, "b")).toBe(false);
  });

  it("release() that resolves AFTER the wait budget: no fresh context until it resolves, then a later request builds fresh", async () => {
    vi.useFakeTimers();
    mocks.completionImpl = () => new Promise(() => {}); // request A wedges
    // Hold the native release() open until we resolve it BY HAND, well after the wait budget.
    let resolveRelease: (() => void) | undefined;
    mocks.release.mockImplementationOnce(() => new Promise<void>((resolve) => (resolveRelease = () => resolve())));

    const channel = makeChannel();
    registerOnDeviceLlm(channel);

    channel.emit("loam-llm-request", { id: "a", messages: [{ role: "user", content: "hi" }] });
    await vi.advanceTimersByTimeAsync(INFERENCE_TIMEOUT); // A times out → release pending → inFlightOp set
    expect(String(errorFor(channel, "a")?.payload.error)).toMatch(/timed out/i);
    const contextsWhileReleasing = mocks.contextsCreated;

    // B, submitted while the old release is still in flight, gets the recovery error and builds nothing.
    channel.emit("loam-llm-request", { id: "b", messages: [{ role: "user", content: "yo" }] });
    await vi.advanceTimersByTimeAsync(RELEASE_CONFIRM_BUDGET);
    expect(mocks.contextsCreated).toBe(contextsWhileReleasing);
    expect(String(errorFor(channel, "b")?.payload.error)).toMatch(/still recovering/i);

    // The native release finally resolves → in-flight op clears, engine usable again.
    mocks.completionImpl = async (_params, onToken) => {
      onToken?.({ token: "ok" });
      return { text: "ok" };
    };
    resolveRelease?.();
    await vi.advanceTimersByTimeAsync(10);

    // C, submitted AFTER the release resolved, recovers: it builds a fresh context and completes.
    channel.emit("loam-llm-request", { id: "c", messages: [{ role: "user", content: "again" }] });
    await vi.advanceTimersByTimeAsync(10);
    expect(mocks.contextsCreated).toBe(contextsWhileReleasing + 1);
    expect(endedFor(channel, "c")).toBe(true);
  });

  it("release() that REJECTS poisons the engine: no second context in-process, later requests get a restart error", async () => {
    vi.useFakeTimers();
    mocks.completionImpl = () => new Promise(() => {}); // request A wedges
    // The native release() REJECTS — the context may still be resident, so we can never safely build another.
    mocks.release.mockImplementationOnce(() => Promise.reject(new Error("native release blew up")));

    const channel = makeChannel();
    registerOnDeviceLlm(channel);

    channel.emit("loam-llm-request", { id: "a", messages: [{ role: "user", content: "hi" }] });
    await vi.advanceTimersByTimeAsync(INFERENCE_TIMEOUT); // A times out → beginReleaseLoaded → release rejects → poisoned
    expect(String(errorFor(channel, "a")?.payload.error)).toMatch(/timed out/i);
    const contextsAtPoison = mocks.contextsCreated;

    // B gets the restart error and builds nothing.
    channel.emit("loam-llm-request", { id: "b", messages: [{ role: "user", content: "yo" }] });
    await vi.advanceTimersByTimeAsync(10);
    expect(mocks.contextsCreated).toBe(contextsAtPoison);
    expect(String(errorFor(channel, "b")?.payload.error)).toMatch(/needs a restart/i);

    // Poison is terminal until process restart: a much later request still refuses, never re-`initLlama`.
    channel.emit("loam-llm-request", { id: "c", messages: [{ role: "user", content: "again" }] });
    await vi.advanceTimersByTimeAsync(10);
    expect(mocks.contextsCreated).toBe(contextsAtPoison);
    expect(String(errorFor(channel, "c")?.payload.error)).toMatch(/needs a restart/i);
  });

  it("a completion that RESOLVES during cleanup still times out — it cannot win the race (invariant 1)", async () => {
    vi.useFakeTimers();
    // Request A's completion is pending until we resolve it BY HAND, mid-cleanup. This is the critical race:
    // the timeout sentinel must have already won the `Promise.race`, so A finishing during cleanup can NOT
    // settle the run via `onEnd` and advance the queue onto the still-live (about-to-be-released) context.
    let resolveA: ((value: unknown) => void) | undefined;
    mocks.completionImpl = () =>
      new Promise((resolve) => {
        resolveA = resolve;
      });
    // A hung stop keeps cleanup in progress across the window where we resolve A, so the ordering is forced
    // (and proves it's the BOUNDED stop budget, not stopCompletion resolving, that drives cleanup forward).
    mocks.stopCompletion.mockImplementationOnce(() => new Promise(() => {}));

    const channel = makeChannel();
    registerOnDeviceLlm(channel);

    channel.emit("loam-llm-request", { id: "a", messages: [{ role: "user", content: "hi" }] });
    // Fire A's inference timeout: the sentinel wins the race, cleanup begins (stop pending, release not yet).
    await vi.advanceTimersByTimeAsync(INFERENCE_TIMEOUT);
    expect(mocks.stopCompletion).toHaveBeenCalledTimes(1);
    expect(mocks.release).not.toHaveBeenCalled();

    // A's native completion FINISHES now, during cleanup. With the pre-fix code this would win the race and
    // emit `loam-llm-end` for A; with the sentinel already resolved it must be ignored.
    resolveA?.({ text: "finished late" });
    await Promise.resolve();
    await Promise.resolve();
    expect(endedFor(channel, "a")).toBe(false);

    // Elapse the stop budget → beginReleaseLoaded → context released → A rejects (timed out).
    mocks.completionImpl = async (_params, onToken) => {
      onToken?.({ token: "ok" });
      return { text: "ok" };
    };
    await vi.advanceTimersByTimeAsync(5000);

    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(String(errorFor(channel, "a")?.payload.error)).toMatch(/timed out/i);
    expect(endedFor(channel, "a")).toBe(false);

    // The default release resolved → engine usable again → a later request builds a FRESH context.
    const contextsBeforeB = mocks.contextsCreated;
    channel.emit("loam-llm-request", { id: "b", messages: [{ role: "user", content: "yo" }] });
    await vi.advanceTimersByTimeAsync(10);
    expect(mocks.contextsCreated).toBe(contextsBeforeB + 1);
    expect(endedFor(channel, "b")).toBe(true);
  });

  it("releases the loaded context when no model is active (Deactivate / deleted active model) (invariant 5)", async () => {
    const channel = makeChannel();
    registerOnDeviceLlm(channel);

    // First DM loads + uses the context; nothing is released yet.
    channel.emit("loam-llm-request", { id: "1", messages: [{ role: "user", content: "hi" }] });
    await flush();
    expect(endedFor(channel, "1")).toBe(true);
    expect(mocks.release).not.toHaveBeenCalled();

    // Operator deactivates (or deletes the active model): the next request resolves no active path.
    mocks.state = { downloaded: [], activeId: undefined };
    channel.emit("loam-llm-request", { id: "2", messages: [{ role: "user", content: "hi" }] });
    await flush();

    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(String(errorFor(channel, "2")?.payload.error)).toMatch(/No on-device model is selected/i);
  });

  it("does not throw (and never crashes) when release fails on the no-active-model path", async () => {
    mocks.release.mockRejectedValueOnce(new Error("native release blew up"));
    const channel = makeChannel();
    registerOnDeviceLlm(channel);

    // Load the context first.
    channel.emit("loam-llm-request", { id: "1", messages: [{ role: "user", content: "hi" }] });
    await flush();

    mocks.state = { downloaded: [], activeId: undefined };
    channel.emit("loam-llm-request", { id: "2", messages: [{ role: "user", content: "hi" }] });
    await flush();

    // A throwing release is swallowed (it poisons the engine, but that's off the no-model path here); the
    // caller still gets the graceful "no model" error rather than a crash.
    expect(String(errorFor(channel, "2")?.payload.error)).toMatch(/No on-device model is selected/i);
  });
});

describe("reconcileActiveModel — release/deactivate driven from the actions layer", () => {
  it("reconcileActiveModel(null) releases the loaded context and forces a fresh one next time", async () => {
    const channel = makeChannel();
    registerOnDeviceLlm(channel);

    // Load + use the context once.
    channel.emit("loam-llm-request", { id: "1", messages: [{ role: "user", content: "hi" }] });
    await flush();
    expect(endedFor(channel, "1")).toBe(true);
    expect(mocks.release).not.toHaveBeenCalled();

    // Operator taps Deactivate: the actions layer calls this after the confirmed clear. The default release
    // resolves, so the engine is usable again.
    reconcileActiveModel(null);
    await flush();
    expect(mocks.release).toHaveBeenCalledTimes(1);

    // A later inference rebuilds a fresh context (the cached one was released; the store still lists m active).
    const contextsBefore = mocks.contextsCreated;
    channel.emit("loam-llm-request", { id: "2", messages: [{ role: "user", content: "hi" }] });
    await flush();
    expect(mocks.contextsCreated).toBe(contextsBefore + 1);
    expect(endedFor(channel, "2")).toBe(true);
  });

  it("reconcileActiveModel(null) is a no-op that never throws when no context is loaded", async () => {
    reconcileActiveModel(null);
    await flush();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("reconcileActiveModel(null) whose release HANGS does not wedge the queue — a later request recovers (bounded), builds no context", async () => {
    vi.useFakeTimers();
    const channel = makeChannel();
    registerOnDeviceLlm(channel);

    channel.emit("loam-llm-request", { id: "1", messages: [{ role: "user", content: "hi" }] });
    await vi.advanceTimersByTimeAsync(1);
    expect(endedFor(channel, "1")).toBe(true);

    // Operator taps Deactivate/Delete, but the native release() never settles. The enqueued release detaches
    // synchronously and starts the (hung) native release, so the queue advances — it can't wedge.
    mocks.release.mockImplementationOnce(() => new Promise(() => {}));
    reconcileActiveModel(null);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.release).toHaveBeenCalledTimes(1);
    const contextsWhileReleasing = mocks.contextsCreated;

    // A following inference request bounds its wait on the in-flight release, then fails with the recovering
    // error (rather than hanging behind the never-settling release) — and builds no second context.
    channel.emit("loam-llm-request", { id: "2", messages: [{ role: "user", content: "hi" }] });
    await vi.advanceTimersByTimeAsync(RELEASE_CONFIRM_BUDGET);
    expect(mocks.contextsCreated).toBe(contextsWhileReleasing);
    expect(String(errorFor(channel, "2")?.payload.error)).toMatch(/still recovering/i);
    expect(endedFor(channel, "2")).toBe(false);
  });
});

describe("bounded model load — a never-settling initLlama can't wedge the engine", () => {
  it("getBackendDevicesInfo never settling does NOT block the load (diagnostic is fire-and-forget)", async () => {
    mocks.backendDevicesImpl = () => new Promise(() => {}); // hangs forever
    const channel = makeChannel();
    registerOnDeviceLlm(channel);

    channel.emit("loam-llm-request", { id: "1", messages: [{ role: "user", content: "hi" }] });
    await flush();

    // The load + completion still succeed — the hung diagnostic never gated `initLlama`.
    expect(endedFor(channel, "1")).toBe(true);
    expect(mocks.contextsCreated).toBe(1);
  });

  it("initLlama never settling: the request errors within the bound, later requests fail fast, no 2nd load", async () => {
    vi.useFakeTimers();
    mocks.initLlamaImpl = () => new Promise(() => {}); // never settles
    const channel = makeChannel();
    registerOnDeviceLlm(channel);

    channel.emit("loam-llm-request", { id: "1", messages: [{ role: "user", content: "hi" }] });
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT); // past the model-load timeout
    expect(String(errorFor(channel, "1")?.payload.error)).toMatch(/timed out/i);

    // A later request bounds its wait on the still-in-flight abandoned load, then fails fast — no 2nd initLlama.
    channel.emit("loam-llm-request", { id: "2", messages: [{ role: "user", content: "hi" }] });
    await vi.advanceTimersByTimeAsync(RELEASE_CONFIRM_BUDGET);
    expect(String(errorFor(channel, "2")?.payload.error)).toMatch(/still recovering/i);
    // initLlama was called but never returned a context; the mock only counts contexts it actually returns.
    expect(mocks.contextsCreated).toBe(0);
  });

  it("a load that TIMES OUT then RESOLVES late disposes the stale context and never runs completion()", async () => {
    vi.useFakeTimers();
    let resolveLoad!: (ctx: unknown) => void;
    mocks.initLlamaImpl = () => new Promise((resolve) => (resolveLoad = resolve));
    const completion = vi.fn(async () => ({ text: "should not run" }));
    mocks.completionImpl = completion;
    const channel = makeChannel();
    registerOnDeviceLlm(channel);

    channel.emit("loam-llm-request", { id: "1", messages: [{ role: "user", content: "hi" }] });
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT); // abandon the load
    expect(String(errorFor(channel, "1")?.payload.error)).toMatch(/timed out/i);

    // The native load resolves LATE with a context — it must be RELEASED (disposed), never published/run.
    resolveLoad(makeNativeContext());
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.release).toHaveBeenCalledTimes(1); // the stale context was disposed
    expect(completion).not.toHaveBeenCalled();
  });

  it("deactivate during a pending load prevents the late context from becoming active or running completion", async () => {
    vi.useFakeTimers();
    let resolveLoad!: (ctx: unknown) => void;
    mocks.initLlamaImpl = () => new Promise((resolve) => (resolveLoad = resolve));
    const completion = vi.fn(async () => ({ text: "should not run" }));
    mocks.completionImpl = completion;
    const channel = makeChannel();
    registerOnDeviceLlm(channel);

    channel.emit("loam-llm-request", { id: "1", messages: [{ role: "user", content: "hi" }] });
    await vi.advanceTimersByTimeAsync(1); // load is in flight
    // Operator deactivates mid-load → the load is abandoned SYNCHRONOUSLY (the loadEpoch is bumped), so the
    // late context can't be published behind the queued command.
    reconcileActiveModel(null);
    await vi.advanceTimersByTimeAsync(1);

    // The load now resolves — its context is DISPOSED, never published, and request 1 never runs completion.
    resolveLoad(makeNativeContext());
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(completion).not.toHaveBeenCalled();
    expect(endedFor(channel, "1")).toBe(false);

    // A subsequent request (default fast initLlama) builds a FRESH context — the stale one never became active.
    mocks.initLlamaImpl = undefined;
    mocks.completionImpl = async (_params, onToken) => {
      onToken?.({ token: "ok" });
      return { text: "ok" };
    };
    channel.emit("loam-llm-request", { id: "2", messages: [{ role: "user", content: "hi" }] });
    await vi.advanceTimersByTimeAsync(1);
    expect(endedFor(channel, "2")).toBe(true);
  });

  it("an abandoned load that REJECTS returns the engine safely to usable", async () => {
    vi.useFakeTimers();
    let rejectLoad!: (err: unknown) => void;
    mocks.initLlamaImpl = () => new Promise((_resolve, reject) => (rejectLoad = reject));
    const channel = makeChannel();
    registerOnDeviceLlm(channel);

    channel.emit("loam-llm-request", { id: "1", messages: [{ role: "user", content: "hi" }] });
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT);
    expect(String(errorFor(channel, "1")?.payload.error)).toMatch(/timed out/i);

    rejectLoad(new Error("native load blew up"));
    await vi.advanceTimersByTimeAsync(1);

    // Engine recovered: a fresh request (default initLlama) loads and completes.
    mocks.initLlamaImpl = undefined;
    channel.emit("loam-llm-request", { id: "2", messages: [{ role: "user", content: "hi" }] });
    await vi.advanceTimersByTimeAsync(1);
    expect(endedFor(channel, "2")).toBe(true);
  });
});

describe("model switch invalidates an in-flight load of the old model (Sol Fable-round-5 P2)", () => {
  it("switching to B disposes a still-loading A, never runs completion(A), and B then loads and runs", async () => {
    let resolveLoad!: (ctx: unknown) => void;
    mocks.initLlamaImpl = () => new Promise((resolve) => (resolveLoad = resolve));
    const completion = vi.fn(async () => ({ text: "should not run" }));
    mocks.completionImpl = completion;
    const channel = makeChannel();
    registerOnDeviceLlm(channel);

    channel.emit("loam-llm-request", { id: "1", messages: [{ role: "user", content: "hi" }] });
    await flush(); // A is loading (loadingPath = /models/m.gguf)

    // Operator selects a DIFFERENT model — the actions layer notifies the engine (target-aware).
    reconcileActiveModel("file:///models/other.gguf");

    // A's native load resolves LATE: it must be disposed, not published, and completion never runs.
    resolveLoad(makeNativeContext());
    await flush();
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(completion).not.toHaveBeenCalled();
    expect(endedFor(channel, "1")).toBe(false);

    // The next request can load and run B (the engine recovered after A's disposal). The store now lists B.
    mocks.state = { downloaded: [model("other")], activeId: "other" };
    mocks.initLlamaImpl = undefined;
    mocks.completionImpl = async (_params, onToken) => {
      onToken?.({ token: "ok" });
      return { text: "ok" };
    };
    channel.emit("loam-llm-request", { id: "2", messages: [{ role: "user", content: "hi" }] });
    await flush();
    expect(endedFor(channel, "2")).toBe(true);
    // The load that ran was B's normalized path (Sol round-6 test-coverage correction: the switch really
    // moves the engine to B, it doesn't merely abandon A).
    const { initLlama } = (await import("llama.rn")) as unknown as { initLlama: ReturnType<typeof vi.fn> };
    expect(initLlama).toHaveBeenLastCalledWith(expect.objectContaining({ model: "/models/other.gguf" }));
  });

  it("reconciling to the SAME model does not invalidate its in-flight load", async () => {
    let resolveLoad!: (ctx: unknown) => void;
    mocks.initLlamaImpl = () => new Promise((resolve) => (resolveLoad = resolve));
    const channel = makeChannel();
    registerOnDeviceLlm(channel);

    channel.emit("loam-llm-request", { id: "1", messages: [{ role: "user", content: "hi" }] });
    await flush();

    // Re-selecting the SAME model must NOT invalidate its load (target matches loadingPath).
    reconcileActiveModel("file:///models/m.gguf");
    resolveLoad(makeNativeContext());
    await flush();

    // The load published normally and request 1 completed; nothing was released.
    expect(endedFor(channel, "1")).toBe(true);
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("switching away from an already-LOADED model releases it (serialized)", async () => {
    const channel = makeChannel();
    registerOnDeviceLlm(channel);
    channel.emit("loam-llm-request", { id: "1", messages: [{ role: "user", content: "hi" }] });
    await flush();
    expect(endedFor(channel, "1")).toBe(true);
    expect(mocks.release).not.toHaveBeenCalled();

    // The loaded model is m.gguf; reconciling to a different model releases it.
    reconcileActiveModel("file:///models/other.gguf");
    await flush();
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("invalidateStaleLoad at PERSIST abandons an in-flight load of the OLD model WITHOUT releasing a loaded context", async () => {
    let resolveLoad!: (ctx: unknown) => void;
    mocks.initLlamaImpl = () => new Promise((resolve) => (resolveLoad = resolve));
    const completion = vi.fn(async () => ({ text: "should not run" }));
    mocks.completionImpl = completion;
    const channel = makeChannel();
    registerOnDeviceLlm(channel);

    channel.emit("loam-llm-request", { id: "1", messages: [{ role: "user", content: "hi" }] });
    await flush(); // A (m.gguf) is loading

    // Operator selects B; at PERSIST the actions layer calls invalidateStaleLoad(B) — abandons A's load but
    // releases NOTHING (so a later bridge failure that rolls back to A leaves A untouched).
    invalidateStaleLoad("file:///models/other.gguf");
    resolveLoad(makeNativeContext());
    await flush();

    // A's late context was disposed (never published/run); no completion ran; request 1 got no clean end.
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(completion).not.toHaveBeenCalled();
    expect(endedFor(channel, "1")).toBe(false);
  });

  it("invalidateStaleLoad(keep) does NOT abandon an in-flight load of the KEPT model", async () => {
    let resolveLoad!: (ctx: unknown) => void;
    mocks.initLlamaImpl = () => new Promise((resolve) => (resolveLoad = resolve));
    const channel = makeChannel();
    registerOnDeviceLlm(channel);

    channel.emit("loam-llm-request", { id: "1", messages: [{ role: "user", content: "hi" }] });
    await flush(); // m.gguf loading

    // A no-op switch to the SAME model persisting keep=m must not abandon m's own load.
    invalidateStaleLoad("file:///models/m.gguf");
    resolveLoad(makeNativeContext());
    await flush();
    expect(endedFor(channel, "1")).toBe(true);
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("defense in depth: if the active model changes DURING a load, completion is not run for the stale one", async () => {
    // First read (target resolution) sees A active; the second read (processInfer re-check) sees B active.
    const stateA = { downloaded: [model("a"), model("b")], activeId: "a" as string | undefined };
    const stateB = { downloaded: [model("a"), model("b")], activeId: "b" as string | undefined };
    let reads = 0;
    mocks.loadStateImpl = async () => (++reads <= 1 ? stateA : stateB);
    const completion = vi.fn(async () => ({ text: "should not run" }));
    mocks.completionImpl = completion;
    const channel = makeChannel();
    registerOnDeviceLlm(channel);

    channel.emit("loam-llm-request", { id: "1", messages: [{ role: "user", content: "hi" }] });
    await flush();

    // The model loaded was A, but the re-read found B active → completion must NOT run; a retry error instead.
    expect(completion).not.toHaveBeenCalled();
    expect(endedFor(channel, "1")).toBe(false);
    expect(String(errorFor(channel, "1")?.payload.error)).toMatch(/recovering/i);
  });

  function model(id: string) {
    return { id, uri: `file:///models/${id}.gguf`, displayName: id, sizeBytes: 1, isCustom: false, sourceUrl: "", downloadedAt: 0 };
  }
});

describe("confirmActiveModelReleased — the delete BARRIER", () => {
  it("is PATH-AWARE: a different model's uri never releases the loaded one", async () => {
    const channel = makeChannel();
    registerOnDeviceLlm(channel);

    // Load model `m` (uri file:///models/m.gguf → stored as the bare path /models/m.gguf).
    channel.emit("loam-llm-request", { id: "1", messages: [{ role: "user", content: "hi" }] });
    await flush();
    expect(endedFor(channel, "1")).toBe(true);
    expect(mocks.release).not.toHaveBeenCalled();

    // Reconciling an OLD delete for a DIFFERENT model must NOT tear down the loaded one (accepts the raw
    // `file://` uri and strips it before comparing, same as the active-path derivation).
    await expect(confirmActiveModelReleased("file:///models/other.gguf")).resolves.toBe("released");
    await flush();
    expect(mocks.release).not.toHaveBeenCalled();

    // The loaded model's own uri DOES release it.
    await confirmActiveModelReleased("file:///models/m.gguf");
    await flush();
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("resolves 'released' and never releases when nothing is loaded", async () => {
    await expect(confirmActiveModelReleased("file:///models/m.gguf")).resolves.toBe("released");
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("resolves 'released' once the native release CONFIRMS (safe to unlink)", async () => {
    const channel = makeChannel();
    registerOnDeviceLlm(channel);
    channel.emit("loam-llm-request", { id: "1", messages: [{ role: "user", content: "hi" }] });
    await flush();
    // Default release resolves → the barrier confirms disposal, so the caller may safely unlink the file.
    await expect(confirmActiveModelReleased("file:///models/m.gguf")).resolves.toBe("released");
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("resolves 'poisoned' when the native release REJECTS", async () => {
    const channel = makeChannel();
    registerOnDeviceLlm(channel);
    channel.emit("loam-llm-request", { id: "1", messages: [{ role: "user", content: "hi" }] });
    await flush();
    mocks.release.mockRejectedValueOnce(new Error("native release blew up"));
    await expect(confirmActiveModelReleased("file:///models/m.gguf")).resolves.toBe("poisoned");
  });

  it("whose native release HANGS resolves 'unconfirmed' after the budget without wedging the queue", async () => {
    vi.useFakeTimers();
    const channel = makeChannel();
    registerOnDeviceLlm(channel);

    channel.emit("loam-llm-request", { id: "1", messages: [{ role: "user", content: "hi" }] });
    await vi.advanceTimersByTimeAsync(1);
    expect(endedFor(channel, "1")).toBe(true);

    // The native release() never settles: the BARRIER must not report 'released' (which would let the caller
    // unlink a still-mapped file) and must not block forever — it resolves 'unconfirmed' once the bounded
    // confirmation budget elapses, so the caller keeps the delete-pending and reconciles later.
    mocks.release.mockImplementationOnce(() => new Promise(() => {}));
    const relPromise = confirmActiveModelReleased("file:///models/m.gguf");
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.release).toHaveBeenCalledTimes(1); // the release WAS initiated
    const contextsWhileReleasing = mocks.contextsCreated;

    await vi.advanceTimersByTimeAsync(RELEASE_CONFIRM_BUDGET); // past the confirmation budget
    await expect(relPromise).resolves.toBe("unconfirmed");

    // A RETRY for the SAME model (the context is already detached, but its native release is still in flight)
    // must ALSO resolve 'unconfirmed' — NOT 'released': unlinking now would remove a file the still-disposing
    // native context may map. It builds no new context.
    const retry = confirmActiveModelReleased("file:///models/m.gguf");
    await vi.advanceTimersByTimeAsync(RELEASE_CONFIRM_BUDGET);
    expect(mocks.contextsCreated).toBe(contextsWhileReleasing);
    await expect(retry).resolves.toBe("unconfirmed");

    // A following inference request fails FAST (bounded on the in-flight release) rather than hanging, and
    // builds no context.
    channel.emit("loam-llm-request", { id: "2", messages: [{ role: "user", content: "hi" }] });
    await vi.advanceTimersByTimeAsync(RELEASE_CONFIRM_BUDGET);
    expect(mocks.contextsCreated).toBe(contextsWhileReleasing);
    expect(String(errorFor(channel, "2")?.payload.error)).toMatch(/still recovering/i);
  });

  it("retry resolves 'released' once the in-flight release CONFIRMS", async () => {
    const channel = makeChannel();
    registerOnDeviceLlm(channel);
    channel.emit("loam-llm-request", { id: "1", messages: [{ role: "user", content: "hi" }] });
    await flush();

    // A controllable native release: still in flight during the first barrier call.
    let finishRelease!: () => void;
    mocks.release.mockImplementationOnce(() => new Promise<void>((resolve) => (finishRelease = resolve)));
    const first = await confirmActiveModelReleased("file:///models/m.gguf", 20);
    expect(first).toBe("unconfirmed"); // release hasn't settled within the budget

    // Now the native release completes; a RETRY for the same model confirms 'released' (safe to unlink).
    finishRelease();
    await flush();
    await expect(confirmActiveModelReleased("file:///models/m.gguf", 20)).resolves.toBe("released");
  });

  it("of a model that's still LOADING returns 'unconfirmed' (defers the unlink)", async () => {
    vi.useFakeTimers();
    mocks.initLlamaImpl = () => new Promise(() => {}); // load hangs
    const channel = makeChannel();
    registerOnDeviceLlm(channel);

    channel.emit("loam-llm-request", { id: "1", messages: [{ role: "user", content: "hi" }] });
    await vi.advanceTimersByTimeAsync(1); // load in flight (loadingPath === m.gguf)

    // Deleting a model that's still loading must NOT report 'released' (its file would be unlinked while the
    // load may still map it) — the caller's wait is bounded and returns 'unconfirmed'.
    const outcome = confirmActiveModelReleased("file:///models/m.gguf", 50);
    await vi.advanceTimersByTimeAsync(50);
    await expect(outcome).resolves.toBe("unconfirmed");
  });
});
