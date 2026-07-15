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
// bridge's `setActiveModel`/`clearActiveModel`, and `deleteModelFile`) and calls the wrappers below.

import type { ActiveModelResult, SetActiveModelRequest } from './model-manager-bridge';
import type { DownloadedModel, ModelManagerState, MutateResult } from './model-manager-store';

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
  /** Irreversibly delete a downloaded GGUF's bytes — `deleteModelFile`. */
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
 * Set `model` active: persist `activeId = model.id`, then mirror it to the launcher config. On a
 * DEFINITE bridge failure, conditionally roll `activeId` back to its previous value; on a TIMEOUT,
 * leave the change in place (P2-1 — the write may have landed) and report it as ambiguous.
 *
 * Exposed (not just the `*Action` wrapper) so tests can drive a deliberate interleaving — e.g. start
 * A, run B to completion, then fail A — and assert A's conditional rollback does NOT clobber B.
 */
export async function performSetActive(deps: ModelActionDeps, model: DownloadedModel): Promise<ModelActionResult> {
  let previousActiveId: string | undefined;
  const { state, persisted } = await deps.mutate((current) => {
    previousActiveId = current.activeId;
    return { ...current, activeId: model.id };
  });
  if (!persisted) {
    return { kind: 'persist-failed', message: PERSIST_FAILED_MESSAGE };
  }

  const result = await deps.setActiveModel({ modelPath: model.uri, model: model.displayName });
  if (result.status === 'ok') {
    return {
      kind: 'ok',
      state,
      message: `${model.displayName} is now the active model. Restart the LOAM host app to load it.`,
    };
  }
  if (result.status === 'failed') {
    return rollbackActiveId(deps, {
      expected: model.id,
      restoreTo: previousActiveId,
      failedMessage: (rolledBack) =>
        rolledBack
          ? `Couldn't set ${model.displayName} active — the host app's config couldn't be refreshed (${result.error ?? 'unknown error'}). No change was made.`
          : `Couldn't set ${model.displayName} active, and the rollback also failed to save — local state and the host app's config may now disagree. Restart the LOAM host app.`,
    });
  }
  // Timeout — AMBIGUOUS. The write may already have landed, so leave the local `activeId` set rather
  // than reverting it (a wrong rollback is exactly the divergence P2-1 prevents).
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
  const { state, persisted } = await deps.mutate((current) => {
    previousActiveId = current.activeId;
    return { ...current, activeId: undefined };
  });
  if (!persisted) {
    return { kind: 'persist-failed', message: PERSIST_FAILED_MESSAGE };
  }

  const result = await deps.clearActiveModel();
  if (result.status === 'ok') {
    return { kind: 'ok', state, message: 'On-device model deactivated. Restart the LOAM host app to apply it.' };
  }
  if (result.status === 'failed') {
    return rollbackActiveId(deps, {
      expected: undefined,
      restoreTo: previousActiveId,
      failedMessage: (rolledBack) =>
        rolledBack
          ? `Couldn't deactivate the on-device model — the host app's config couldn't be refreshed (${result.error ?? 'unknown error'}). No change was made.`
          : `Couldn't deactivate the on-device model, and the rollback also failed to save — local state and the host app's config may now disagree. Restart the LOAM host app.`,
    });
  }
  return {
    kind: 'ambiguous',
    state,
    message: `Deactivated the on-device model, but couldn't confirm the host app applied it (${result.error ?? 'no response'}). It'll be reconciled next time you open the model manager or restart the host.`,
  };
}

/**
 * Delete `model`. Sequenced so a failure at any step leaves a SAFE, recoverable state:
 *   1. Persist the metadata removal (drop from `downloaded`; clear `activeId` if it was active).
 *   2. If it was active, clear the launcher's active pointer and CHECK the result.
 *   3. Only on a confirmed `'ok'` (or if there was nothing active to clear) do we perform the
 *      IRREVERSIBLE byte deletion.
 * A DEFINITE clear failure conditionally rolls the metadata back (re-add the model, restore `activeId`)
 * and leaves the file on disk. A TIMEOUT is ambiguous: we still do NOT delete the bytes (can't confirm
 * the launcher released the file — a dangling pointer to MISSING bytes is the one outcome to avoid),
 * and — per P2-1 — do NOT roll back either (the clear may have landed); the metadata stays removed and
 * the leftover file is reclaimed later by the orphan sweep. Exposed for interleaving tests.
 */
export async function performDelete(deps: ModelActionDeps, model: DownloadedModel): Promise<ModelActionResult> {
  let wasActive = false;
  const { state, persisted } = await deps.mutate((current) => {
    wasActive = current.activeId === model.id;
    return {
      downloaded: current.downloaded.filter((existing) => existing.id !== model.id),
      activeId: wasActive ? undefined : current.activeId,
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
      // removal back (only if nothing newer changed it) and refuse the irreversible delete.
      const { state: rolled, persisted: rolledBack } = await deps.mutate((current) => {
        // Someone else already changed the active pointer away from this model — leave their change be.
        if (current.activeId !== undefined && current.activeId !== model.id) {
          return current;
        }
        return {
          downloaded: current.downloaded.some((existing) => existing.id === model.id)
            ? current.downloaded
            : [...current.downloaded, model],
          activeId: model.id,
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
      // confirm the launcher released the file. Leave the metadata removed; the orphan sweep reclaims
      // the leftover file on a later launch.
      return {
        kind: 'ambiguous',
        state,
        message: `Removed ${model.displayName} from the list, but couldn't confirm the host app released it (${result.error ?? 'no response'}), so its file was kept for now. It'll be reconciled next time you open the model manager or restart the host.`,
      };
    }
  }

  await deps.deleteModelFile(model.uri);
  return { kind: 'ok', state, message: `${model.displayName} deleted.` };
}

/**
 * Conditional (versioned) rollback of `activeId`: revert to `restoreTo` ONLY if the current `activeId`
 * still equals `expected` (what the failed op set). If a later op already changed it, this is a no-op,
 * so a stale rollback can never clobber a newer selection (the P2-2 clobber guard, belt-and-suspenders
 * with the mutex).
 */
async function rollbackActiveId(
  deps: ModelActionDeps,
  opts: { expected: string | undefined; restoreTo: string | undefined; failedMessage: (rolledBack: boolean) => string },
): Promise<ModelActionResult> {
  const { state, persisted } = await deps.mutate((current) =>
    current.activeId === opts.expected ? { ...current, activeId: opts.restoreTo } : current,
  );
  return { kind: 'rolled-back', state, message: opts.failedMessage(persisted) };
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
