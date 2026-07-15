// Local persistence for the on-device model manager: which GGUF files have been downloaded (catalog
// picks + pasted-URL customs) and which one is active. Lives entirely in this app's own Expo sandbox
// (`documentDirectory`) — independent of the embedded Node process's own data dir (see
// `model-manager-bridge.ts` for why those two storage areas are deliberately kept separate). A plain
// JSON file is enough here (small, infrequently written); no AsyncStorage dependency needed.
import * as FileSystem from 'expo-file-system/legacy';

export type DownloadedModel = {
  /** Catalog id for a curated pick, or a generated id for a pasted-URL custom model. */
  id: string;
  displayName: string;
  /** Absolute `file://` URI where the GGUF lives on-device. */
  uri: string;
  sizeBytes: number;
  sha256?: string;
  isCustom: boolean;
  sourceUrl: string;
  downloadedAt: number;
};

/** The launcher-facing intent of a pending action — the state config.json should converge to once the
 * bridge write is finally confirmed. `enabled:true` carries the `modelPath` (+ cosmetic `model` label)
 * to (re)activate; `enabled:false` is a cleared pointer. */
export type PendingDesiredState = { enabled: boolean; modelPath?: string; model?: string };

/**
 * A durable record of a bridge write that resolved AMBIGUOUS (timed out after every idempotent retry —
 * see model-manager-bridge.ts): the launcher never confirmed it, so RN-local state may be ahead of the
 * launcher's config.json. Persisted in `model-manager-store.json` (P2-b) so it can be RE-SENT and
 * settled on the next manager-open / app restart — the round-5 "reconciled next time" promise was
 * previously never backed by any code. `kind`:
 *   - `'setActive'` — re-send `setActiveModel(desired.modelPath, desired.model)`.
 *   - `'clear'`     — re-send `clearActiveModel()`.
 *   - `'delete'`    — re-send `clearActiveModel()`, then (only once CONFIRMED `ok`) delete `fileUri`'s
 *                     bytes. Until then `fileUri` is a do-not-sweep reference so the orphan sweep can't
 *                     remove a `.gguf` the launcher might still point at (the dangling-pointer bug).
 */
export type PendingAction = {
  id: string;
  kind: 'setActive' | 'clear' | 'delete';
  desired: PendingDesiredState;
  /** For a `'delete'`: the GGUF whose bytes must be kept until the launcher clear is confirmed. */
  fileUri?: string;
};

/** Stable id for the single "launcher active-pointer" intent (`setActive`/`clear` are mutually
 * exclusive — the newest supersedes the older). A `'delete'` is keyed per file instead. */
export const POINTER_PENDING_ID = 'launcher-active-pointer';

export type ModelManagerState = {
  downloaded: DownloadedModel[];
  /** id of the model currently pushed to `llm.onDevice` (see model-manager-bridge.ts), if any. */
  activeId?: string;
  /** Durable, unconfirmed bridge writes awaiting reconciliation (P2-b). Absent/empty when nothing is
   * pending — the common case, kept off the persisted shape so a settled state round-trips unchanged. */
  pending?: PendingAction[];
};

const STATE_PATH = `${FileSystem.documentDirectory}loam-model-manager.json`;
/** Backup slot used by `saveModelManagerState`'s two-slot scheme (P2-1 round-3 fix, tightened by the
 * P2-6 round-4 fix below) — see there. */
const BAK_PATH = `${STATE_PATH}.bak`;

/** The one legitimately-empty state. Always written out explicitly (never synthesized from invalid
 * input — see `isValidState`), so it round-trips through the same validity check as any other state. */
const EMPTY_STATE: ModelManagerState = { downloaded: [], activeId: undefined };

/**
 * Load the persisted manager state. Never throws. Falls back from `STATE_PATH` to the `.bak` backup
 * slot (P2-1 round-3 fix) when the primary file is missing, unparsable, or structurally INVALID (P2-6
 * round-4 fix — see `isValidState`) — `saveModelManagerState` guarantees ONE of the two always holds a
 * complete, valid file once anything has ever saved successfully, so only genuinely never having saved
 * at all, or having BOTH slots simultaneously invalid, yields `EMPTY_STATE`.
 */
export async function loadModelManagerState(): Promise<ModelManagerState> {
  const primary = await tryReadState(STATE_PATH);
  if (primary) {
    return primary;
  }
  const backup = await tryReadState(BAK_PATH);
  return backup ?? EMPTY_STATE;
}

