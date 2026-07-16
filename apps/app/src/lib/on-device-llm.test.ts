// on-device-llm.ts guards two failure modes that would otherwise only surface on-device (docs/06):
//   1. A native `completion()` that never settles must not wedge the serialized inference chain
//      forever — it's raced against a bounded timeout that calls `stopCompletion()` and advances the
//      chain, so later DMs still run.
//   2. When no model is active (Deactivate / the active model deleted) the loaded multi-GB context is
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
}));

vi.mock("llama.rn", () => ({
  getBackendDevicesInfo: vi.fn(async () => []),
  initLlama: vi.fn(async () => ({
    gpu: false,
    reasonNoGPU: "test",
    devices: [],
    completion: (params: unknown, onToken?: TokenCallback) => mocks.completionImpl(params, onToken),
    stopCompletion: mocks.stopCompletion,
    release: mocks.release,
  })),
}));

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

// Re-import the module under test per test so its module-level state (the loaded context + the
// inference chain) is fresh — a wedged run in one test must not chain into the next.
let registerOnDeviceLlm: typeof import("@/lib/on-device-llm").registerOnDeviceLlm;

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
  mocks.release.mockClear();
  ({ registerOnDeviceLlm } = await import("@/lib/on-device-llm"));
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
    expect(channel.posts.some((p) => p.name === "loam-llm-end" && p.payload.id === "x")).toBe(true);
    expect(channel.posts.some((p) => p.name === "loam-llm-error")).toBe(false);
  });

  it("times out a wedged completion, calls stopCompletion, and advances the chain (Fix 1)", async () => {
    vi.useFakeTimers();
    // First run's completion never settles — the exact wedge that would otherwise block every later DM.
    mocks.completionImpl = () => new Promise(() => {});
    const channel = makeChannel();
    registerOnDeviceLlm(channel);

    channel.emit("loam-llm-request", { id: "a", messages: [{ role: "user", content: "hi" }] });
    // Advance past the module's INFERENCE_TIMEOUT_MS (3 min); advanceTimersByTimeAsync flushes the
    // intervening microtasks (activeModelPath / initLlama) before firing the timeout timer.
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);

    expect(mocks.stopCompletion).toHaveBeenCalledTimes(1);
    const errored = channel.posts.find((p) => p.name === "loam-llm-error" && p.payload.id === "a");
    expect(errored).toBeDefined();
    expect(String(errored?.payload.error)).toMatch(/timed out/i);

    // The chain advanced: a subsequent DM runs to completion rather than queuing behind the wedge.
    mocks.completionImpl = async (_params, onToken) => {
      onToken?.({ token: "ok" });
      return { text: "ok" };
    };
    channel.emit("loam-llm-request", { id: "b", messages: [{ role: "user", content: "yo" }] });
    await vi.advanceTimersByTimeAsync(10);

    expect(channel.posts.some((p) => p.name === "loam-llm-end" && p.payload.id === "b")).toBe(true);
  });

  it("releases the loaded context when no model is active (Deactivate / deleted active model) (Fix 2)", async () => {
    const channel = makeChannel();
    registerOnDeviceLlm(channel);

    // First DM loads + uses the context; nothing is released yet.
    channel.emit("loam-llm-request", { id: "1", messages: [{ role: "user", content: "hi" }] });
    await flush();
    expect(channel.posts.some((p) => p.name === "loam-llm-end" && p.payload.id === "1")).toBe(true);
    expect(mocks.release).not.toHaveBeenCalled();

    // Operator deactivates (or deletes the active model): the next request resolves no active path.
    mocks.state = { downloaded: [], activeId: undefined };
    channel.emit("loam-llm-request", { id: "2", messages: [{ role: "user", content: "hi" }] });
    await flush();

    expect(mocks.release).toHaveBeenCalledTimes(1);
    const errored = channel.posts.find((p) => p.name === "loam-llm-error" && p.payload.id === "2");
    expect(String(errored?.payload.error)).toMatch(/No on-device model is selected/i);
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

    // A throwing release is swallowed; the caller still gets the graceful "no model" error.
    const errored = channel.posts.find((p) => p.name === "loam-llm-error" && p.payload.id === "2");
    expect(String(errored?.payload.error)).toMatch(/No on-device model is selected/i);
  });
});
