// P2-2 round 5 (with P2-1's rollback semantics): the activate/deactivate/delete transactions in
// model-manager-actions.ts. Verifies:
//   - the global mutex serializes whole transactions (B doesn't start until A fully settles);
//   - a stale rollback never clobbers a newer successful selection (conditional/versioned rollback);
//   - a bridge TIMEOUT is left in place (ambiguous, no rollback — P2-1), while an explicit FAILURE
//     rolls back cleanly;
//   - delete never deletes the file bytes unless the launcher clear is confirmed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fileSystemMock, resetFileSystemMock, seedFile } from "@/test-utils/mocks";

// The actions module now imports a value (`POINTER_PENDING_ID`/`recordPending`) from the store module,
// which imports `expo-file-system/legacy` (→ react-native) at module load. These tests drive an
// in-memory store double, never the real persistence, so the fake just keeps the real native module
// (and its Flow-typed react-native transitive) from being loaded under Vitest's node environment.
vi.mock("expo-file-system/legacy", () => fileSystemMock);

import type { ActiveModelResult, SetActiveModelRequest } from "@/lib/model-manager-bridge";
import {
  deactivateAction,
  deleteAction,
  performDeactivate,
  performDelete,
  performSetActive,
  reconcilePendingActions,
  setActiveAction,
  type ModelActionDeps,
} from "@/lib/model-manager-actions";
import {
  loadModelManagerState,
  MODEL_LIST_UNREADABLE_MESSAGE,
  mutateModelManagerState,
  POINTER_PENDING_ID,
} from "@/lib/model-manager-store";
import type { DownloadedModel, ModelManagerState, PendingAction } from "@/lib/model-manager-store";

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
 * after a microtask, mirroring `mutateModelManagerState` EXACTLY on the save-failure return contract
 * (P2-1 round 8): on a failed write it returns the DISK-CONFIRMED (unchanged) state with
 * `persisted:false` — NOT the attempted `next`. Production returns `current` (the pre-mutation on-disk
 * state) on a failed save for the same reason; the `real-store integration` block below pins that the
 * REAL `mutateModelManagerState` honours the identical contract, so this fake is faithful and not just
 * asserted to be. `failWriteAt(n)` fails the n-th mutate (1-based) so a test can fail a SECOND write
 * mid-transaction (e.g. a clear-pending after a durable write-ahead), which `failNextWrite` (fails the
 * very next one) can't target. */