/**
 * Strict, DEEP validity check (P2-6 round 4, tightened P2-3 round 5): a state is VALID only if it
 * parses to an object whose `downloaded` is an array in which EVERY entry is a well-formed
 * `DownloadedModel`, AND whose `activeId` is either `undefined` or a string that references one of
 * those entries. Anything else — a missing/wrong-typed `downloaded`, a single malformed entry, a
 * non-string `activeId`, or a dangling `activeId` that names no downloaded model — is INVALID.
 *
 * Why the earlier "downloaded is an array" check was not enough (P2-3): `{"downloaded":[{}]}` passed
 * that shallow test, so `tryReadState` accepted the slot and ran it through the lossy `normalizeState`,
 * which silently DROPPED the malformed entry and returned an empty state. That made a corrupt file
 * indistinguishable from "legitimately nothing has been downloaded yet", which broke the two-slot
 * recovery scheme in both directions:
 *   1. `loadModelManagerState` treated a corrupt primary as a valid (if empty) result and never fell
 *      through to a possibly-good `.bak`.
 *   2. `saveModelManagerState` then saw that corrupt primary as valid ("exists + parses, so rotate it
 *      into `.bak`") on the very next save — overwriting the last genuinely good backup with garbage.
 *      A crash right after that left BOTH slots bad, with no way back to the real data.
 * Validating every entry (and the `activeId` reference) BEFORE accepting a slot — never using
 * `normalizeState` to DECIDE validity — closes both. A legitimately-empty state is instead the
 * EXPLICIT `EMPTY_STATE` value above (`{ downloaded: [], activeId: undefined }`), which passes this
 * check unchanged, so "empty" and "invalid" are never conflated.
 */
function isValidState(value: unknown): value is ModelManagerState {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as { downloaded?: unknown; activeId?: unknown; pending?: unknown };
  if (!Array.isArray(record.downloaded) || !record.downloaded.every(isDownloadedModel)) {
    return false;
  }
  if (record.activeId !== undefined) {
    if (typeof record.activeId !== 'string') {
      return false;
    }
    // A dangling `activeId` (references no downloaded entry) is corrupt, not just cosmetically stale:
    // fall through to the backup rather than silently normalizing it away.
    if (!record.downloaded.some((entry) => (entry as DownloadedModel).id === record.activeId)) {
      return false;
    }
  }
  // Pending actions (P2-b) get the same strict, entry-by-entry validation as `downloaded`: a
  // missing/wrong-typed `pending`, or a single malformed pending entry, makes the whole slot INVALID
  // so `loadModelManagerState` falls through to a good `.bak` rather than silently dropping (and thus
  // never reconciling) an unconfirmed launcher write. `pending` absent is fine (the settled state).
  if (record.pending !== undefined && (!Array.isArray(record.pending) || !record.pending.every(isPendingAction))) {
    return false;
  }
  return true;
}

async function tryReadState(path: string): Promise<ModelManagerState | undefined> {
  try {
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) {
      return undefined;
    }
    const raw = await FileSystem.readAsStringAsync(path);
    const parsed: unknown = JSON.parse(raw);
    if (!isValidState(parsed)) {
      // Parseable but structurally corrupt (null, `{}`, missing/wrong `downloaded`, a malformed entry,
      // a bad-typed or dangling `activeId`, ...) — treated the same as an unparsable/missing file, NOT
      // as a legitimate empty state (P2-6 round 4 / P2-3 round 5). The caller falls back to the other
      // slot instead of silently accepting this as "nothing downloaded".
      return undefined;
    }
    // `parsed` is fully validated now; `normalizeState` is a lossless identity for a valid state (every
    // entry already passes `isDownloadedModel`, and `activeId` references a real entry), producing a
    // clean `ModelManagerState` without trusting arbitrary extra keys.
    return normalizeState(parsed);
  } catch {
    return undefined;
  }
}

