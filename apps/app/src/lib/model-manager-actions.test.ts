// P2-2 round 5 (with P2-1's rollback semantics): the activate/deactivate/delete transactions in
// model-manager-actions.ts. Verifies:
//   - the global mutex serializes whole transactions (B doesn't start until A fully settles);
//   - a stale rollback never clobbers a newer successful selection (conditional/versioned rollback);
//   - a bridge TIMEOUT is left in place (ambiguous, no rollback — P2-1), while an explicit FAILURE
//     rolls back cleanly;
//   - delete never deletes the file bytes unless the launcher clear is confirmed.
import { describe, expect, it, vi } from "vitest";

import type { ActiveModelResult, SetActiveModelRequest } from "@/lib/model-manager-bridge";
import {
  deactivateAction,
  deleteAction,
  performDeactivate,
  performDelete,
  performSetActive,
  setActiveAction,
  type ModelActionDeps,
} from "@/lib/model-manager-actions";
import type { DownloadedModel, ModelManagerState } from "@/lib/model-manager-store";

function model(id: string): DownloadedModel {
  return {
    id,
    displayName: `Model ${id}`,
    uri: `file:///models/${id}.gguf`,
    sizeBytes: 1024,
    isCustom: false,
    sourceUrl: `https://example.test/${id}.gguf`,
    downloadedAt: 123,
  };
}

const A = model("A");
const B = model("B");

/** An in-memory stand-in for the serialized store. Each `mutate` does an atomic read-modify-write
 * after a microtask, mirroring `mutateModelManagerState` closely enough for these tests. */
