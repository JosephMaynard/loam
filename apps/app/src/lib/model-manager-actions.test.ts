// P2-2 round 5 (with P2-1's rollback semantics): the activate/deactivate/delete transactions in
// model-manager-actions.ts. Verifies:
//   - the global mutex serializes whole transactions (B doesn't start until A fully settles);
//   - a stale rollback never clobbers a newer successful selection (conditional/versioned rollback);
//   - a bridge TIMEOUT is left in place (ambiguous, no rollback — P2-1), while an explicit FAILURE
//     rolls back cleanly;
//   - delete never deletes the file bytes unless the launcher clear is confirmed.
import { describe, expect, it, vi } from "vitest";

import { fileSystemMock } from "@/test-utils/mocks";

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
import { MODEL_LIST_UNREADABLE_MESSAGE, POINTER_PENDING_ID } from "@/lib/model-manager-store";
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
 * after a microtask, mirroring `mutateModelManagerState` closely enough for these tests. On a failed
 * write it returns the UNCHANGED state with `persisted:false` — the same "the mutation didn't land, so
 * disk still holds the old value" contract callers rely on (P2-1). `failWriteAt(n)` fails the n-th mutate
 * (1-based) so a test can fail a SECOND write mid-transaction (e.g. a clear-pending after a durable
 * write-ahead), which `failNextWrite` (fails the very next one) can't target. */
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
      { id: `delete:${A.uri}`, kind: "delete", desired: { enabled: false }, fileUri: A.uri },
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
    const deps = scriptedDeps(store, { setActiveModel: async () => FAILED });

    const result = await reconcilePendingActions(deps);

    expect(result.settled).toBe(true);
    expect(store.get().activeId).toBeUndefined(); // launcher didn't apply it — stop claiming it locally
    expect(store.get().pending ?? []).toEqual([]);
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
  it("failure to CLEAR a confirmed delete pending → not settled, bytes NOT deleted, pending kept (no stale replay)", async () => {
    const pending: PendingAction = { id: `delete:${A.uri}`, kind: "delete", desired: { enabled: false }, fileUri: A.uri };
    const store = makeStore({ downloaded: [B], activeId: undefined, pending: [pending] });
    // The reconcile's identity read is write #1; the clear-pending after the ok bridge is write #2 — fail it.
    store.failWriteAt(2);
    const deleteFile = vi.fn(async () => {});
    const deps = scriptedDeps(store, { clearActiveModel: async () => OK, deleteModelFile: deleteFile });

    const result = await reconcilePendingActions(deps);

    // The launcher confirmed the clear, but we couldn't durably drop the pending — so DO NOT report
    // settled and DO NOT delete the bytes; the on-disk pending must survive to be retried, never replaced
    // by an in-memory assumption that would let the file be swept.
    expect(result.settled).toBe(false);
    expect(deleteFile).not.toHaveBeenCalled();
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
