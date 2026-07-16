// on-device-llm.ts guards several failure modes that would otherwise only surface on-device (docs/06):
//   1. A native `completion()` that never settles must not wedge the serialized inference chain
//      forever — it's raced against a bounded timeout that calls `stopCompletion()`, INITIATES the
//      context release, and advances the chain, so later DMs aren't blocked behind the wedge.
//   2. Sol P1 (this file's focus): timeout recovery must never double-load native contexts and OOM. A
//      new native context is NEVER created while an older context's `release()` is still unresolved
//      (`releasing`) or has FAILED (`poisoned`) — instead the request fails fast with a recovery /
//      restart error. Only once the old `release()` actually RESOLVES does a later request build fresh.
//   3. When no model is active (Deactivate / the active model deleted) the loaded multi-GB context is
//      released so its RAM is reclaimed rather than left resident until app restart.
// Both are exercised here through the bridge's public `registerOnDeviceLlm` surface, with `llama.rn`
// and the model-manager store replaced by in-memory fakes (no native module runs under Vitest).
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
  // How many native contexts `initLlama` has built this test — lets the P1 tests assert that a released
  // context is REBUILT fresh (a different native context) only after the old release resolved, and that
  // NO fresh context is built while the engine is `releasing`/`poisoned`.
  contextsCreated: 0,
  // Overridable per-test so the bounded-load tests (Sol Fable-round-4 P1) can make `initLlama` hang/reject
  // and `getBackendDevicesInfo` hang. `initLlamaImpl` returns the native context (or throws/never-settles);
  // `backendDevicesImpl` is the diagnostic probe (must never gate the load).
  initLlamaImpl: undefined as undefined | (() => Promise<unknown>),
  backendDevicesImpl: undefined as undefined | (() => Promise<unknown[]>),
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
  loadModelManagerState: vi.fn(async () => mocks.state),
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