function makeStore(initial: ModelManagerState) {
  let state: ModelManagerState = initial;
  let failNext = false;
  return {
    get: () => state,
    failNextWrite: () => {
      failNext = true;
    },
    mutate: vi.fn(async (fn: (current: ModelManagerState) => ModelManagerState) => {
      await Promise.resolve();
      if (failNext) {
        failNext = false;
        return { state, persisted: false };
      }
      state = fn(state);
      return { state, persisted: true };
    }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

const OK: ActiveModelResult = { status: "ok" };

describe("performSetActive — P2-1 rollback semantics", () => {
  it("leaves activeId at the attempted model on a bridge TIMEOUT (ambiguous, no rollback)", async () => {
    const store = makeStore({ downloaded: [A, B], activeId: "B" });
    const deps: ModelActionDeps = {
      mutate: store.mutate,
      setActiveModel: async () => ({ status: "timeout", error: "no response" }),
      clearActiveModel: async () => OK,
      deleteModelFile: vi.fn(async () => {}),
    };

    const result = await performSetActive(deps, A);

    expect(result.kind).toBe("ambiguous");
    // NOT rolled back to "B" — the launcher write may already have landed (P2-1).
    expect(store.get().activeId).toBe("A");
  });

  it("rolls back cleanly to the previous model on an explicit FAILURE", async () => {
    const store = makeStore({ downloaded: [A, B], activeId: "B" });
    const deps: ModelActionDeps = {
      mutate: store.mutate,
      setActiveModel: async () => ({ status: "failed", error: "boom" }),
      clearActiveModel: async () => OK,
      deleteModelFile: vi.fn(async () => {}),
    };

    const result = await performSetActive(deps, A);

    expect(result.kind).toBe("rolled-back");
    expect(store.get().activeId).toBe("B");
  });

  it("reports persist-failed and does not touch the bridge when the durable write fails", async () => {
    const store = makeStore({ downloaded: [A, B], activeId: "B" });
    store.failNextWrite();
    const setActive = vi.fn(async () => OK);
    const deps: ModelActionDeps = {
      mutate: store.mutate,
      setActiveModel: setActive,
      clearActiveModel: async () => OK,
      deleteModelFile: vi.fn(async () => {}),
    };

    const result = await performSetActive(deps, A);

    expect(result.kind).toBe("persist-failed");
    expect(setActive).not.toHaveBeenCalled();
    expect(store.get().activeId).toBe("B");
  });
});

describe("conditional rollback — a stale rollback never clobbers a newer selection (P2-2)", () => {
  it("A-persist → B-persist(ok) → A-failure keeps B's selection", async () => {
    const store = makeStore({ downloaded: [A, B], activeId: undefined });
    const aBridge = deferred<ActiveModelResult>();
    const deps: ModelActionDeps = {
      mutate: store.mutate,
      setActiveModel: (request: SetActiveModelRequest) =>
        request.modelPath === A.uri ? aBridge.promise : Promise.resolve(OK),
      clearActiveModel: async () => OK,
      deleteModelFile: vi.fn(async () => {}),
    };

    // Start A (mutex-free perform*), let it persist activeId=A and block on its pending bridge.
    const pA = performSetActive(deps, A);
    await tick();
    expect(store.get().activeId).toBe("A");

    // B runs to completion and wins.
    const rB = await performSetActive(deps, B);
    expect(rB.kind).toBe("ok");
    expect(store.get().activeId).toBe("B");

    // A now fails — its rollback must be a no-op because activeId no longer equals "A".
    aBridge.resolve({ status: "failed", error: "late failure" });
    const rA = await pA;
    expect(rA.kind).toBe("rolled-back");
    expect(store.get().activeId).toBe("B"); // NOT clobbered back to undefined
  });

  it("activate racing deactivate: a completed deactivate is not clobbered by the failed activate's rollback", async () => {
    const store = makeStore({ downloaded: [A, B], activeId: "B" });
    const aBridge = deferred<ActiveModelResult>();
    const deps: ModelActionDeps = {
      mutate: store.mutate,
      setActiveModel: (request: SetActiveModelRequest) =>
        request.modelPath === A.uri ? aBridge.promise : Promise.resolve(OK),
      clearActiveModel: async () => OK,
      deleteModelFile: vi.fn(async () => {}),
    };

    const pA = performSetActive(deps, A); // previous = "B"
    await tick();
    expect(store.get().activeId).toBe("A");

    await performDeactivate(deps); // clears activeId
    expect(store.get().activeId).toBeUndefined();

    aBridge.resolve({ status: "failed", error: "x" });
    await pA;
    // Without the conditional guard this would restore activeId back to "B", clobbering the deactivate.
    expect(store.get().activeId).toBeUndefined();
  });
});

describe("global operation mutex serializes whole transactions (P2-2)", () => {
  it("B does not start until A's entire transaction (including rollback) has settled", async () => {
    const store = makeStore({ downloaded: [A, B], activeId: undefined });
    const aBridge = deferred<ActiveModelResult>();
    let bBridgeCalled = false;
    const deps: ModelActionDeps = {
      mutate: store.mutate,
      setActiveModel: (request: SetActiveModelRequest) => {
        if (request.modelPath === A.uri) {
          return aBridge.promise;
        }
        bBridgeCalled = true;
        return Promise.resolve(OK);
      },
      clearActiveModel: async () => OK,
      deleteModelFile: vi.fn(async () => {}),
    };

    const pA = setActiveAction(deps, A);
    const pB = setActiveAction(deps, B);

    await tick();
    // A is blocked on its bridge; the mutex must be holding B entirely — it hasn't persisted OR
    // reached its bridge.
    expect(bBridgeCalled).toBe(false);
    expect(store.get().activeId).toBe("A");

    aBridge.resolve({ status: "failed", error: "x" });
    await pA;
    await pB;

    expect(bBridgeCalled).toBe(true);
    // A rolled back to undefined, then B set active — final, consistent, uncorrupted.
    expect(store.get().activeId).toBe("B");
  });
});

describe("performDelete — safe sequencing (P2-2 / P2-1)", () => {
  it("deletes the file bytes when the model was not active (no bridge clear needed)", async () => {
    const store = makeStore({ downloaded: [A, B], activeId: "B" });
    const deleteFile = vi.fn(async () => {});
    const clear = vi.fn(async () => OK);
    const deps: ModelActionDeps = {
      mutate: store.mutate,
      setActiveModel: async () => OK,
      clearActiveModel: clear,
      deleteModelFile: deleteFile,
    };

    const result = await performDelete(deps, A);

    expect(result.kind).toBe("ok");
    expect(clear).not.toHaveBeenCalled();
    expect(deleteFile).toHaveBeenCalledWith(A.uri);
    expect(store.get().downloaded.map((m) => m.id)).toEqual(["B"]);
  });

  it("on an explicit clear FAILURE: rolls the metadata back and does NOT delete the bytes", async () => {
    const store = makeStore({ downloaded: [A, B], activeId: "A" });
    const deleteFile = vi.fn(async () => {});
    const deps: ModelActionDeps = {
      mutate: store.mutate,
      setActiveModel: async () => OK,
      clearActiveModel: async () => ({ status: "failed", error: "clear refused" }),
      deleteModelFile: deleteFile,
    };

    const result = await performDelete(deps, A);

    expect(result.kind).toBe("rolled-back");
    expect(deleteFile).not.toHaveBeenCalled();
    // Model re-added, still active.
    expect(store.get().downloaded.map((m) => m.id).sort()).toEqual(["A", "B"]);
    expect(store.get().activeId).toBe("A");
  });

  it("on a clear TIMEOUT: ambiguous — does NOT delete the bytes and does NOT roll back (P2-1)", async () => {
    const store = makeStore({ downloaded: [A, B], activeId: "A" });
    const deleteFile = vi.fn(async () => {});
    const deps: ModelActionDeps = {
      mutate: store.mutate,
      setActiveModel: async () => OK,
      clearActiveModel: async () => ({ status: "timeout", error: "no response" }),
      deleteModelFile: deleteFile,
    };

    const result = await performDelete(deps, A);

    expect(result.kind).toBe("ambiguous");
    expect(deleteFile).not.toHaveBeenCalled();
    // Metadata stays removed (not rolled back) — the leftover file is reclaimed by the orphan sweep.
    expect(store.get().downloaded.map((m) => m.id)).toEqual(["B"]);
    expect(store.get().activeId).toBeUndefined();
  });

  it("deactivateAction and deleteAction are serialized against each other by the mutex", async () => {
    const store = makeStore({ downloaded: [A, B], activeId: "A" });
    const clearGate = deferred<ActiveModelResult>();
    let deleteFileCalled = false;
    const deps: ModelActionDeps = {
      mutate: store.mutate,
      setActiveModel: async () => OK,
      // First clear (from deactivate) blocks on the gate; deleteAction below must wait behind it.
      clearActiveModel: () => clearGate.promise,
      deleteModelFile: async () => {
        deleteFileCalled = true;
      },
    };

    const pDeactivate = deactivateAction(deps);
    const pDelete = deleteAction(deps, B); // B is inactive → would delete its file immediately if not gated

    await tick();
    // Deactivate holds the mutex (blocked on the clear gate); delete of B hasn't run yet.
    expect(deleteFileCalled).toBe(false);

    clearGate.resolve(OK);
    await pDeactivate;
    await pDelete;
    expect(deleteFileCalled).toBe(true);
  });
});