function makeStore(initial: ModelManagerState) {
  let state: ModelManagerState = initial;
  let failNext = false;
  let writeNo = 0;
  const failAt = new Set<number>();
  return {
    get: () => state,
    failNextWrite: () => {
      failNext = true;
    },
    failWriteAt: (n: number) => {
      failAt.add(n);
    },
    mutate: vi.fn(async (fn: (current: ModelManagerState) => ModelManagerState) => {
      await Promise.resolve();
      writeNo += 1;
      if (failNext || failAt.has(writeNo)) {
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
      reconcileActiveModel: vi.fn(() => {}),
      invalidateStaleLoad: vi.fn(() => {}),
      confirmActiveModelReleased: vi.fn(async () => 'released' as const),
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
      reconcileActiveModel: vi.fn(() => {}),
      invalidateStaleLoad: vi.fn(() => {}),
      confirmActiveModelReleased: vi.fn(async () => 'released' as const),
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
      reconcileActiveModel: vi.fn(() => {}),
      invalidateStaleLoad: vi.fn(() => {}),
      confirmActiveModelReleased: vi.fn(async () => 'released' as const),
    };

    const result = await performSetActive(deps, A);

    expect(result.kind).toBe("persist-failed");
    expect(setActive).not.toHaveBeenCalled();
    expect(store.get().activeId).toBe("B");
  });

  it("notifies the engine of the new active model on a successful switch (Sol Fable-round-5 P2)", async () => {
    const store = makeStore({ downloaded: [A, B], activeId: "A" });
    const invalidateStaleLoad = vi.fn(() => {});
    const reconcileActiveModel = vi.fn(() => {});
    const deps: ModelActionDeps = {
      mutate: store.mutate,
      setActiveModel: async () => OK,
      clearActiveModel: async () => OK,
      deleteModelFile: vi.fn(async () => {}),
      reconcileActiveModel,
      invalidateStaleLoad,
      confirmActiveModelReleased: vi.fn(async () => "released" as const),
    };

    const result = await performSetActive(deps, B);

    expect(result.kind).toBe("ok");
    // At PERSIST (before the bridge) the stale old-model load is invalidated, keeping the newly-selected B;
    // AFTER the ok bridge confirms, the engine is reconciled to the DURABLE active model B (target-aware;
    // disposes a stale A load, leaves B alone).
    expect(invalidateStaleLoad.mock.calls.map((c) => c[0])).toEqual([B.uri]);
    expect(reconcileActiveModel.mock.calls.map((c) => c[0])).toEqual([B.uri]);
  });

  it("on a definite bridge FAILURE, invalidates the stale load for B (switch) THEN reconciles to the restored A (rollback) (Sol P2)", async () => {
    // B must be invalidated when local state rolls back to A: a concurrent inference could have started
    // loading B while the bridge was pending, and it must never complete after the rollback.
    const store = makeStore({ downloaded: [A, B], activeId: "A" });
    const invalidateStaleLoad = vi.fn(() => {});
    const reconcileActiveModel = vi.fn(() => {});
    const deps: ModelActionDeps = {
      mutate: store.mutate,
      setActiveModel: async () => ({ status: "failed", error: "boom" }),
      clearActiveModel: async () => OK,
      deleteModelFile: vi.fn(async () => {}),
      reconcileActiveModel,
      invalidateStaleLoad,
      confirmActiveModelReleased: vi.fn(async () => "released" as const),
    };

    const result = await performSetActive(deps, B);

    expect(result.kind).toBe("rolled-back");
    expect(store.get().activeId).toBe("A"); // reverted
    // Persist-time invalidate targets the newly-selected B (without releasing the loaded context). After the
    // definite failure rolls the selection back, the post-outcome reconcile targets the DURABLE restored
    // model A — abandoning any in-flight B load, since A is now the target.
    expect(invalidateStaleLoad.mock.calls.map((c) => c[0])).toEqual([B.uri]);
    expect(reconcileActiveModel.mock.calls.map((c) => c[0])).toEqual([A.uri]);
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
      reconcileActiveModel: vi.fn(() => {}),
      invalidateStaleLoad: vi.fn(() => {}),
      confirmActiveModelReleased: vi.fn(async () => 'released' as const),
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
      reconcileActiveModel: vi.fn(() => {}),
      invalidateStaleLoad: vi.fn(() => {}),
      confirmActiveModelReleased: vi.fn(async () => 'released' as const),
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
      reconcileActiveModel: vi.fn(() => {}),
      invalidateStaleLoad: vi.fn(() => {}),
      confirmActiveModelReleased: vi.fn(async () => 'released' as const),
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
      reconcileActiveModel: vi.fn(() => {}),
      invalidateStaleLoad: vi.fn(() => {}),
      confirmActiveModelReleased: vi.fn(async () => 'released' as const),
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
      reconcileActiveModel: vi.fn(() => {}),
      invalidateStaleLoad: vi.fn(() => {}),
      confirmActiveModelReleased: vi.fn(async () => 'released' as const),
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
      reconcileActiveModel: vi.fn(() => {}),
      invalidateStaleLoad: vi.fn(() => {}),
      confirmActiveModelReleased: vi.fn(async () => 'released' as const),
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
      reconcileActiveModel: vi.fn(() => {}),
      invalidateStaleLoad: vi.fn(() => {}),
      confirmActiveModelReleased: vi.fn(async () => 'released' as const),
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

// ---------------------------------------------------------------------------
// Finding 1: the byte deletion is CHECKED — a delete that throws (leaves the GGUF on disk) must NOT be
// reported "deleted"; the durable delete-pending is kept so reconciliation retries the idempotent delete.
// Covers BOTH an active-model delete (needs a launcher clear first) and an inactive-model delete (no
// clear), and the reconciliation retry closing each out.
// ---------------------------------------------------------------------------

describe("checked byte deletion — a failed delete is not reported done and is retryable (Finding 1)", () => {
  it("ACTIVE model: byte delete FAILS after a confirmed clear → ambiguous, pending kept, then reconciliation deletes it", async () => {
    const store = makeStore({ downloaded: [A, B], activeId: "A" });
    const deleteFile = vi.fn(async () => {
      throw new Error("unlink failed — read-only mount");
    });
    const clear = vi.fn(async () => OK);
    const deps = scriptedDeps(store, { clearActiveModel: clear, deleteModelFile: deleteFile });

    const result = await performDelete(deps, A);

    // NOT reported deleted — the file may still be on disk.
    expect(result.kind).toBe("ambiguous");
    expect(clear).toHaveBeenCalledTimes(1);
    expect(deleteFile).toHaveBeenCalledWith(A.uri);
    // Metadata removed, but the durable delete-pending is KEPT for a retry (and keeps the file protected).
    expect(store.get().downloaded.map((m) => m.id)).toEqual(["B"]);
    expect((store.get().pending ?? []).map((p) => p.id)).toEqual([`delete:${A.uri}`]);
    // The state the component adopts still carries the pending → controls stay blocked.
    expect((result.state?.pending ?? []).map((p) => p.id)).toEqual([`delete:${A.uri}`]);

    // Reconciliation retries: the launcher clear is re-sent (activeId is undefined) and the byte delete
    // now succeeds → settled, pending gone.
    deleteFile.mockResolvedValue(undefined);
    const reconciled = await reconcilePendingActions(deps);

    expect(reconciled.settled).toBe(true);
    expect(deleteFile).toHaveBeenCalledTimes(2);
    expect(store.get().pending ?? []).toEqual([]);
  });

  it("INACTIVE model: byte delete FAILS → ambiguous, NO launcher clear, pending kept, reconciliation never clears the live model", async () => {
    const store = makeStore({ downloaded: [A, B], activeId: "B" });
    const deleteFile = vi.fn(async () => {
      throw new Error("unlink failed");
    });
    const clear = vi.fn(async () => OK);
    const deps = scriptedDeps(store, { clearActiveModel: clear, deleteModelFile: deleteFile });

    const result = await performDelete(deps, A); // A is inactive (B is active)

    expect(result.kind).toBe("ambiguous");
    expect(clear).not.toHaveBeenCalled(); // inactive delete never touches the launcher pointer
    expect(deleteFile).toHaveBeenCalledWith(A.uri);
    expect(store.get().activeId).toBe("B"); // live model untouched
    expect(store.get().downloaded.map((m) => m.id)).toEqual(["B"]);
    expect((store.get().pending ?? []).map((p) => p.id)).toEqual([`delete:${A.uri}`]);

    // Reconciliation retries the byte delete WITHOUT clearing the launcher (B is still active) — the fix
    // that stops an inactive-origin delete-pending from wrongly disabling the live model.
    deleteFile.mockResolvedValue(undefined);
    const reconciled = await reconcilePendingActions(deps);

    expect(reconciled.settled).toBe(true);
    expect(clear).not.toHaveBeenCalled();
    expect(store.get().activeId).toBe("B");
    expect(store.get().pending ?? []).toEqual([]);
  });

  it("does not report an inactive delete as 'ok' when the byte delete throws (regression: silent-swallow made this always ok)", async () => {
    const store = makeStore({ downloaded: [A, B], activeId: "B" });
    const deps = scriptedDeps(store, {
      deleteModelFile: async () => {
        throw new Error("boom");
      },
    });

    const result = await performDelete(deps, A);

    expect(result.kind).not.toBe("ok");
    expect(result.kind).toBe("ambiguous");
  });
});

// ---------------------------------------------------------------------------
// P2-b: durable pending actions are recorded on ambiguity and reconciled later.
// ---------------------------------------------------------------------------

const TIMEOUT: ActiveModelResult = { status: "timeout", error: "no response" };
const FAILED: ActiveModelResult = { status: "failed", error: "boom" };

/** deps whose bridge fns return whatever the scripted queues hand back (defaulting to the last value). */
function scriptedDeps(
  store: ReturnType<typeof makeStore>,
  overrides: Partial<ModelActionDeps> = {},
): ModelActionDeps {
  return {
    mutate: store.mutate,
    setActiveModel: async () => OK,
    clearActiveModel: async () => OK,
    deleteModelFile: vi.fn(async () => {}),
    reconcileActiveModel: vi.fn(() => {}),
    invalidateStaleLoad: vi.fn(() => {}),
    confirmActiveModelReleased: vi.fn(async () => 'released' as const),
    ...overrides,
  };
}

describe("recording pending on ambiguity (P2-b)", () => {
  it("performSetActive TIMEOUT records a durable setActive pending (state stays ahead, to be reconciled)", async () => {
    const store = makeStore({ downloaded: [A, B], activeId: "B" });
    const deps = scriptedDeps(store, { setActiveModel: async () => TIMEOUT });

    const result = await performSetActive(deps, A);

    expect(result.kind).toBe("ambiguous");
    expect(store.get().activeId).toBe("A");
    const pending = store.get().pending ?? [];
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id: POINTER_PENDING_ID,
      kind: "setActive",
      desired: { enabled: true, modelPath: A.uri, model: A.displayName },
    });
  });

  it("performDeactivate TIMEOUT records a durable clear pending", async () => {
    const store = makeStore({ downloaded: [A, B], activeId: "A" });
    const deps = scriptedDeps(store, { clearActiveModel: async () => TIMEOUT });

    const result = await performDeactivate(deps);

    expect(result.kind).toBe("ambiguous");
    expect((store.get().pending ?? [])[0]).toMatchObject({ id: POINTER_PENDING_ID, kind: "clear" });
  });

  it("performDelete active-model TIMEOUT records a delete pending with fileUri and does NOT delete bytes", async () => {
    const store = makeStore({ downloaded: [A, B], activeId: "A" });
    const deleteFile = vi.fn(async () => {});
    const deps = scriptedDeps(store, { clearActiveModel: async () => TIMEOUT, deleteModelFile: deleteFile });

    const result = await performDelete(deps, A);

    expect(result.kind).toBe("ambiguous");
    expect(deleteFile).not.toHaveBeenCalled();
    expect(store.get().downloaded.map((m) => m.id)).toEqual(["B"]);
    expect(store.get().pending ?? []).toEqual([
      // Active delete → requiresLauncherClear:true (the launcher pointer must be cleared before byte delete).
      { id: `delete:${A.uri}`, kind: "delete", desired: { enabled: false }, fileUri: A.uri, requiresLauncherClear: true },
    ]);
  });
});

describe("reconcilePendingActions — RESTART-level: all attempts timed out, nothing applied (P2-b)", () => {
  it("re-sends a pending delete; while still timing out keeps the pending entry and NEVER deletes the bytes", async () => {
    // Simulates a next-process load where a prior session's active-delete timed out on every retry: the
    // GGUF is still on disk, metadata removed, and a durable delete pending recorded.
    const pending: PendingAction = { id: `delete:${A.uri}`, kind: "delete", desired: { enabled: false }, fileUri: A.uri };
    const store = makeStore({ downloaded: [B], activeId: undefined, pending: [pending] });
    const deleteFile = vi.fn(async () => {});
    const clear = vi.fn(async () => TIMEOUT);
    const deps = scriptedDeps(store, { clearActiveModel: clear, deleteModelFile: deleteFile });

    const first = await reconcilePendingActions(deps);

    expect(clear).toHaveBeenCalledTimes(1); // it RE-SENT the idempotent clear
    expect(first.settled).toBe(false); // still ambiguous
    expect(deleteFile).not.toHaveBeenCalled(); // bytes preserved — launcher may still reference the file
    expect(store.get().pending).toEqual([pending]); // pending kept for the next pass

    // A subsequent pass where the launcher finally confirms the clear: pending clears AND the bytes are
    // now (and only now) deleted.
    clear.mockResolvedValue(OK);
    const second = await reconcilePendingActions(deps);

    expect(second.settled).toBe(true);
    expect(deleteFile).toHaveBeenCalledWith(A.uri);
    expect(store.get().pending ?? []).toEqual([]);
  });

  it("a settled reconcile of a setActive pending confirms and clears it", async () => {
    const pending: PendingAction = {
      id: POINTER_PENDING_ID,
      kind: "setActive",
      desired: { enabled: true, modelPath: A.uri, model: A.displayName },
    };
    const store = makeStore({ downloaded: [A, B], activeId: "A", pending: [pending] });
    const setActive = vi.fn(async () => OK);
    const deps = scriptedDeps(store, { setActiveModel: setActive });

    const result = await reconcilePendingActions(deps);

    expect(setActive).toHaveBeenCalledWith({ modelPath: A.uri, model: A.displayName });
    expect(result.settled).toBe(true);
    expect(store.get().activeId).toBe("A");
    expect(store.get().pending ?? []).toEqual([]);
  });

  it("a DEFINITE failure of a setActive pending clears activeId (still ours) and drops the pending", async () => {
    const pending: PendingAction = {
      id: POINTER_PENDING_ID,
      kind: "setActive",
      desired: { enabled: true, modelPath: A.uri, model: A.displayName },
    };
    const store = makeStore({ downloaded: [A, B], activeId: "A", pending: [pending] });
    const reconcileActiveModel = vi.fn(() => {});
    const deps = scriptedDeps(store, { setActiveModel: async () => FAILED, reconcileActiveModel });

    const result = await reconcilePendingActions(deps);

    expect(result.settled).toBe(true);
    expect(store.get().activeId).toBeUndefined(); // launcher didn't apply it — stop claiming it locally
    expect(store.get().pending ?? []).toEqual([]);
    // Sol round-6 P2#1: clearing activeId must ALSO sync the engine to the resulting DURABLE target (here
    // nothing active → null), so A's abandoned load/loaded context can't still publish and run.
    expect(reconcileActiveModel).toHaveBeenCalledWith(null);
  });

  it("no pending → settles immediately without touching the bridge", async () => {
    const store = makeStore({ downloaded: [A], activeId: "A" });
    const setActive = vi.fn(async () => OK);
    const clear = vi.fn(async () => OK);
    const deps = scriptedDeps(store, { setActiveModel: setActive, clearActiveModel: clear });

    const result = await reconcilePendingActions(deps);

    expect(result.settled).toBe(true);
    expect(setActive).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// P2-1: the pending-action journal is only ever reported durable/settled when CONFIRMED on disk.
// ---------------------------------------------------------------------------

describe("write-ahead intent is atomic and durable (P2-1)", () => {
  it("performSetActive records the pending in the SAME write as activeId, BEFORE the bridge call", async () => {
    const store = makeStore({ downloaded: [A, B], activeId: "B" });
    // Bridge blocks so we can observe the on-disk state after the write-ahead but before confirmation.
    const gate = deferred<ActiveModelResult>();
    let bridgeCalled = false;
    const deps = scriptedDeps(store, {
      setActiveModel: () => {
        bridgeCalled = true;
        return gate.promise;
      },
    });

    const p = performSetActive(deps, A);
    await tick();

    // The write-ahead landed FIRST: activeId set AND a durable setActive pending, before any bridge ack.
    expect(bridgeCalled).toBe(true);
    expect(store.get().activeId).toBe("A");
    expect(store.get().pending).toEqual([
      { id: POINTER_PENDING_ID, kind: "setActive", desired: { enabled: true, modelPath: A.uri, model: A.displayName } },
    ]);
    // Only ONE atomic write so far (the write-ahead); the pending was NOT a separate second write.
    expect(store.mutate).toHaveBeenCalledTimes(1);

    gate.resolve(OK);
    await p;
  });

  it("failure to persist the write-ahead → persist-failed, no pending, bridge untouched (nothing reported durable)", async () => {
    const store = makeStore({ downloaded: [A, B], activeId: "B" });
    store.failNextWrite();
    const setActive = vi.fn(async () => OK);
    const deps = scriptedDeps(store, { setActiveModel: setActive });

    const result = await performSetActive(deps, A);

    expect(result.kind).toBe("persist-failed");
    expect(setActive).not.toHaveBeenCalled();
    // No durable pending was left behind, and the selection didn't move — a failed record is NOT durable.
    expect(store.get().activeId).toBe("B");
    expect(store.get().pending ?? []).toEqual([]);
  });

  it("bridge OK but the pending-CLEAR write fails → reported AMBIGUOUS (not ok) and the pending survives", async () => {
    const store = makeStore({ downloaded: [A, B], activeId: "B" });
    // Write 1 = the write-ahead (must land); write 2 = clearPendingEntry after the ok bridge (must FAIL).
    store.failWriteAt(2);
    const deps = scriptedDeps(store, { setActiveModel: async () => OK });

    const result = await performSetActive(deps, A);

    // Not reported as a clean `ok` — the clear didn't land, so the pending is still on disk.
    expect(result.kind).toBe("ambiguous");
    expect(store.get().activeId).toBe("A");
    expect((store.get().pending ?? []).map((p) => p.id)).toEqual([POINTER_PENDING_ID]);
    // The action must hand the component the DISK-CONFIRMED state (pending STILL present), not an
    // attempted state with the pending dropped (P2-1 round 8) — this `state.pending` is exactly what the
    // component derives `pendingUnsettled` from, so a non-empty pending keeps the controls blocked.
    expect((result.state?.pending ?? []).map((p) => p.id)).toEqual([POINTER_PENDING_ID]);
  });

  it("performDelete PRESERVES an unrelated pending array (P2-1: the old reconstruction dropped it)", async () => {
    const unrelated: PendingAction = {
      id: POINTER_PENDING_ID,
      kind: "setActive",
      desired: { enabled: true, modelPath: B.uri, model: B.displayName },
    };
    const store = makeStore({ downloaded: [A, B], activeId: "B", pending: [unrelated] });
    const deleteFile = vi.fn(async () => {});
    const deps = scriptedDeps(store, { deleteModelFile: deleteFile });

    // Delete A, which is INACTIVE (activeId is B) — no launcher clear, immediate byte delete.
    const result = await performDelete(deps, A);

    expect(result.kind).toBe("ok");
    expect(deleteFile).toHaveBeenCalledWith(A.uri);
    expect(store.get().downloaded.map((m) => m.id)).toEqual(["B"]);
    // The unrelated pointer pending must still be there — it was previously wiped by the bare
    // `{ downloaded, activeId }` reconstruction.
    expect(store.get().pending).toEqual([unrelated]);
  });

  it("definite setActive FAILURE drops the write-ahead pending as it rolls back (no stale replay)", async () => {
    const store = makeStore({ downloaded: [A, B], activeId: "B" });
    const deps = scriptedDeps(store, { setActiveModel: async () => FAILED });

    const result = await performSetActive(deps, A);

    expect(result.kind).toBe("rolled-back");
    expect(store.get().activeId).toBe("B"); // reverted
    // The write-ahead pending must be gone — a definitively-failed action must not leave a pending that
    // replays after restart.
    expect(store.get().pending ?? []).toEqual([]);
  });
});

describe("reconcile only reports settled from CONFIRMED-on-disk state (P2-1)", () => {
  it("byte deletion succeeds but the pending-CLEAR write fails → not settled, pending kept, retried next pass (Finding 1)", async () => {
    const pending: PendingAction = { id: `delete:${A.uri}`, kind: "delete", desired: { enabled: false }, fileUri: A.uri };
    const store = makeStore({ downloaded: [B], activeId: undefined, pending: [pending] });
    // The reconcile's identity read is write #1; the clear-pending after the checked byte delete is write
    // #2 — fail it.
    store.failWriteAt(2);
    const deleteFile = vi.fn(async () => {});
    const deps = scriptedDeps(store, { clearActiveModel: async () => OK, deleteModelFile: deleteFile });

    const result = await reconcilePendingActions(deps);

    // New order (Finding 1): confirm clear → delete bytes (CHECKED) → clear pending. The launcher
    // confirmed the clear and the (idempotent, safe-to-repeat) byte delete ran, but the journal drop
    // didn't land — so we must NOT report settled: the on-disk pending survives and the next pass repeats
    // the now-no-op checked delete and clears it.
    expect(result.settled).toBe(false);
    expect(deleteFile).toHaveBeenCalledWith(A.uri);
    expect(store.get().pending).toEqual([pending]);
  });

  it("a newer setActive supersedes a stale pending so reconcile never REPLAYS the stale one (restart-safe)", async () => {
    // Simulates a next-process load carrying a stale setActive-A pending from a prior session.
    const stale: PendingAction = {
      id: POINTER_PENDING_ID,
      kind: "setActive",
      desired: { enabled: true, modelPath: A.uri, model: A.displayName },
    };
    const store = makeStore({ downloaded: [A, B], activeId: "A", pending: [stale] });
    const setActive = vi.fn(async () => OK);
    const deps = scriptedDeps(store, { setActiveModel: setActive });

    // The operator picks B before reconciliation runs: the write-ahead supersedes the stale A pending.
    const setB = await performSetActive(deps, B);
    expect(setB.kind).toBe("ok");
    expect(store.get().activeId).toBe("B");

    setActive.mockClear();
    const reconciled = await reconcilePendingActions(deps);

    // Reconcile finds nothing left (B's pending was cleared on its ok) and NEVER re-sends the stale A.
    expect(reconciled.settled).toBe(true);
    expect(setActive).not.toHaveBeenCalledWith({ modelPath: A.uri, model: A.displayName });
    expect(store.get().pending ?? []).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// RF7-b (Sol round 7): reconcile must NOT report a settled/empty state when its OWN state read refuses —
// that untrusted EMPTY_STATE would make the component sweep every downloaded model away.
// ---------------------------------------------------------------------------

describe("reconcile refuses to settle (or let the caller sweep) when its state read is UNREADABLE (RF7-b)", () => {
  it("identity-read refusal → unreadable + NOT settled; the bridge and file delete are NEVER touched", async () => {
    // A delete pending: were reconcile NOT to bail on the unreadable read, it would re-send the launcher
    // clear and (on ok) delete the bytes. The refusal must stop BOTH — and must not report settled, so the
    // component blocks controls and skips the orphan sweep (which, against the untrusted EMPTY_STATE this
    // refusal would otherwise yield, deletes every downloaded `.gguf`).
    const pending: PendingAction = { id: `delete:${A.uri}`, kind: "delete", desired: { enabled: false }, fileUri: A.uri };
    const store = makeStore({ downloaded: [B], activeId: undefined, pending: [pending] });
    // Fail the reconcile's FIRST write — its identity read `mutate(current => current)`, mirroring
    // `mutateModelManagerState` refusing (returning `persisted:false`) when `readModelManagerState()` errors.
    store.failNextWrite();
    const clear = vi.fn(async () => OK);
    const deleteFile = vi.fn(async () => {});
    const deps = scriptedDeps(store, { clearActiveModel: clear, deleteModelFile: deleteFile });

    const result = await reconcilePendingActions(deps);

    expect(result.unreadable).toBe(true);
    expect(result.settled).toBe(false);
    expect(result.message).toBe(MODEL_LIST_UNREADABLE_MESSAGE);
    // Bailed BEFORE the bridge/file — the "delete every model" vector is closed.
    expect(clear).not.toHaveBeenCalled();
    expect(deleteFile).not.toHaveBeenCalled();
    // The on-disk pending is left intact for a later, readable reconcile to settle.
    expect(store.get().pending).toEqual([pending]);
  });

  it("a READABLE reconcile is unaffected — no `unreadable` flag, still settles normally", async () => {
    // Guards against the RF7-b check misfiring on the healthy path (a successful identity read).
    const store = makeStore({ downloaded: [A], activeId: "A" });
    const result = await reconcilePendingActions(scriptedDeps(store));

    expect(result.unreadable).toBeUndefined();
    expect(result.settled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Finding 1: native-context convergence is driven from the ACTION layer (injected `reconcileActiveModel`
// for the deactivate/clear paths, `confirmActiveModelReleased` for the delete BARRIER), so it fires on
// EVERY confirmed launcher outcome — including the ambiguous outcomes and reconciliation — and, for a
// delete, BEFORE the bytes are unlinked. These use engine spies (+ a call-order log) layered on `scriptedDeps`.
// ---------------------------------------------------------------------------

describe("native-context convergence is driven from the action layer (Finding 1)", () => {
  it("deactivate: a confirmed clear whose pending-journal clear then FAILS still reconciles to null exactly once", async () => {
    const store = makeStore({ downloaded: [A], activeId: "A" });
    // Write 1 = the write-ahead (clear activeId + pending); write 2 = clearPendingEntry after the ok bridge → FAIL.
    store.failWriteAt(2);
    const reconcileActiveModel = vi.fn(() => {});
    const deps = scriptedDeps(store, { clearActiveModel: async () => OK, reconcileActiveModel });

    const result = await performDeactivate(deps);

    // Ambiguous (the pending-clear didn't land) — but the engine was reconciled to null, once, on the confirmed clear.
    expect(result.kind).toBe("ambiguous");
    expect(reconcileActiveModel).toHaveBeenCalledTimes(1);
    expect(reconcileActiveModel).toHaveBeenCalledWith(null);
  });

  it("deactivate that TIMED OUT then is CONFIRMED by reconciliation reconciles the engine to null on each pass", async () => {
    const store = makeStore({ downloaded: [A], activeId: "A" });
    const reconcileActiveModel = vi.fn(() => {});

    // Direct deactivate times out → the durable truth is already "no active model", so the engine is
    // reconciled to null even while the launcher ack is unconfirmed (the synchronous target-sync fires on
    // the ambiguous outcome too), and a durable `clear` pending is recorded.
    const first = await performDeactivate(scriptedDeps(store, { clearActiveModel: async () => TIMEOUT, reconcileActiveModel }));
    expect(first.kind).toBe("ambiguous");
    expect(reconcileActiveModel).toHaveBeenCalledTimes(1);
    expect(reconcileActiveModel).toHaveBeenCalledWith(null);
    expect((store.get().pending ?? []).map((p) => p.kind)).toEqual(["clear"]);
    reconcileActiveModel.mockClear();

    // Reconciliation re-sends the clear, which now confirms → the engine is reconciled to null again.
    const reconciled = await reconcilePendingActions(scriptedDeps(store, { clearActiveModel: async () => OK, reconcileActiveModel }));
    expect(reconciled.settled).toBe(true);
    expect(reconcileActiveModel).toHaveBeenCalledTimes(1);
    expect(reconcileActiveModel).toHaveBeenCalledWith(null);
  });

  it("active delete: byte-delete FAILS, but the context was released FIRST (with the model's uri) and the delete stays pending", async () => {
    const store = makeStore({ downloaded: [A, B], activeId: "A" });
    const order: string[] = [];
    const confirmActiveModelReleased = vi.fn(async () => {
      order.push("release");
      return "released" as const;
    });
    const deleteModelFile = vi.fn(async () => {
      order.push("delete");
      throw new Error("unlink failed — read-only mount");
    });
    const deps = scriptedDeps(store, { clearActiveModel: async () => OK, confirmActiveModelReleased, deleteModelFile });

    const result = await performDelete(deps, A);

    expect(result.kind).toBe("ambiguous");
    // Release CONFIRMED before the (failing) byte delete — the file is never unlinked while the context may map it.
    expect(order).toEqual(["release", "delete"]);
    expect(confirmActiveModelReleased).toHaveBeenCalledWith(A.uri);
    // The durable delete-pending is KEPT for a retry (never a never-settling release wedging anything).
    expect((store.get().pending ?? []).map((p) => p.id)).toEqual([`delete:${A.uri}`]);
  });

  it("reconciled active delete releases the context BEFORE deleting the bytes (call order)", async () => {
    const pending: PendingAction = {
      id: `delete:${A.uri}`,
      kind: "delete",
      desired: { enabled: false },
      fileUri: A.uri,
      requiresLauncherClear: true,
    };
    const store = makeStore({ downloaded: [B], activeId: undefined, pending: [pending] });
    const order: string[] = [];
    const confirmActiveModelReleased = vi.fn(async () => {
      order.push("release");
      return "released" as const;
    });
    const deleteModelFile = vi.fn(async () => {
      order.push("delete");
    });
    const result = await reconcilePendingActions(
      scriptedDeps(store, { clearActiveModel: async () => OK, confirmActiveModelReleased, deleteModelFile }),
    );

    expect(result.settled).toBe(true);
    expect(order).toEqual(["release", "delete"]);
    expect(confirmActiveModelReleased).toHaveBeenCalledWith(A.uri);
  });

  it("an inactive delete runs the path-aware release BARRIER (a confirmed no-op) and still deletes", async () => {
    // The barrier always runs before the unlink; for an inactive model it's a path-aware no-op that resolves
    // 'released' immediately (the model isn't loaded), so the byte delete proceeds. The active context is
    // never actually torn down — that path-awareness is verified in on-device-llm.test.ts. `reconcileActiveModel`
    // (the deactivate/clear engine sync) is NOT called for a delete.
    const store = makeStore({ downloaded: [A, B], activeId: "B" });
    const reconcileActiveModel = vi.fn(() => {});
    const confirmActiveModelReleased = vi.fn(async () => "released" as const);
    const deleteFile = vi.fn(async () => {});
    const deps = scriptedDeps(store, { reconcileActiveModel, confirmActiveModelReleased, deleteModelFile: deleteFile });

    const result = await performDelete(deps, A); // A is inactive (B is active)

    expect(result.kind).toBe("ok");
    expect(reconcileActiveModel).not.toHaveBeenCalled();
    expect(confirmActiveModelReleased).toHaveBeenCalledWith(A.uri); // the barrier ran (path-aware no-op)
    expect(deleteFile).toHaveBeenCalledWith(A.uri);
  });

  it("an UNCONFIRMED release defers the byte delete — pending kept, no unlink (CodeRabbit)", async () => {
    const store = makeStore({ downloaded: [A, B], activeId: "A" });
    const confirmActiveModelReleased = vi.fn(async () => "unconfirmed" as const);
    const deleteFile = vi.fn(async () => {});
    const result = await performDelete(
      store.get().activeId === "A"
        ? scriptedDeps(store, { clearActiveModel: async () => OK, confirmActiveModelReleased, deleteModelFile: deleteFile })
        : scriptedDeps(store, { confirmActiveModelReleased, deleteModelFile: deleteFile }),
      A,
    );

    expect(result.kind).toBe("ambiguous");
    // The file is NEVER unlinked while the native context may still map it; the durable pending is kept.
    expect(deleteFile).not.toHaveBeenCalled();
    expect((store.get().pending ?? []).map((p) => p.id)).toEqual([`delete:${A.uri}`]);
  });
});

describe("inactive-model delete never issues a launcher clear (CodeRabbit Finding 3)", () => {
  it("reconciles an inactive delete by deleting bytes WITHOUT clearActiveModel, even with another model active", async () => {
    const pending: PendingAction = {
      id: `delete:${B.uri}`,
      kind: "delete",
      desired: { enabled: false },
      fileUri: B.uri,
      requiresLauncherClear: false,
    };
    const store = makeStore({ downloaded: [A], activeId: "A", pending: [pending] });
    const clear = vi.fn(async () => OK);
    const deleteFile = vi.fn(async () => {});
    const result = await reconcilePendingActions(scriptedDeps(store, { clearActiveModel: clear, deleteModelFile: deleteFile }));

    // The launcher never referenced B — reconciliation must not clear the pointer (it would disable live A).
    expect(clear).not.toHaveBeenCalled();
    expect(deleteFile).toHaveBeenCalledWith(B.uri);
    expect(result.settled).toBe(true);
    expect(store.get().pending ?? []).toEqual([]);
  });

  it("a launcher-clear FAILURE cannot block an inactive delete — it goes straight to the checked byte delete", async () => {
    const pending: PendingAction = {
      id: `delete:${B.uri}`,
      kind: "delete",
      desired: { enabled: false },
      fileUri: B.uri,
      requiresLauncherClear: false,
    };
    // Nothing active: the OLD `activeId === undefined` gate would have issued a clear here and, on FAILED,
    // returned early WITHOUT deleting the bytes — wrongly blocking an inactive delete on the launcher.
    const store = makeStore({ downloaded: [], activeId: undefined, pending: [pending] });
    const clear = vi.fn(async () => FAILED);
    const deleteFile = vi.fn(async () => {});
    const result = await reconcilePendingActions(scriptedDeps(store, { clearActiveModel: clear, deleteModelFile: deleteFile }));

    expect(clear).not.toHaveBeenCalled();
    expect(deleteFile).toHaveBeenCalledWith(B.uri);
    expect(result.settled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P2-1 round 8: a failed pending-CLEAR must not re-enable controls while stale intent is on disk.
// Driven against the REAL store (`mutateModelManagerState` + the filesystem mock), NOT the in-memory
// fake, so the save-failure return contract the fake asserts is verified end-to-end: after a SUCCEEDED
// bridge op, if clearing its pending record fails to persist, the action must hand back the
// DISK-CONFIRMED state (pending STILL present) — never an attempted state with the pending dropped —
// so the component's `pendingUnsettled` derivation keeps the controls blocked and the durable journal
// is honoured.
// ---------------------------------------------------------------------------

const STATE_PATH = `${fileSystemMock.documentDirectory}loam-model-manager.json`;

/** Mirrors the component's `runOperation` control-enablement derivation
 * (model-manager.tsx: `setPendingUnsettled((outcome.state.pending ?? []).length > 0)`): controls stay
 * blocked whenever the state the component would adopt still carries a pending action. */
function componentControlsBlocked(result: { state?: ModelManagerState }): boolean {
  return (result.state?.pending ?? []).length > 0;
}

describe("real-store integration: a failed pending-clear keeps controls blocked (P2-1 round 8)", () => {
  beforeEach(() => {
    resetFileSystemMock();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("bridge OK but the pending-clear save FAILS → on-disk pending survives, action AMBIGUOUS, controls stay blocked", async () => {
    // Seed a real, valid persisted state so `mutateModelManagerState` reads/writes it for real.
    seedFile(STATE_PATH, JSON.stringify({ downloaded: [A, B], activeId: "B" }));

    // Fail ONLY the SECOND save's temp-file write. Save #1 is the atomic write-ahead (activeId=A + the
    // setActive pending — must LAND); save #2 is `clearPendingEntry` after the ok bridge (must FAIL, so
    // the on-disk pending survives). Each `saveModelManagerState` performs exactly one
    // `writeAsStringAsync` (its randomly-named temp file), so the 2nd write call is the clear.
    const realWrite = fileSystemMock.writeAsStringAsync.bind(fileSystemMock);
    let writeCalls = 0;
    vi.spyOn(fileSystemMock, "writeAsStringAsync").mockImplementation(async (uri: string, contents: string) => {
      writeCalls += 1;
      if (writeCalls === 2) {
        throw new Error("ENOSPC: no space left on device (pending-clear save)");
      }
      return realWrite(uri, contents);
    });

    const setActive = vi.fn(async () => OK);
    const deps: ModelActionDeps = {
      mutate: mutateModelManagerState, // the REAL serialized store, not the in-memory fake
      setActiveModel: setActive,
      clearActiveModel: async () => OK,
      deleteModelFile: vi.fn(async () => {}),
      reconcileActiveModel: vi.fn(() => {}),
      invalidateStaleLoad: vi.fn(() => {}),
      confirmActiveModelReleased: vi.fn(async () => 'released' as const),
    };

    const result = await performSetActive(deps, A);

    // The launcher confirmed the write, but the durable pending-clear didn't land — so NOT a clean `ok`.
    expect(result.kind).toBe("ambiguous");
    expect(setActive).toHaveBeenCalledTimes(1);

    // The action hands the component the DISK-CONFIRMED state: the setActive pending is STILL present,
    // NOT dropped by the unpersisted clear. This is what the component adopts.
    expect((result.state?.pending ?? []).map((p) => p.id)).toEqual([POINTER_PENDING_ID]);
    // …so the component keeps the destructive controls blocked (no further op while stale intent persists).
    expect(componentControlsBlocked(result)).toBe(true);

    // And the durable on-disk journal genuinely still holds the pending — proven by reloading from the
    // real filesystem (the clear never touched disk).
    const onDisk = await loadModelManagerState();
    expect(onDisk.activeId).toBe("A");
    expect((onDisk.pending ?? []).map((p) => p.id)).toEqual([POINTER_PENDING_ID]);
  });

  it("control case: when the pending-clear save SUCCEEDS the pending is gone and controls re-enable", async () => {
    // The same flow with no injected failure settles cleanly — guards against the P2-1 fix over-blocking.
    seedFile(STATE_PATH, JSON.stringify({ downloaded: [A, B], activeId: "B" }));
    const deps: ModelActionDeps = {
      mutate: mutateModelManagerState,
      setActiveModel: async () => OK,
      clearActiveModel: async () => OK,
      deleteModelFile: vi.fn(async () => {}),
      reconcileActiveModel: vi.fn(() => {}),
      invalidateStaleLoad: vi.fn(() => {}),
      confirmActiveModelReleased: vi.fn(async () => 'released' as const),
    };

    const result = await performSetActive(deps, A);

    expect(result.kind).toBe("ok");
    expect(result.state?.pending ?? []).toEqual([]);
    expect(componentControlsBlocked(result)).toBe(false);
    const onDisk = await loadModelManagerState();
    expect(onDisk.activeId).toBe("A");
    expect("pending" in onDisk).toBe(false);
  });
});
