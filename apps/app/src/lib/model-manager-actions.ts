// The activate / deactivate / delete transaction logic for the on-device model manager, EXTRACTED out
// of `model-manager.tsx` (P2-2 round 5) so the full persist → bridge → rollback transaction is unit
// testable and — critically — so it can be SERIALIZED as one indivisible operation.
//
// The bug this fixes: `model-manager.tsx` used to persist each state change through
// `mutateModelManagerState` (which serializes individual state WRITES) but then `await`ed the bridge
// call OUTSIDE that queue, and its rollback restored `activeId` UNCONDITIONALLY. So two operations
// could interleave — activate A (persist A, await bridge) → activate B (persist B, bridge ok) → A's
// bridge fails → A blindly rolls `activeId` back to its previous value, CLOBBERING B's newer, already
// succeeded selection. Delete/deactivate had the same stale-rollback race.
//
// Two independent defenses close it, both implemented here:
//   1. A global operation mutex (`runExclusive`): only ONE activate/deactivate/delete transaction runs
//      at a time, start (first persist) to finish (any rollback). B cannot even begin until A's whole
//      transaction has settled. `model-manager.tsx` additionally disables the conflicting controls
//      globally while an op is in flight, so the mutex is rarely contended in practice.
//   2. Versioned / CONDITIONAL rollback: a rollback only reverts `activeId` if it STILL equals what
//      this operation set it to. If some later operation already changed it, the rollback is a no-op —
//      so even an interleaving that slipped past the mutex can never clobber a newer selection.
//
// Dependencies are injected (`ModelActionDeps`) rather than imported directly, so tests can drive the
// transactions against in-memory fakes and deterministically script bridge success/failure/timeout and
// interleavings. `model-manager.tsx` binds the real deps (the store's `mutateModelManagerState`, the
// bridge's `setActiveModel`/`clearActiveModel`, and the CHECKED `deleteModelFileChecked`) and calls the
// wrappers below.

import type { ActiveModelResult, SetActiveModelRequest } from './model-manager-bridge';
import type { DownloadedModel, ModelManagerState, MutateResult, PendingAction } from './model-manager-store';
import { MODEL_LIST_UNREADABLE_MESSAGE, POINTER_PENDING_ID, recordPending } from './model-manager-store';

/** The store + bridge + filesystem operations each transaction needs, injected so the logic is pure
 * and testable. `model-manager.tsx` binds these to the real implementations (the bridge fns are
 * partially applied with the nodejs-mobile `channel`). */
export interface ModelActionDeps {
  /** Serialized read-modify-write against the persisted state — the store's `mutateModelManagerState`. */
  mutate(mutate: (current: ModelManagerState) => ModelManagerState): Promise<MutateResult>;
  /** Push the active model to the launcher config — the bridge's `setActiveModel(channel, ...)`. */
  setActiveModel(request: SetActiveModelRequest): Promise<ActiveModelResult>;
  /** Clear the launcher's active pointer — the bridge's `clearActiveModel(channel)`. */
  clearActiveModel(): Promise<ActiveModelResult>;
  /** Irreversibly delete a downloaded GGUF's bytes. MUST be a CHECKED delete (Finding 1) — it PROPAGATES
   * a filesystem failure and only resolves once the file is confirmed gone (bound to
   * `deleteModelFileChecked`, not the best-effort `safeDelete`). The transactions below rely on that: a
   * throw here keeps the durable delete-pending in place so reconciliation retries, rather than reporting
   * a model "deleted" while its multi-GB file silently remains on disk. */
  deleteModelFile(uri: string): Promise<void>;
}

/** How a transaction ended, so `model-manager.tsx` can adopt the resulting state and show a message:
 *   - `'ok'`           — persisted + confirmed by the launcher.
 *   - `'rolled-back'`  — the launcher DEFINITELY failed (`ok:false`); the local change was cleanly and
 *                        conditionally reverted.
 *   - `'ambiguous'`    — the bridge timed out after retries (couldn't confirm); the local change was
 *                        LEFT in place (never wrongly rolled back — P2-1), to be reconciled later.
 *   - `'persist-failed'` — the durable local write itself failed; nothing else was attempted.
 * `state` is the state the UI should adopt (absent only for `'persist-failed'`, where nothing changed). */