/**
 * Persist the manager state RECOVERABLY (P2-1 round-3 fix). `expo-file-system/legacy` has no single
 * primitive on this SDK that atomically overwrites an existing destination on every platform
 * (`moveAsync` can fail when the target already exists), so the PREVIOUS version of this function
 * wrote a temp file, then DELETED `STATE_PATH`, then moved the temp file into place — which has a
 * window, between the delete and the move, where NEITHER the old nor the new file exists. A
 * crash/kill/move-failure landing in that window left `loadModelManagerState` finding nothing and
 * silently returning `EMPTY_STATE`: real data loss (every downloaded model "disappearing"), directly
 * contradicting the "readers always see old or new complete file" guarantee that version's comment
 * claimed.
 *
 * This version uses a two-slot backup scheme instead: write the new content to a temp file, move the
 * CURRENT `STATE_PATH` (if one exists) to the `.bak` slot, move the temp file into `STATE_PATH`, then
 * delete `.bak` only once the new file is confirmed in place. At every point in that sequence, EITHER
 * `STATE_PATH` or `BAK_PATH` (often both) holds a complete file — `loadModelManagerState` above falls
 * back to `.bak` whenever `STATE_PATH` is missing or fails to parse. So the real guarantee this
 * provides is: a reader always sees either the fully-new state or the last state that was fully
 * persisted before this call — never nothing, regardless of where a crash/kill lands.
 *
 * Returns whether the write actually landed. Callers MUST check this (see `mutateModelManagerState`
 * below) — silently reporting success on a failed persist is exactly the kind of bug that made P2-4
 * possible in the first place (an operator sees "model set active" when the change never made it to
 * disk).
 *
 * P2-6 round-4 fix: the previous version rotated whatever was at `STATE_PATH` into `.bak`
 * unconditionally, just because it existed. That's unsafe — if the primary was already CORRUPT (from
 * an earlier interrupted write) but `.bak` still held a valid backup, this would clobber the valid
 * `.bak` with the corrupt primary. A crash between that rotation and the next step then left BOTH
 * slots bad, with the previously-recoverable good copy gone for good. Now the current primary is
 * validated FIRST: only a genuinely valid primary gets rotated into `.bak` (replacing whatever was
 * there — it's newer and known-good); an invalid/corrupt primary is discarded outright, and any
 * existing `.bak` is left untouched as the last-known-good fallback.
 */
