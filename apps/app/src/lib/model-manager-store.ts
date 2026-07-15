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

export type ModelManagerState = {
  downloaded: DownloadedModel[];
  /** id of the model currently pushed to `llm.onDevice` (see model-manager-bridge.ts), if any. */
  activeId?: string;
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
 * Strict validity check (P2-6 round 4): a state is VALID only if it parses to an object carrying a
 * `downloaded` array. Before this fix, `tryReadState` ran EVERY parsed value — including `null`, `{}`,
 * or any other truncated/wrong-shape write — through `normalizeState`, which silently mapped all of
 * those to `EMPTY_STATE`. That made a corrupt file indistinguishable from "legitimately nothing has
 * been downloaded yet", which broke the two-slot recovery scheme in both directions:
 *   1. `loadModelManagerState` treated a corrupt primary as a valid (if boring) result and never fell
 *      through to a possibly-good `.bak`.
 *   2. `saveModelManagerState` then saw that corrupt primary as "exists, so rotate it into `.bak`" on
 *      the very next save — overwriting the last genuinely good backup with garbage. A crash right
 *      after that left BOTH slots bad, with no way back to the real data.
 * A legitimately-empty state is instead the EXPLICIT `EMPTY_STATE` value above, written out like any
 * other state, so "empty" and "invalid" are never conflated.
 */
function isValidState(value: unknown): value is { downloaded: unknown[]; activeId?: unknown } {
  return !!value && typeof value === 'object' && Array.isArray((value as { downloaded?: unknown }).downloaded);
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
      // Parseable but the wrong shape (null, `{}`, missing `downloaded`, ...) — treated the same as an
      // unparsable/missing file, NOT as a legitimate empty state (P2-6 round 4). The caller falls back
      // to the other slot instead of silently accepting this as "nothing downloaded".
      return undefined;
    }
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
  const record = value as { downloaded?: unknown; activeId?: unknown };
  const downloaded = Array.isArray(record.downloaded) ? record.downloaded.filter(isDownloadedModel) : [];
  const activeId = typeof record.activeId === 'string' ? record.activeId : undefined;
  return { downloaded, activeId };
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
