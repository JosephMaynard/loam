// P2-1 round 5: model-manager-bridge.ts must distinguish an ack-loss TIMEOUT (ambiguous — the launcher
// write may already have landed) from an explicit `ok:false` FAILURE (the write definitely didn't
// happen). Because the launcher writes are idempotent, a timeout is RETRIED a bounded number of times;
// a definite failure returns immediately without retrying.
import { describe, expect, it } from "vitest";

import type { BridgeChannel } from "@/lib/model-manager-bridge";
import { clearActiveModel, setActiveModel } from "@/lib/model-manager-bridge";

type Responder = (payload: Record<string, unknown>, emit: (result: unknown) => void) => void;

/** A fake nodejs-mobile channel. `responder` is called on every `post` with the posted payload and an
 * `emit` that dispatches a result to the registered `loam-model-set-active-result` listeners — so a
 * test can reply with a matching `requestId`, reply with a mismatch, or stay silent (drop the ack). */
function scriptedChannel(responder: Responder): { channel: BridgeChannel; posts: Record<string, unknown>[] } {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const posts: Record<string, unknown>[] = [];
  const channel: BridgeChannel = {
    addListener(name, handler) {
      if (!listeners.has(name)) {
        listeners.set(name, new Set());
      }
      listeners.get(name)!.add(handler);
    },
    removeListener(name, handler) {
      listeners.get(name)?.delete(handler);
    },
    post(name, payload) {
      const record = payload as Record<string, unknown>;
      posts.push(record);
      const emit = (result: unknown) => {
        for (const handler of listeners.get("loam-model-set-active-result") ?? []) {
          handler(result);
        }
      };
      responder(record, emit);
    },
  };
  return { channel, posts };
}

describe("bridge roundTrip — timeout vs explicit failure (P2-1)", () => {
  it("retries an ack-lost (dropped) response a bounded number of times, then reports timeout", async () => {
    // Never emit a result — every attempt times out.
    const { channel, posts } = scriptedChannel(() => {});

    const result = await setActiveModel(channel, { modelPath: "file:///m.gguf" }, 5, 3);

    expect(result.status).toBe("timeout");
    // The idempotent write was retried up to the bound — one post per attempt.
    expect(posts).toHaveLength(3);
  });

  it("returns an explicit ok:false failure immediately, without retrying", async () => {
    const { channel, posts } = scriptedChannel((payload, emit) => {
      emit({ requestId: payload.requestId, ok: false, error: "launcher refused" });
    });

    const result = await setActiveModel(channel, { modelPath: "file:///m.gguf" }, 5, 3);

    expect(result.status).toBe("failed");
    expect(result.error).toBe("launcher refused");
    // A definite failure is NOT ambiguous — no idempotent retry.
    expect(posts).toHaveLength(1);
  });

  it("returns ok on an explicit success", async () => {
    const { channel, posts } = scriptedChannel((payload, emit) => {
      emit({ requestId: payload.requestId, ok: true });
    });

    const result = await setActiveModel(channel, { modelPath: "file:///m.gguf" }, 5, 3);

    expect(result.status).toBe("ok");
    expect(posts).toHaveLength(1);
  });

  it("treats a synchronous post throw as a definite failure (message never sent), not a timeout", async () => {
    const channel: BridgeChannel = {
      addListener() {},
      removeListener() {},
      post() {
        throw new Error("channel closed");
      },
    };

    const result = await setActiveModel(channel, { modelPath: "file:///m.gguf" }, 5, 3);
    expect(result.status).toBe("failed");
    expect(result.error).toBe("channel closed");
  });

  it("ignores results with a mismatched requestId and still times out + retries", async () => {
    const { channel, posts } = scriptedChannel((_payload, emit) => {
      emit({ requestId: "some-other-request", ok: true });
    });

    const result = await setActiveModel(channel, { modelPath: "file:///m.gguf" }, 5, 2);
    expect(result.status).toBe("timeout");
    expect(posts).toHaveLength(2);
  });

  it("clearActiveModel shares the same timeout-retry semantics", async () => {
    const { channel, posts } = scriptedChannel(() => {});
    const result = await clearActiveModel(channel, 5, 3);
    expect(result.status).toBe("timeout");
    expect(posts).toHaveLength(3);
    expect(posts[0]).toMatchObject({ action: "clear" });
  });
});
