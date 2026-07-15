// Download + integrity-check a GGUF model file into this app's private storage (docs/06 model
// manager). Uses the `expo-file-system/legacy` resumable-download API — SDK 57 moved the classic
// `createDownloadResumable`/`getFreeDiskStorageAsync`/`documentDirectory` surface under
// `expo-file-system/legacy` (the new default export is a different `File`/`Directory` API); the
// legacy surface is still first-class and is what this module needs (resumability + a progress
// callback).
import * as FileSystem from 'expo-file-system/legacy';
import { sha256 } from 'js-sha256';

/** Where downloaded model files live — inside this app's own sandboxed document directory. */
export const MODELS_DIR = `${FileSystem.documentDirectory}models/`;

export async function ensureModelsDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(MODELS_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(MODELS_DIR, { intermediates: true });
  }
}

export type DownloadProgressCallback = (writtenBytes: number, totalBytes: number) => void;
/** Hashing is a distinct, slower phase after the download completes (P2-4/AF7) — GB-scale files take
 * real wall-clock time to stream through the hasher, so the UI needs its own progress signal rather
 * than looking hung between "download done" and "verified". */
export type HashProgressCallback = (hashedBytes: number, totalBytes: number) => void;

export type DownloadOutcome = { ok: true; uri: string; sizeBytes: number } | { ok: false; error: string };

/**
 * Reject (rather than silently mangle) any candidate model file name that isn't a plain basename.
 * `name` is expected to already be decoded (e.g. via `decodeURIComponent`) — this is the LAST line of
 * defense before it's concatenated into `${MODELS_DIR}${fileName}`, so it rejects `/`, `\`, and `..`
 * outright rather than trying to strip them (stripping could still leave a crafted name that
 * reassembles into a traversal once combined with the caller's own prefix/suffix). Returns the
 * trimmed name, or `null` when unsafe or empty — callers must refuse the operation on `null`, never
 * fall back to a default silently.
 */
export function sanitizeModelFileName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed || trimmed === '.' || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
    return null;
  }
  return trimmed;
}

/**
 * Defense in depth for `downloadModel` below: independent of any caller-side sanitization, verify the
 * resolved destination path still lands inside `MODELS_DIR` before anything is written there. Manually
 * resolves `.`/`..` segments (no Node `path` module available in this RN runtime) rather than trusting
 * a string-prefix check alone, which a crafted `..`-laden name could otherwise defeat.
 */
function isWithinModelsDir(uri: string): boolean {
  if (!uri.startsWith(MODELS_DIR)) {
    return false;
  }
  const resolved: string[] = [];
  for (const segment of uri.slice(MODELS_DIR.length).split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (resolved.length === 0) {
        return false; // would escape MODELS_DIR
      }
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  return resolved.length > 0;
}

/**
 * Download `url` into `<MODELS_DIR><fileName>` and verify the result.
 *
 * `fileName` MUST already be a sanitized basename (see `sanitizeModelFileName`) — this function also
 * independently re-verifies the resolved path never escapes `MODELS_DIR` (defense in depth; see
 * `isWithinModelsDir`) before writing anything, and refuses the download otherwise.
 *
 * Integrity check order:
 *   1. Exact byte size against `expectedSizeBytes` — cheap, always run, and the primary check. Catches
 *      truncated downloads and "the upstream file silently changed" just as well as a hash would.
 *   2. SHA-256 against `expectedSha256` — a real STREAMING check now (P2-4/AF7: it used to be capped at
 *      100MB and every catalog GGUF was far above that, so it never actually ran for a shipped model —
 *      see model-catalog.ts's `sha256` doc comment for that history). `expectedSha256` is only ever
 *      passed for CURATED catalog entries (see model-manager.tsx — a pasted custom URL always passes
 *      `undefined` here, since there's nothing to pin it against), so whenever it's present this now
 *      FAILS CLOSED: a mismatch, or a hashing failure of any kind (I/O error, OOM, etc.), deletes the
 *      file and rejects the download — never silently falls back to "size-check was enough". A custom
 *      URL with no pin gets exactly the same best-effort treatment as before (size + TLS only), plus the
 *      explicit "unverified" warning the model-manager UI already shows for it.
 *
 * Either a fresh `createDownloadResumable` failure or a failed verification deletes the partial/bad
 * file before returning, so a rejected download never leaves junk behind.
 */
export async function downloadModel(
  url: string,
  fileName: string,
  expectedSizeBytes: number | undefined,
  expectedSha256: string | undefined,
  onProgress: DownloadProgressCallback,
  onHashProgress?: HashProgressCallback,
): Promise<DownloadOutcome> {
  await ensureModelsDir();
  const destUri = `${MODELS_DIR}${fileName}`;
  if (!isWithinModelsDir(destUri)) {
    return { ok: false, error: 'Refusing to download: the resolved file name would escape the models directory.' };
  }

  const resumable = FileSystem.createDownloadResumable(url, destUri, {}, (data) => {
    onProgress(data.totalBytesWritten, data.totalBytesExpectedToWrite);
  });

  let result: Awaited<ReturnType<typeof resumable.downloadAsync>>;
  try {
    result = await resumable.downloadAsync();
  } catch (error) {
    await safeDelete(destUri);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!result) {
    await safeDelete(destUri);
    return { ok: false, error: 'The download was cancelled.' };
  }
  if (result.status >= 400) {
    await safeDelete(destUri);
    return { ok: false, error: `Server returned HTTP ${result.status}.` };
  }

  // `size` is always present on an existing-file result — no option needed to request it.
  const info = await FileSystem.getInfoAsync(destUri);
  if (!info.exists || info.isDirectory) {
    return { ok: false, error: 'The downloaded file is missing.' };
  }
  const sizeBytes = info.size;

  if (expectedSizeBytes !== undefined && sizeBytes !== expectedSizeBytes) {
    await safeDelete(destUri);
    return {
      ok: false,
      error:
        `Downloaded file size (${sizeBytes} bytes) doesn't match the expected ${expectedSizeBytes} ` +
        'bytes — the download may be truncated, or the upstream file changed.',
    };
  }

  if (expectedSha256) {
    // FAIL CLOSED (P2-4/AF7): `expectedSha256` only ever arrives here for a curated catalog entry
    // (see this function's doc comment) — a mismatch OR a hashing failure both delete the file and
    // reject the download, never a silent fall-through to "the size check already passed".
    let hashOk: boolean;
    try {
      hashOk = await verifySha256Streaming(destUri, expectedSha256, sizeBytes, onHashProgress);
    } catch {
      hashOk = false;
    }
    if (!hashOk) {
      await safeDelete(destUri);
      return {
        ok: false,
        error: 'SHA-256 checksum did not match (or could not be verified) — the file was deleted.',
      };
    }
  }

  return { ok: true, uri: destUri, sizeBytes };
}

export async function deleteModelFile(uri: string): Promise<void> {
  await safeDelete(uri);
}

async function safeDelete(uri: string): Promise<void> {
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    // best-effort
  }
}