export type ModelActionResult = {
  kind: 'ok' | 'rolled-back' | 'ambiguous' | 'persist-failed';
  state?: ModelManagerState;
  message: string;
};

const PERSIST_FAILED_MESSAGE =
  "Couldn't save that change to the model list — it may not survive an app restart. Try again.";

// ---------------------------------------------------------------------------
// Global operation mutex — serializes the ENTIRE persist → bridge → rollback transaction.
// ---------------------------------------------------------------------------

let operationChain: Promise<unknown> = Promise.resolve();

/**
 * Run `op` after every previously-queued operation has fully settled, and hand the next queued op a
 * chain that only resolves once `op` (including any rollback it performs) is done. This is the
 * transaction-level lock that `mutateModelManagerState` (a write-level lock) can't provide on its own.
 * The chain is kept alive across rejections so one failed op can't wedge every later one.
 */
export function runExclusive<T>(op: () => Promise<T>): Promise<T> {
  const run = operationChain.then(op);
  operationChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ---------------------------------------------------------------------------
// Transactions (mutex-free core — wrapped by the exported *Action fns below).
// ---------------------------------------------------------------------------

/**
 * Set `model` active. WRITE-AHEAD intent journal (P2-1): persist `activeId = model.id` AND a durable
 * pending-`setActive` record in ONE atomic write, BEFORE the bridge call — so if the process dies at any
 * point after, reconciliation re-sends the (idempotent) launcher write and settles it, and the pending's
 * `modelPath` keeps the file sweep-protected. Only after a CONFIRMED bridge result do we durably clear
 * (`ok`) or resolve (`failed`) the pending; a bridge TIMEOUT leaves the already-durable pending in place.
 * Every persist result is CHECKED — nothing is reported as durable/settled that isn't confirmed on disk.
 *
 * Exposed (not just the `*Action` wrapper) so tests can drive a deliberate interleaving — e.g. start
 * A, run B to completion, then fail A — and assert A's conditional rollback does NOT clobber B.
 */
export async function performSetActive(deps: ModelActionDeps, model: DownloadedModel): Promise<ModelActionResult> {
  let previousActiveId: string | undefined;
  const { state, persisted } = await deps.mutate((current) => {
    previousActiveId = current.activeId;
    return {
      ...current,
      activeId: model.id,
      pending: recordPending(current.pending, {
        id: POINTER_PENDING_ID,
        kind: 'setActive',
        desired: { enabled: true, modelPath: model.uri, model: model.displayName },
      }),
    };
  });
  if (!persisted) {
    return { kind: 'persist-failed', message: PERSIST_FAILED_MESSAGE };
  }

  const result = await deps.setActiveModel({ modelPath: model.uri, model: model.displayName });
  if (result.status === 'ok') {
    // Confirmed. Durably CLEAR the write-ahead pending — but only report a clean `ok` once that clear is
    // itself confirmed on disk (P2-1). If it fails to persist, the on-disk pending survives, so report
    // `ambiguous` and let the next reconcile finish it rather than claim a settled state that isn't.
    const cleared = await clearPendingEntry(deps, POINTER_PENDING_ID);
    if (!cleared.persisted) {
      return {
        kind: 'ambiguous',
        state: cleared.state,
        message: `${model.displayName} is now the active model, but its pending record couldn't be cleared — it'll be reconciled next time you open the model manager. Restart the LOAM host app to load it.`,
      };
    }
    return {
      kind: 'ok',
      state: cleared.state,
      message: `${model.displayName} is now the active model. Restart the LOAM host app to load it.`,
    };
  }
  if (result.status === 'failed') {
    return rollbackActiveId(deps, {
      expected: model.id,
      restoreTo: previousActiveId,
      pendingId: POINTER_PENDING_ID,
      failedMessage: (rolledBack) =>
        rolledBack
          ? `Couldn't set ${model.displayName} active — the host app's config couldn't be refreshed (${result.error ?? 'unknown error'}). No change was made.`
          : `Couldn't set ${model.displayName} active, and the rollback also failed to save — local state and the host app's config may now disagree. Restart the LOAM host app.`,
    });
  }
  // Timeout — AMBIGUOUS. The write may already have landed, so leave the local `activeId` set rather
  // than reverting it (a wrong rollback is exactly the divergence P2-1 prevents). The write-ahead
  // pending is ALREADY durable (recorded above), so there is nothing more to persist — reconciliation
  // re-sends the launcher write and settles it on the next open/restart.
  return {
    kind: 'ambiguous',
    state,
    message: `Set ${model.displayName} active, but couldn't confirm the host app applied it (${result.error ?? 'no response'}). It'll be reconciled next time you open the model manager or restart the host.`,
  };
}

/**
 * Clear the active model: persist `activeId = undefined`, then clear the launcher pointer. Same
 * definite-failure-only conditional rollback / timeout-is-ambiguous handling as `performSetActive`.
 */
export async function performDeactivate(deps: ModelActionDeps): Promise<ModelActionResult> {
  let previousActiveId: string | undefined;
  // Write-ahead intent (P2-1): clear `activeId` AND record a durable pending-`clear` in one atomic write
  // before the bridge call — same durability guarantee as `performSetActive`.
  const { state, persisted } = await deps.mutate((current) => {
    previousActiveId = current.activeId;
    return {
      ...current,
      activeId: undefined,
      pending: recordPending(current.pending, { id: POINTER_PENDING_ID, kind: 'clear', desired: { enabled: false } }),
    };
  });
  if (!persisted) {
    return { kind: 'persist-failed', message: PERSIST_FAILED_MESSAGE };
  }

  const result = await deps.clearActiveModel();
  if (result.status === 'ok') {
    const cleared = await clearPendingEntry(deps, POINTER_PENDING_ID);
    if (!cleared.persisted) {
      return {
        kind: 'ambiguous',
        state: cleared.state,
        message:
          "On-device model deactivated, but its pending record couldn't be cleared — it'll be reconciled next time you open the model manager. Restart the LOAM host app to apply it.",
      };
    }
    return {
      kind: 'ok',
      state: cleared.state,
      message: 'On-device model deactivated. Restart the LOAM host app to apply it.',
    };
  }
  if (result.status === 'failed') {
    return rollbackActiveId(deps, {
      expected: undefined,
      restoreTo: previousActiveId,
      pendingId: POINTER_PENDING_ID,
      failedMessage: (rolledBack) =>
        rolledBack
          ? `Couldn't deactivate the on-device model — the host app's config couldn't be refreshed (${result.error ?? 'unknown error'}). No change was made.`
          : `Couldn't deactivate the on-device model, and the rollback also failed to save — local state and the host app's config may now disagree. Restart the LOAM host app.`,
    });
  }
  // Timeout — AMBIGUOUS. The write-ahead pending is already durable; reconciliation re-sends the clear.
  return {
    kind: 'ambiguous',
    state,
    message: `Deactivated the on-device model, but couldn't confirm the host app applied it (${result.error ?? 'no response'}). It'll be reconciled next time you open the model manager or restart the host.`,
  };
}

/**
 * Delete `model`. Sequenced so a failure at any step leaves a SAFE, recoverable state:
 *   1. Persist the metadata removal (drop from `downloaded`; clear `activeId` if it was active) AND — in
 *      the SAME atomic write — record a durable write-ahead `delete` pending whose `fileUri` keeps the
 *      bytes sweep-protected until the deletion is confirmed (recorded for BOTH the active and inactive
 *      cases now — Finding 1 — so a byte-deletion failure is durably retryable in either).
 *   2. If it was active, clear the launcher's active pointer and CHECK the result.
 *   3. Only on a confirmed `'ok'` (or if there was nothing active to clear) do we perform the
 *      IRREVERSIBLE byte deletion — now a CHECKED delete (Finding 1) that throws if the file survives.
 *   4. Delete the bytes, THEN clear the pending. If the byte delete FAILS we keep the pending and report
 *      `ambiguous` (never a false "deleted"), so reconciliation retries the idempotent checked deletion.
 * A DEFINITE clear failure conditionally rolls the metadata back (re-add the model, restore `activeId`,
 * drop the write-ahead pending) and leaves the file on disk. A TIMEOUT is ambiguous: we still do NOT
 * delete the bytes (can't confirm the launcher released the file — a dangling pointer to MISSING bytes is
 * the one outcome to avoid), and — per P2-1 — do NOT roll back either (the clear may have landed); the
 * metadata stays removed and the delete-pending drives the retry. Exposed for interleaving tests.
 */
export async function performDelete(deps: ModelActionDeps, model: DownloadedModel): Promise<ModelActionResult> {
  const pendingId = `delete:${model.uri}`;
  let wasActive = false;
  // Write-ahead intent (P2-1): remove the metadata AND record a durable pending-`delete` in ONE atomic
  // write, BEFORE the bridge clear. The pending's `fileUri` keeps the bytes sweep-protected from the
  // moment the metadata is gone (closing the "restart finds metadata removed but no pending protection →
  // sweep deletes the file" window), and reconciliation re-sends the clear (if it was active) / retries
  // the byte deletion if we die before confirming. This preserves any OTHER `pending` entries: the old
  // reconstruction returned a bare `{ downloaded, activeId }`, silently DROPPING the whole pending array.
  const { state, persisted } = await deps.mutate((current) => {
    wasActive = current.activeId === model.id;
    const remaining = current.downloaded.filter((existing) => existing.id !== model.id);
    if (wasActive) {
      // Active delete: clear `activeId` and record the write-ahead delete-pending. `recordPending` also
      // drops any stale launcher-pointer pending — correct here, since deleting the active model
      // supersedes an in-flight pointer intent.
      return {
        ...current,
        downloaded: remaining,
        activeId: undefined,
        pending: recordPending(current.pending, {
          id: pendingId,
          kind: 'delete',
          desired: { enabled: false },
          fileUri: model.uri,
        }),
      };
    }
    // Inactive delete: leave `activeId` (and any launcher-pointer pending for ANOTHER model) untouched,
    // and append the delete-pending as a pure byte-deletion journal (Finding 1) — superseding only an
    // existing same-file entry, never the pointer — so a failed byte delete is durably retryable.
    return {
      ...current,
      downloaded: remaining,
      pending: [
        ...(current.pending ?? []).filter((existing) => existing.id !== pendingId),
        { id: pendingId, kind: 'delete', desired: { enabled: false }, fileUri: model.uri },
      ],
    };
  });
  if (!persisted) {
    return { kind: 'persist-failed', message: PERSIST_FAILED_MESSAGE };
  }

  if (wasActive) {
    const result = await deps.clearActiveModel();
    if (result.status === 'failed') {
      // Definite failure: the launcher still thinks this model is active — deleting its bytes now would
      // leave config.json pointing at a file that no longer exists. Conditionally roll the metadata
      // removal back (only if nothing newer changed the pointer) AND drop the write-ahead delete-pending,
      // in one atomic write, and refuse the irreversible delete.
      const { state: rolled, persisted: rolledBack } = await deps.mutate((current) => {
        // Someone else already changed the active pointer away from this model — leave their change (and
        // their pending) be.
        if (current.activeId !== undefined && current.activeId !== model.id) {
          return current;
        }
        return {
          ...current,
          downloaded: current.downloaded.some((existing) => existing.id === model.id)
            ? current.downloaded
            : [...current.downloaded, model],
          activeId: model.id,
          pending: dropPending(current.pending, pendingId),
        };
      });
      return {
        kind: 'rolled-back',
        state: rolled,
        message: rolledBack
          ? `Couldn't delete ${model.displayName} — the host app's active-model config couldn't be cleared (${result.error ?? 'unknown error'}). No change was made.`
          : `Couldn't delete ${model.displayName}, and the rollback also failed to save — local state and the host app's config may now disagree. Restart the LOAM host app.`,
      };
    }
    if (result.status === 'timeout') {
      // Ambiguous: don't roll back (P2-1) and — critically — don't delete the bytes, since we can't
      // confirm the launcher released the file. The write-ahead delete-pending is ALREADY durable (its
      // `fileUri` is a do-not-sweep reference guarding against the dangling-pointer bug), so there is
      // nothing more to persist — reconciliation re-sends the clear and deletes the bytes once CONFIRMED.
      return {
        kind: 'ambiguous',
        state,
        message: `Removed ${model.displayName} from the list, but couldn't confirm the host app released it (${result.error ?? 'no response'}), so its file was kept for now. It'll be reconciled next time you open the model manager or restart the host.`,
      };
    }
    // Confirmed `ok` — the launcher released the file. Now delete the bytes (CHECKED) then clear the
    // journal (Finding 1).
    return commitByteDeletion(deps, model, state);
  }

  // Inactive: no launcher clear needed — delete the bytes (CHECKED) then clear the journal (Finding 1).
  return commitByteDeletion(deps, model, state);
}

/**
 * Finish a delete transaction by performing the IRREVERSIBLE byte deletion, CHECKED (Finding 1), then
 * clearing the write-ahead delete-pending — in that order, so a delete that leaves the file on disk keeps
 * the durable pending for reconciliation to retry instead of ever reporting a false "deleted":
 *   - the checked `deps.deleteModelFile` THROWS if the file survives → keep the pending (its `fileUri`
 *     also keeps the file sweep-protected), hand back the write-ahead `state` (pending still present so
 *     the component's controls stay blocked), report `ambiguous`;
 *   - it succeeds → durably drop the pending; only report a clean `ok` once that drop lands, else
 *     `ambiguous` (the file is gone but the journal survives; the next reconcile repeats the now-no-op
 *     idempotent checked delete and clears it).
 */
async function commitByteDeletion(
  deps: ModelActionDeps,
  model: DownloadedModel,
  writeAheadState: ModelManagerState,
): Promise<ModelActionResult> {
  try {
    await deps.deleteModelFile(model.uri);
  } catch (error) {
    return {
      kind: 'ambiguous',
      state: writeAheadState,
      message: `Removed ${model.displayName} from the list, but its file couldn't be deleted (${error instanceof Error ? error.message : String(error)}) — it'll be retried next time you open the model manager.`,
    };
  }
  const cleared = await clearPendingEntry(deps, `delete:${model.uri}`);
  if (!cleared.persisted) {
    return {
      kind: 'ambiguous',
      state: cleared.state,
      message: `Deleted ${model.displayName}'s file, but its pending record couldn't be cleared — it'll be reconciled next time you open the model manager.`,
    };
  }
  return { kind: 'ok', state: cleared.state, message: `${model.displayName} deleted.` };
}

/**
 * Conditional (versioned) rollback of `activeId`: revert to `restoreTo` ONLY if the current `activeId`
 * still equals `expected` (what the failed op set). If a later op already changed it, this is a no-op,
 * so a stale rollback can never clobber a newer selection (the P2-2 clobber guard, belt-and-suspenders
 * with the mutex). When it DOES revert, it also drops the failed op's write-ahead `pendingId` in the
 * SAME atomic write (P2-1) — a definitively-failed action must not leave a stale pending that replays
 * after restart. `persisted` is threaded into the message so a failed rollback-save is surfaced, never
 * assumed durable.
 */
async function rollbackActiveId(
  deps: ModelActionDeps,
  opts: {
    expected: string | undefined;
    restoreTo: string | undefined;
    pendingId?: string;
    failedMessage: (rolledBack: boolean) => string;
  },
): Promise<ModelActionResult> {
  const { state, persisted } = await deps.mutate((current) =>
    current.activeId === opts.expected
      ? {
          ...current,
          activeId: opts.restoreTo,
          pending: opts.pendingId ? dropPending(current.pending, opts.pendingId) : current.pending,
        }
      : current,
  );
  return { kind: 'rolled-back', state, message: opts.failedMessage(persisted) };
}

// ---------------------------------------------------------------------------
// Durable pending-action reconciliation (P2-b).
// ---------------------------------------------------------------------------

/** Outcome of a reconciliation pass. `settled` is true only when NO pending actions remain (every one
 * was confirmed or definitively resolved) — the manager keeps action controls (and the orphan sweep,
 * for the affected files) gated until then. `message` is a non-fatal summary to surface when unsettled. */
export type ReconcileResult = {
  state: ModelManagerState;
  settled: boolean;
  /** RF7-b: true when reconcile could NOT reliably READ the persisted state — its identity mutate refused
   * because `readModelManagerState()` errored (a transient I/O failure / corruption, NOT a clean absence).
   * The returned `state` is then an UNTRUSTED `EMPTY_STATE`: the component must NOT adopt it or run the
   * orphan sweep against it (doing so would delete every downloaded `.gguf`), and must block the
   * destructive controls with the recovery banner — exactly like `dispositionFromLoad`'s direct-load
   * `error` path. Never set together with a trustworthy `settled` result. */
  unreadable?: boolean;
  message?: string;
};

function dropPending(pending: PendingAction[] | undefined, id: string): PendingAction[] {
  return (pending ?? []).filter((entry) => entry.id !== id);
}

/** Drop pending entry `id`, returning the store's `MutateResult` so callers can CHECK `persisted`
 * (P2-1): a settled/ok outcome may only be reported when the drop is CONFIRMED on disk — otherwise the
 * on-disk pending survives and would replay after restart. */
async function clearPendingEntry(deps: ModelActionDeps, id: string): Promise<MutateResult> {
  return deps.mutate((current) => ({ ...current, pending: dropPending(current.pending, id) }));
}

/**
 * Re-send ONE pending action's idempotent bridge write and resolve it:
 *   - `ok`      — confirmed. For a `'delete'`, the launcher has now released the file, so (and ONLY
 *                 now) delete its bytes; then clear the pending entry.
 *   - `timeout` — still ambiguous. KEEP the entry (and its file protection) untouched for the next pass.
 *   - `failed`  — a DEFINITE answer:
 *       · `'delete'`   — the launcher still references the file, so the bytes must NOT be deleted; keep
 *                        the entry so the file stays sweep-protected and the clear is retried later.
 *       · `'setActive'`— the launcher did NOT activate the model; conditionally clear `activeId` (only if
 *                        it still names this model, so a newer selection isn't clobbered) and drop it.
 *       · `'clear'`    — nothing on disk to protect; stop retrying and drop it.
 */
async function reconcileOne(
  deps: ModelActionDeps,
  action: PendingAction,
  state: ModelManagerState,
): Promise<ModelManagerState> {
  if (action.kind === 'delete') {
    return reconcileDelete(deps, action, state);
  }

  const result =
    action.kind === 'setActive'
      ? await deps.setActiveModel({ modelPath: action.desired.modelPath ?? '', model: action.desired.model })
      : await deps.clearActiveModel();

  if (result.status === 'timeout') {
    return state; // still ambiguous — leave the pending entry in place
  }

  if (result.status === 'ok') {
    // Confirmed. Durably drop the pending and CHECK it landed (P2-1): only once the drop is on disk may
    // we treat it settled. If the drop write fails, keep the pending in our view so the next pass retries;
    // never report settled off an in-memory assumption that isn't on disk.
    const cleared = await clearPendingEntry(deps, action.id);
    return cleared.persisted ? cleared.state : state;
  }

  // Definite failure.
  if (action.kind === 'setActive') {
    const { state: next, persisted } = await deps.mutate((current) => {
      const stillOurs =
        current.downloaded.find((model) => model.id === current.activeId)?.uri === action.desired.modelPath;
      return {
        ...current,
        activeId: stillOurs ? undefined : current.activeId,
        pending: dropPending(current.pending, action.id),
      };
    });
    // If the resolve write itself failed, the on-disk pending survives — keep our pre-mutation view so
    // `settled` reflects disk truth and the entry is retried next pass, not silently reported resolved.
    return persisted ? next : state;
  }
  const cleared = await clearPendingEntry(deps, action.id);
  return cleared.persisted ? cleared.state : state;
}

/**
 * Reconcile ONE durable `delete` pending (P2-b + Finding 1). Ordered CHECKED-delete-then-clear, and
 * gated so it never wrongly touches the launcher pointer:
 *   - It clears the launcher's active pointer ONLY when local truth (`state.activeId`) says NOTHING
 *     should be active — i.e. this delete was of the active model, which set `activeId = undefined`. If a
 *     DIFFERENT model is currently active, the launcher must keep pointing at it: an inactive model's
 *     delete never moved the pointer (Finding 1 records a delete-pending for those too now), so clearing
 *     it here would wrongly disable the live model. In that case we skip the bridge and go straight to the
 *     byte deletion (the launcher never referenced this file, so there is no dangling-pointer risk).
 *   - A launcher clear that TIMES OUT (ambiguous) or FAILS (launcher still references the file) keeps the
 *     pending and its bytes for the next pass.
 *   - On a confirmed release, the bytes are deleted with the CHECKED delete FIRST (keep the pending on a
 *     throw so it retries), then the journal entry is dropped — only reporting the file reclaimed once
 *     that drop lands (else keep the pending; a crash between the two is safe, the next pass repeats the
 *     idempotent checked delete).
 */
async function reconcileDelete(
  deps: ModelActionDeps,
  action: PendingAction,
  state: ModelManagerState,
): Promise<ModelManagerState> {
  if (state.activeId === undefined) {
    const result = await deps.clearActiveModel();
    if (result.status !== 'ok') {
      // timeout (ambiguous) or failed (launcher still references it) — keep the pending + bytes untouched.
      return state;
    }
  }
  if (action.fileUri) {
    try {
      await deps.deleteModelFile(action.fileUri);
    } catch {
      return state; // bytes may still be on disk — keep the pending, retry next pass
    }
  }
  const cleared = await clearPendingEntry(deps, action.id);
  return cleared.persisted ? cleared.state : state;
}

/**
 * Reconcile the durable pending set (P2-b): re-send each unconfirmed launcher write and settle it. Runs
 * under the global operation mutex so it can't interleave with an activate/deactivate/delete, and reads
 * the FRESHLY-persisted pending set (via a `mutate` identity read) so it picks up entries written by a
 * previous process. The manager calls this on open BEFORE enabling controls or running the orphan sweep.
 */
export function reconcilePendingActions(deps: ModelActionDeps): Promise<ReconcileResult> {
  return runExclusive(async () => {
    // RF7-b: CHECK `persisted` on the identity read. `mutateModelManagerState` REFUSES (returns
    // `{ state: EMPTY_STATE, persisted: false }`) when `readModelManagerState()` errors — a transient
    // I/O failure or corruption that is NOT a clean absence. If we trusted that EMPTY_STATE here, reconcile
    // would see `pending: []`, report `settled: true`, and the component would adopt an empty model list
    // and sweep every downloaded `.gguf` away (its own second read bypasses `dispositionFromLoad`'s guard).
    // Instead surface a distinct `unreadable` signal so the component SKIPS the sweep, BLOCKS the
    // destructive controls, and shows the recovery banner — mirroring the direct-load `error` path.
    const { state: initial, persisted } = await deps.mutate((current) => current);
    if (!persisted) {
      return { state: initial, settled: false, unreadable: true, message: MODEL_LIST_UNREADABLE_MESSAGE };
    }
    const pending = initial.pending ?? [];
    if (pending.length === 0) {
      return { state: initial, settled: true };
    }
    let state = initial;
    for (const action of pending) {
      state = await reconcileOne(deps, action, state);
    }
    const remaining = state.pending ?? [];
    return {
      state,
      settled: remaining.length === 0,
      message:
        remaining.length === 0
          ? undefined
          : `${remaining.length} change${remaining.length === 1 ? '' : 's'} still pending — the host app is unreachable. They'll retry the next time you open this.`,
    };
  });
}

// ---------------------------------------------------------------------------
// Public wrappers — each runs its whole transaction under the global mutex.
// ---------------------------------------------------------------------------

/** Serialized `performSetActive` — the entry point `model-manager.tsx` calls. */
export function setActiveAction(deps: ModelActionDeps, model: DownloadedModel): Promise<ModelActionResult> {
  return runExclusive(() => performSetActive(deps, model));
}

/** Serialized `performDeactivate`. */
export function deactivateAction(deps: ModelActionDeps): Promise<ModelActionResult> {
  return runExclusive(() => performDeactivate(deps));
}

/** Serialized `performDelete`. */
export function deleteAction(deps: ModelActionDeps, model: DownloadedModel): Promise<ModelActionResult> {
  return runExclusive(() => performDelete(deps, model));
}