// Re-import the module under test per test so its module-level state (the loaded context, the engine
// state machine, and the inference chain) is fresh — a wedged run in one test must not chain into the next.
let registerOnDeviceLlm: typeof import("@/lib/on-device-llm").registerOnDeviceLlm;
let releaseActiveModelContext: typeof import("@/lib/on-device-llm").releaseActiveModelContext;
let releaseModelContextIfLoaded: typeof import("@/lib/on-device-llm").releaseModelContextIfLoaded;

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
  ({ registerOnDeviceLlm, releaseActiveModelContext, releaseModelContextIfLoaded } = await import("@/lib/on-device-llm"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("on-device-llm inference", () => {
  it("streams completion tokens as deltas and ends (success path unchanged)", async () => {
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

  it("times out a wedged completion, calls stopCompletion, and reports a timeout error (Fix 1)", async () => {
    vi.useFakeTimers();
    // The completion never settles — the exact wedge that would otherwise block every later DM.
    mocks.completionImpl = () => new Promise(() => {});
    const channel = makeChannel();
    registerOnDeviceLlm(channel);

    channel.emit("loam-llm-request", { id: "a", messages: [{ role: "user", content: "hi" }] });
    // Advance past the module's INFERENCE_TIMEOUT_MS (3 min); advanceTimersByTimeAsync flushes the
    // intervening microtasks (activeModelPath / initLlama / bounded stop / release) around the timer.
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);

    expect(mocks.stopCompletion).toHaveBeenCalledTimes(1);
    const errored = errorFor(channel, "a");
    expect(errored).toBeDefined();
    expect(String(errored?.payload.error)).toMatch(/timed out/i);
    // The wedged context was torn down (its release was initiated + resolved with the default mock).
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("release() that NEVER settles: a later request gets a recovery error and builds NO new context (Sol P1 OOM guard)", async () => {
    vi.useFakeTimers();
    mocks.completionImpl = () => new Promise(() => {}); // request A wedges
    // The native release() never resolves — the engine stays `releasing`, so a fresh context must never load.
    mocks.release.mockImplementationOnce(() => new Promise(() => {}));

    const channel = makeChannel();
    registerOnDeviceLlm(channel);

    channel.emit("loam-llm-request", { id: "a", messages: [{ role: "user", content: "hi" }] });
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000); // A times out → beginRelease → release hangs → `releasing`
    expect(String(errorFor(channel, "a")?.payload.error)).toMatch(/timed out/i);
    const contextsAfterA = mocks.contextsCreated; // A's one context — never to be torn down (release hung)

    // Request B arrives while the engine is still `releasing`: it must NOT call initLlama (no second
    // multi-GB context alongside the un-disposed one) and must get an immediate recovery error, not a hang.
    channel.emit("loam-llm-request", { id: "b", messages: [{ role: "user", content: "yo" }] });
    await vi.advanceTimersByTimeAsync(10);

    expect(mocks.contextsCreated).toBe(contextsAfterA);
    expect(String(errorFor(channel, "b")?.payload.error)).toMatch(/still recovering/i);
    expect(endedFor(channel, "b")).toBe(false);
  });

  it("release() that resolves AFTER the UI budget: no fresh context until it resolves, then a later request builds fresh (Sol P1)", async () => {
    vi.useFakeTimers();
    mocks.completionImpl = () => new Promise(() => {}); // request A wedges
    // Hold the native release() open until we resolve it BY HAND, well after the 2s stop budget.
    let resolveRelease: (() => void) | undefined;
    mocks.release.mockImplementationOnce(() => new Promise<void>((resolve) => (resolveRelease = () => resolve())));

    const channel = makeChannel();
    registerOnDeviceLlm(channel);

    channel.emit("loam-llm-request", { id: "a", messages: [{ role: "user", content: "hi" }] });
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000); // A times out → beginRelease → release pending → `releasing`
    expect(String(errorFor(channel, "a")?.payload.error)).toMatch(/timed out/i);
    const contextsWhileReleasing = mocks.contextsCreated;

    // B, submitted while the old release is still in flight, gets the recovery error and builds nothing.
    channel.emit("loam-llm-request", { id: "b", messages: [{ role: "user", content: "yo" }] });
    await vi.advanceTimersByTimeAsync(10);
    expect(mocks.contextsCreated).toBe(contextsWhileReleasing);
    expect(String(errorFor(channel, "b")?.payload.error)).toMatch(/still recovering/i);

    // The native release finally resolves → engine returns to `ready`.
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

  it("release() that REJECTS poisons the engine: no second context in-process, later requests get a restart error (Sol P1)", async () => {
    vi.useFakeTimers();
    mocks.completionImpl = () => new Promise(() => {}); // request A wedges
    // The native release() REJECTS — the context may still be resident, so we can never safely build another.
    mocks.release.mockImplementationOnce(() => Promise.reject(new Error("native release blew up")));

    const channel = makeChannel();
    registerOnDeviceLlm(channel);

    channel.emit("loam-llm-request", { id: "a", messages: [{ role: "user", content: "hi" }] });
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000); // A times out → beginRelease → release rejects → `poisoned`
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

  it("a completion that RESOLVES during cleanup still times out — it cannot win the race (Fix 1, CodeRabbit)", async () => {
    vi.useFakeTimers();
    // Request A's completion is pending until we resolve it BY HAND, mid-cleanup. This is the critical race:
    // the timeout sentinel must have already won the `Promise.race`, so A finishing during cleanup can NOT
    // settle the run via `onEnd` and advance the chain onto the still-live (about-to-be-released) context.
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
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    expect(mocks.stopCompletion).toHaveBeenCalledTimes(1);
    expect(mocks.release).not.toHaveBeenCalled();

    // A's native completion FINISHES now, during cleanup. With the pre-fix code this would win the race and
    // emit `loam-llm-end` for A; with the sentinel already resolved it must be ignored.
    resolveA?.({ text: "finished late" });
    await Promise.resolve();
    await Promise.resolve();
    expect(endedFor(channel, "a")).toBe(false);

    // Elapse the stop budget → beginRelease → context released → A rejects (timed out).
    mocks.completionImpl = async (_params, onToken) => {
      onToken?.({ token: "ok" });
      return { text: "ok" };
    };
    await vi.advanceTimersByTimeAsync(5000);

    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(String(errorFor(channel, "a")?.payload.error)).toMatch(/timed out/i);
    expect(endedFor(channel, "a")).toBe(false);

    // The default release resolved → engine is `ready` again → a later request builds a FRESH context.
    const contextsBeforeB = mocks.contextsCreated;
    channel.emit("loam-llm-request", { id: "b", messages: [{ role: "user", content: "yo" }] });
    await vi.advanceTimersByTimeAsync(10);
    expect(mocks.contextsCreated).toBe(contextsBeforeB + 1);
    expect(endedFor(channel, "b")).toBe(true);
  });

  it("releaseActiveModelContext whose release HANGS does not wedge the chain — a later request fails promptly (Sol P1)", async () => {
    const channel = makeChannel();
    registerOnDeviceLlm(channel);

    // Load + use the context once.
    channel.emit("loam-llm-request", { id: "1", messages: [{ role: "user", content: "hi" }] });
    await flush();
    expect(endedFor(channel, "1")).toBe(true);

    // Operator taps Deactivate/Delete, but the native release() never settles. releaseActiveModelContext
    // must return PROMPTLY (initiate the tracked release, don't await it) so it can't wedge `inferenceChain`.
    mocks.release.mockImplementationOnce(() => new Promise(() => {}));
    // Returns PROMPTLY (schedules the release behind the chain); flush so the scheduled beginRelease runs.
    await releaseActiveModelContext();
    await flush();
    expect(mocks.release).toHaveBeenCalledTimes(1);
    const contextsWhileReleasing = mocks.contextsCreated;

    // A following inference request fails FAST with the recovery error (gated on `releasing`) rather than
    // hanging behind the never-settling release — and builds no second context.
    channel.emit("loam-llm-request", { id: "2", messages: [{ role: "user", content: "hi" }] });
    await flush();
    expect(mocks.contextsCreated).toBe(contextsWhileReleasing);
    expect(String(errorFor(channel, "2")?.payload.error)).toMatch(/still recovering/i);
    expect(endedFor(channel, "2")).toBe(false);
  });

  it("releaseActiveModelContext releases the loaded context and forces a fresh one next time (Fix 2)", async () => {
    const channel = makeChannel();
    registerOnDeviceLlm(channel);

    // Load + use the context once.
    channel.emit("loam-llm-request", { id: "1", messages: [{ role: "user", content: "hi" }] });
    await flush();
    expect(endedFor(channel, "1")).toBe(true);
    expect(mocks.release).not.toHaveBeenCalled();

    // Operator taps Deactivate (or deletes the active model): the component calls this directly. The default
    // release resolves, so the engine returns to `ready`.
    await releaseActiveModelContext();
    await flush();
    expect(mocks.release).toHaveBeenCalledTimes(1);

    // A later inference rebuilds a fresh context (the cached one was released and the engine is ready again).
    const contextsBefore = mocks.contextsCreated;
    channel.emit("loam-llm-request", { id: "2", messages: [{ role: "user", content: "hi" }] });
    await flush();
    expect(mocks.contextsCreated).toBe(contextsBefore + 1);
    expect(endedFor(channel, "2")).toBe(true);
  });

  it("releaseActiveModelContext is a no-op that never throws when no context is loaded (Fix 2)", async () => {
    await expect(releaseActiveModelContext()).resolves.toBeUndefined();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("releases the loaded context when no model is active (Deactivate / deleted active model) (Fix 2)", async () => {
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

  it("releaseModelContextIfLoaded is PATH-AWARE: a different model's uri never releases the loaded one (Finding 1)", async () => {
    const channel = makeChannel();
    registerOnDeviceLlm(channel);

    // Load model `m` (uri file:///models/m.gguf → stored as the bare path /models/m.gguf).
    channel.emit("loam-llm-request", { id: "1", messages: [{ role: "user", content: "hi" }] });
    await flush();
    expect(endedFor(channel, "1")).toBe(true);
    expect(mocks.release).not.toHaveBeenCalled();

    // Reconciling an OLD delete for a DIFFERENT model must NOT tear down the loaded one (accepts the raw
    // `file://` uri and strips it before comparing, same as the active-path derivation).
    await releaseModelContextIfLoaded("file:///models/other.gguf");
    await flush();
    expect(mocks.release).not.toHaveBeenCalled();

    // The loaded model's own uri DOES release it.
    await releaseModelContextIfLoaded("file:///models/m.gguf");
    await flush();
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("releaseModelContextIfLoaded resolves 'released' and never releases when nothing is loaded (Finding 1)", async () => {
    await expect(releaseModelContextIfLoaded("file:///models/m.gguf")).resolves.toBe("released");
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("releaseModelContextIfLoaded whose native release HANGS resolves 'unconfirmed' after the budget without wedging the chain (Finding 1 / Sol P1)", async () => {
    vi.useFakeTimers();
    const channel = makeChannel();
    registerOnDeviceLlm(channel);

    channel.emit("loam-llm-request", { id: "1", messages: [{ role: "user", content: "hi" }] });
    await vi.advanceTimersByTimeAsync(1);
    expect(endedFor(channel, "1")).toBe(true);

    // The native release() never settles: the BARRIER (CodeRabbit) must not report 'released' (which would
    // let the caller unlink a still-mapped file) and must not block forever — it resolves 'unconfirmed' once
    // the bounded confirmation budget (5s) elapses, so the caller keeps the delete-pending and reconciles later.
    mocks.release.mockImplementationOnce(() => new Promise(() => {}));
    const relPromise = releaseModelContextIfLoaded("file:///models/m.gguf");
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.release).toHaveBeenCalledTimes(1); // the release WAS initiated
    const contextsWhileReleasing = mocks.contextsCreated;

    await vi.advanceTimersByTimeAsync(5000); // past the confirmation budget
    await expect(relPromise).resolves.toBe("unconfirmed");

    // A RETRY for the SAME model (the context is already detached, but its native release is still in flight)
    // must ALSO resolve 'unconfirmed' — NOT 'released' (CodeRabbit): unlinking now would remove a file the
    // still-disposing native context may map. It builds no new context (engine stays `releasing`).
    const retry = releaseModelContextIfLoaded("file:///models/m.gguf");
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.contextsCreated).toBe(contextsWhileReleasing);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(retry).resolves.toBe("unconfirmed");

    // A following inference request fails FAST (engine `releasing`) rather than hanging, and builds no context.
    channel.emit("loam-llm-request", { id: "2", messages: [{ role: "user", content: "hi" }] });
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.contextsCreated).toBe(contextsWhileReleasing);
    expect(String(errorFor(channel, "2")?.payload.error)).toMatch(/still recovering/i);
  });

  it("releaseModelContextIfLoaded retry resolves 'released' once the in-flight release CONFIRMS (CodeRabbit)", async () => {
    const channel = makeChannel();
    registerOnDeviceLlm(channel);
    channel.emit("loam-llm-request", { id: "1", messages: [{ role: "user", content: "hi" }] });
    await flush();

    // A controllable native release: still in flight during the first barrier call.
    let finishRelease!: () => void;
    mocks.release.mockImplementationOnce(() => new Promise<void>((resolve) => (finishRelease = resolve)));
    const first = await releaseModelContextIfLoaded("file:///models/m.gguf", 20);
    expect(first).toBe("unconfirmed"); // release hasn't settled within the budget

    // Now the native release completes; a RETRY for the same model confirms 'released' (safe to unlink).
    finishRelease();
    await flush();
    await expect(releaseModelContextIfLoaded("file:///models/m.gguf", 20)).resolves.toBe("released");
  });

  it("releaseModelContextIfLoaded resolves 'released' once the native release CONFIRMS (Finding 1 / CodeRabbit)", async () => {
    const channel = makeChannel();
    registerOnDeviceLlm(channel);
    channel.emit("loam-llm-request", { id: "1", messages: [{ role: "user", content: "hi" }] });
    await flush();
    // Default release resolves → the barrier confirms disposal, so the caller may safely unlink the file.
    await expect(releaseModelContextIfLoaded("file:///models/m.gguf")).resolves.toBe("released");
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("releaseModelContextIfLoaded resolves 'poisoned' when the native release REJECTS (Finding 1)", async () => {
    const channel = makeChannel();
    registerOnDeviceLlm(channel);
    channel.emit("loam-llm-request", { id: "1", messages: [{ role: "user", content: "hi" }] });
    await flush();
    mocks.release.mockRejectedValueOnce(new Error("native release blew up"));
    await expect(releaseModelContextIfLoaded("file:///models/m.gguf")).resolves.toBe("poisoned");
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

describe("bounded model load — a never-settling initLlama can't wedge the engine (Sol Fable-round-4 P1)", () => {
  const LOAD_TIMEOUT = 3 * 60 * 1000;

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

    // A later request fails FAST (engine still `loading` behind the abandoned native load) — no 2nd initLlama.
    channel.emit("loam-llm-request", { id: "2", messages: [{ role: "user", content: "hi" }] });
    await vi.advanceTimersByTimeAsync(1);
    expect(String(errorFor(channel, "2")?.payload.error)).toMatch(/still recovering/i);
    // initLlama was called once for the wedged load; the mock only counts contexts it actually returns.
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
    // Operator deactivates mid-load → the load is invalidated SYNCHRONOUSLY (even though the load step still
    // holds the inference chain), so the late context can't be published behind the chain.
    await releaseActiveModelContext();
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

  it("releaseModelContextIfLoaded of a model that's still LOADING returns 'unconfirmed' (defers the unlink)", async () => {
    vi.useFakeTimers();
    mocks.initLlamaImpl = () => new Promise(() => {}); // load hangs
    const channel = makeChannel();
    registerOnDeviceLlm(channel);

    channel.emit("loam-llm-request", { id: "1", messages: [{ role: "user", content: "hi" }] });
    await vi.advanceTimersByTimeAsync(1); // load in flight (loadingPath === m.gguf)

    // Deleting a model that's still loading must NOT report 'released' (its file would be unlinked while the
    // load may still map it) — it defers until the abandoned load disposes.
    const outcome = releaseModelContextIfLoaded("file:///models/m.gguf", 50);
    await vi.advanceTimersByTimeAsync(50);
    await expect(outcome).resolves.toBe("unconfirmed");
  });

  it("an abandoned load that REJECTS returns the engine safely to ready", async () => {
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