// ---- streaming SHA-256 (P2-4/AF7) -----------------------------------------------------------------
// Reading a multi-hundred-MB-to-multi-GB file into a single base64 string/byte array (the old
// approach) risks exhausting heap or wedging the JS thread for a long time on a phone — GGUF models
// here run 700MB-4.5GB. This reads the file in fixed-size chunks (via `readAsStringAsync`'s
// `position`/`length` options, base64-encoded) and feeds each chunk into an INCREMENTAL js-sha256
// hasher (`sha256.create()` + repeated `.update()`), so at most one chunk is ever held in memory at
// once regardless of total file size — this is what actually makes verification runnable for every
// catalog entry today, not just a future smaller model.
const HASH_CHUNK_BYTES = 8 * 1024 * 1024; // 8MB per chunk — small enough to keep peak memory low,
// large enough that a multi-GB file doesn't need thousands of round trips through the bridge.

/** Stream-hash `uri` and compare against `expectedHex`. Throws on any I/O error (deliberately — see
 * `downloadModel`'s FAIL CLOSED handling above; this function does NOT swallow errors into a
 * `false`/`undefined` return the way the old best-effort version did). */
async function verifySha256Streaming(
  uri: string,
  expectedHex: string,
  sizeBytes: number,
  onProgress?: HashProgressCallback,
): Promise<boolean> {
  const hasher = sha256.create();
  let position = 0;
  while (position < sizeBytes) {
    const length = Math.min(HASH_CHUNK_BYTES, sizeBytes - position);
    // Deliberately sequential (not Promise.all'd) — the whole point is one chunk in memory at a time.
    const base64Chunk = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
      position,
      length,
    });
    hasher.update(base64ToBytes(base64Chunk));
    position += length;
    onProgress?.(position, sizeBytes);
  }
  return hasher.hex() === expectedHex.toLowerCase();
}

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Manual base64 → bytes decoder (avoids relying on `atob`, which isn't guaranteed under Hermes). */
function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const clean = base64.replace(/[^A-Za-z0-9+/]/g, '');
  const byteLength = Math.floor((clean.length * 6) / 8);
  const bytes = new Uint8Array(byteLength);
  let bitBuffer = 0;
  let bitCount = 0;
  let byteIndex = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const value = BASE64_CHARS.indexOf(clean[i]);
    if (value === -1) {
      continue;
    }
    bitBuffer = (bitBuffer << 6) | value;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes[byteIndex] = (bitBuffer >> bitCount) & 0xff;
      byteIndex += 1;
    }
  }
  return bytes;
}