export async function saveModelManagerState(state: ModelManagerState): Promise<boolean> {
  const tmpPath = `${STATE_PATH}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await FileSystem.writeAsStringAsync(tmpPath, JSON.stringify(state));

    const existingInfo = await FileSystem.getInfoAsync(STATE_PATH);
    if (existingInfo.exists) {
      // Validate before rotating (P2-6 round 4) — see the doc comment above for why this can't be a
      // blind "it exists, so back it up" any more.
      const existingIsValid = (await tryReadState(STATE_PATH)) !== undefined;
      if (existingIsValid) {
        // The current primary is good: back it up before touching it. If the process dies anywhere
        // from here through the next move, `STATE_PATH` may be briefly absent, but `.bak` already
        // holds the complete old file, so `loadModelManagerState` never comes up empty.
        await FileSystem.deleteAsync(BAK_PATH, { idempotent: true });
        await FileSystem.moveAsync({ from: STATE_PATH, to: BAK_PATH });
      } else {
        // The current primary is corrupt/invalid: discard it rather than rotating it into `.bak` —
        // doing so would destroy whatever good backup is already sitting there. Leave `.bak` (if any)
        // exactly as it is; it's still the best available fallback until the write below lands.
        await FileSystem.deleteAsync(STATE_PATH, { idempotent: true });
      }
    }

    // `STATE_PATH` is now guaranteed absent (either just backed up, discarded as corrupt, or never
    // existed), so this move has nothing to overwrite and can't hit the same "destination already
    // exists" failure mode the old delete-then-move dance was working around.
    await FileSystem.moveAsync({ from: tmpPath, to: STATE_PATH });

    // Best-effort cleanup — once the new primary is confirmed in place (we just wrote it ourselves, so
    // it's valid), `.bak` is redundant regardless of which branch above ran: `loadModelManagerState`
    // only ever consults `.bak` when `STATE_PATH` is missing/invalid, and it no longer is.
    await FileSystem.deleteAsync(BAK_PATH, { idempotent: true }).catch(() => undefined);
    return true;
  } catch {
    await FileSystem.deleteAsync(tmpPath, { idempotent: true }).catch(() => undefined);
    return false;
  }
}

/**
 * Serialized read-modify-write queue for the manager state (P2-4): each call reloads the CURRENT
 * persisted state, applies `mutate` on top of it, and persists the result — chained through this
 * module-level promise so concurrent callers (e.g. two catalog downloads finishing back-to-back) can
 * never each build their next state from a snapshot captured back when their own async download
 * started. Before this, the LAST completion's `{...staleManagerState, downloaded: [...]}` merge would
 * silently overwrite whatever an earlier-starting, later-finishing download had just persisted — the
 * mutation queue below is what actually fixes that, not just the atomic write.
 *
 * Every caller in `model-manager.tsx` should go through this instead of composing
 * `loadModelManagerState`/`saveModelManagerState` with locally-held React state.
 */
let mutationChain: Promise<unknown> = Promise.resolve();

export type MutateResult = { state: ModelManagerState; persisted: boolean };

export function mutateModelManagerState(
  mutate: (current: ModelManagerState) => ModelManagerState,
): Promise<MutateResult> {
  const run = mutationChain.then(async (): Promise<MutateResult> => {
    const current = await loadModelManagerState();
    const next = mutate(current);
    const persisted = await saveModelManagerState(next);
    return { state: next, persisted };
  });
  // Keep the chain alive regardless of outcome — a rejected mutation must not wedge every later one
  // behind a permanently-broken promise.
  mutationChain = run.catch(() => undefined);
  return run;
}

function normalizeState(value: unknown): ModelManagerState {
  if (!value || typeof value !== 'object') {
    return EMPTY_STATE;
  }
  const record = value as { downloaded?: unknown; activeId?: unknown; pending?: unknown };
  const downloaded = Array.isArray(record.downloaded) ? record.downloaded.filter(isDownloadedModel) : [];
  const activeId = typeof record.activeId === 'string' ? record.activeId : undefined;
  const pending = Array.isArray(record.pending) ? record.pending.filter(isPendingAction) : [];
  // Keep the persisted shape minimal: only carry `pending` when there's actually something unconfirmed,
  // so a fully-settled state round-trips as `{ downloaded, activeId }` (matching EMPTY_STATE and the
  // pre-P2-b shape) rather than growing an always-`[]` key.
  return pending.length > 0 ? { downloaded, activeId, pending } : { downloaded, activeId };
}

/**
 * Strict validator for a single `PendingAction` (P2-b), mirroring `isDownloadedModel`: a well-formed
 * `id`/`kind`/`desired`, with the kind-specific invariants that reconciliation relies on — a
 * `'setActive'` MUST carry an enabled `desired.modelPath`, a `'clear'` MUST be `enabled:false`, and a
 * `'delete'` MUST carry a `fileUri` (the bytes to reclaim once its clear is confirmed).
 */
function isPendingAction(value: unknown): value is PendingAction {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as { id?: unknown; kind?: unknown; desired?: unknown; fileUri?: unknown };
  if (typeof record.id !== 'string') {
    return false;
  }
  if (record.kind !== 'setActive' && record.kind !== 'clear' && record.kind !== 'delete') {
    return false;
  }
  if (record.fileUri !== undefined && typeof record.fileUri !== 'string') {
    return false;
  }
  if (!record.desired || typeof record.desired !== 'object') {
    return false;
  }
  const desired = record.desired as { enabled?: unknown; modelPath?: unknown; model?: unknown };
  if (typeof desired.enabled !== 'boolean') {
    return false;
  }
  if (desired.modelPath !== undefined && typeof desired.modelPath !== 'string') {
    return false;
  }
  if (desired.model !== undefined && typeof desired.model !== 'string') {
    return false;
  }
  if (record.kind === 'setActive' && (desired.enabled !== true || typeof desired.modelPath !== 'string')) {
    return false;
  }
  if (record.kind === 'clear' && desired.enabled !== false) {
    return false;
  }
  if (record.kind === 'delete' && typeof record.fileUri !== 'string') {
    return false;
  }
  return true;
}

/**
 * Add `action` to `pending`, superseding any stale entry it replaces (P2-b). Two supersede rules:
 *   - same `id` — a newer intent for the same target replaces the older (idempotent re-record).
 *   - a new pointer action (`setActive`/`clear`, id `POINTER_PENDING_ID`) OR a `'delete'` (which also
 *     clears the launcher pointer to its file) drops any existing pointer pending, since the launcher
 *     has a single active-model pointer and the newest intent is authoritative.
 * Per-file `'delete'` entries are otherwise independent and accumulate.
 */
export function recordPending(pending: PendingAction[] | undefined, action: PendingAction): PendingAction[] {
  const base = (pending ?? []).filter((existing) => existing.id !== action.id);
  const withoutStalePointer =
    action.id === POINTER_PENDING_ID || action.kind === 'delete'
      ? base.filter((existing) => existing.id !== POINTER_PENDING_ID)
      : base;
  return [...withoutStalePointer, action];
}

/**
 * The set of on-disk `.gguf` uris a pending set still references, and which the orphan sweep must
 * therefore NOT delete (P2-b): a `'delete'`'s `fileUri` (bytes kept until its clear is confirmed) and a
 * `'setActive'`'s `desired.modelPath` (the file being activated). A `'clear'` references no file.
 */
export function pendingProtectedUris(pending: PendingAction[] | undefined): string[] {
  const uris: string[] = [];
  for (const action of pending ?? []) {
    if (action.kind === 'delete' && action.fileUri) {
      uris.push(action.fileUri);
    } else if (action.kind === 'setActive' && action.desired.modelPath) {
      uris.push(action.desired.modelPath);
    }
  }
  return uris;
}

function isDownloadedModel(value: unknown): value is DownloadedModel {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.displayName === 'string' &&
    typeof record.uri === 'string' &&
    typeof record.sizeBytes === 'number' &&
    typeof record.isCustom === 'boolean' &&
    typeof record.sourceUrl === 'string' &&
    typeof record.downloadedAt === 'number' &&
    (record.sha256 === undefined || typeof record.sha256 === 'string')
  );
}
