// Download + integrity-check a GGUF model file into this app's private storage (docs/06 model
// manager). Uses the `expo-file-system/legacy` resumable-download API — SDK 57 moved the classic
// `createDownloadResumable`/`getFreeDiskStorageAsync`/`documentDirectory` surface under
// `expo-file-system/legacy` (the new default export is a different `File`/`Directory` API); the
// legacy surface is still first-class and is what this module needs (resumability + a progress
// callback).
import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';

/** Where downloaded model files live — inside this app's own sandboxed document directory. */
export const MODELS_DIR = `${FileSystem.documentDirectory}models/`;

export async function ensureModelsDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(MODELS_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(MODELS_DIR, { intermediates: true });
  }
}

export type DownloadProgressCallback = (writtenBytes: number, totalBytes: number) => void;

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
 *   2. SHA-256 against `expectedSha256` — best-effort only, and only attempted when the file is small
 *      enough to safely hash in RN JS (see `verifySha256BestEffort`). Every catalog GGUF is far above
 *      that cap, so this step is effectively inert today (see model-catalog.ts's `sha256` doc comment)
 *      — size-check + TLS are the real integrity story today; the hashing plumbing exists for smaller
 *      future models.
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
    const hashOk = await verifySha256BestEffort(destUri, expectedSha256, sizeBytes);
    if (hashOk === false) {
      await safeDelete(destUri);
      return { ok: false, error: 'SHA-256 checksum did not match — the file may be corrupted.' };
    }
    // hashOk === undefined: skipped (file too large to hash safely in RN JS) — the size check above
    // already ran and passed, which is the primary integrity signal for files this large.
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

// ---- best-effort SHA-256 ------------------------------------------------------------------------
// Hashing a multi-hundred-MB file in RN JS means reading the whole thing into a base64 string and
// then a byte array — expensive in both time and memory, and risky on a phone (GGUF models here run
// 700MB–4.5GB; a JS string/array that size can exhaust heap or wedge the JS thread for a long time).
// So this is capped: above MAX_HASHABLE_BYTES, hashing is skipped entirely and the exact-size check
// above is relied on as the primary integrity signal. None of the current catalog entries land under
// the cap — this exists so a future smaller/pinned model still gets a real hash check.
const MAX_HASHABLE_BYTES = 100 * 1024 * 1024; // 100MB

/** Returns `true`/`false` for a completed comparison, or `undefined` when hashing was skipped/failed. */
async function verifySha256BestEffort(
  uri: string,
  expectedHex: string,
  sizeBytes: number,
): Promise<boolean | undefined> {
  if (sizeBytes > MAX_HASHABLE_BYTES) {
    return undefined;
  }
  try {
    const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
    const bytes = base64ToBytes(base64);
    const digestBuffer = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes);
    const hex = bytesToHex(new Uint8Array(digestBuffer));
    return hex === expectedHex.toLowerCase();
  } catch {
    return undefined; // an environmental hashing failure shouldn't fail a download the size check passed
  }
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

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}
