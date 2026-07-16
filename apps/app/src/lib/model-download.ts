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

/** Suffix for an in-progress download's on-disk name (P2-7 round 4) — see `downloadModel`'s doc
 * comment for why this exists, and `sweepOrphanedModelFiles` for the matching sweep-side handling. */
const PARTIAL_SUFFIX = '.partial';

/**
 * Download `url` into `<MODELS_DIR><fileName>` (via a `.partial`-suffixed staging name) and verify the
 * result.
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
 * `.partial` staging (P2-7 round 4): the file lives at `<fileName>.partial` for the ENTIRE download +
 * verify, and is only renamed to its final `<fileName>` once every check above has passed. Before this
 * the file was written directly to its final name for the whole duration, which meant
 * `sweepOrphanedModelFiles` — run on first overlay open to reclaim orphans from a killed-mid-verify
 * process — could delete a download that was *currently in progress this session*: its destination
 * isn't yet in the `referencedUris` list (registration only happens after this function returns
 * `ok: true`), so the sweep's "unreferenced -> delete" logic couldn't tell it apart from an actual
 * orphan. `.partial` files are categorically exempt from that logic now (see
 * `sweepOrphanedModelFiles`), independent of the ALSO-fixed race in `model-manager.tsx` (the initial
 * sweep is now awaited before download controls are enabled) — either fix alone closes the race.
 *
 * Either a fresh `createDownloadResumable` failure or a failed verification deletes the partial/bad
 * file before returning, so a rejected download never leaves junk behind.
 *
 * `signal` (optional) makes both phases CANCELLABLE (Sol's hash-performance/device-gate note): abort
 * it to stop an in-flight download outright, or to break out of the streaming hash loop between
 * chunks. Either way the outcome is treated exactly like a checksum mismatch — fail closed, delete
 * whatever bytes are on disk, return `ok: false` — so a cancel (e.g. the app being backgrounded mid-
 * verify, see `model-manager.tsx`) can never leave a partially-hashed file registered as valid. A hard
 * process kill has no JS-level hook at all; that case is instead made safe by construction, since
 * `model-manager.tsx` only ever registers a model in `model-manager-store.json` AFTER this function
 * returns `ok: true` — a killed-mid-verify run leaves an unregistered `.partial` orphan, never a
 * "half-registered" final file (see `sweepOrphanedModelFiles` below, which age-reclaims those).
 */
export async function downloadModel(
  url: string,
  fileName: string,
  expectedSizeBytes: number | undefined,
  expectedSha256: string | undefined,
  onProgress: DownloadProgressCallback,
  onHashProgress?: HashProgressCallback,
  signal?: AbortSignal,
): Promise<DownloadOutcome> {
  await ensureModelsDir();
  const finalUri = `${MODELS_DIR}${fileName}`;
  const destUri = `${finalUri}${PARTIAL_SUFFIX}`;
  if (!isWithinModelsDir(destUri) || !isWithinModelsDir(finalUri)) {
    return { ok: false, error: 'Refusing to download: the resolved file name would escape the models directory.' };
  }
  if (signal?.aborted) {
    return { ok: false, error: 'Cancelled before the download started.' };
  }

  const resumable = FileSystem.createDownloadResumable(url, destUri, {}, (data) => {
    onProgress(data.totalBytesWritten, data.totalBytesExpectedToWrite);
  });

  // Wire cancellation into the download phase: `resumable.downloadAsync()` otherwise has no way to
  // be interrupted early. `cancelAsync` makes `downloadAsync()` resolve with a falsy/undefined
  // result (handled by the `!result` branch below), same as any other cancellation.
  const onAbort = () => {
    resumable.cancelAsync().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort);

  let result: Awaited<ReturnType<typeof resumable.downloadAsync>>;
  try {
    result = await resumable.downloadAsync();
  } catch (error) {
    signal?.removeEventListener('abort', onAbort);
    await safeDelete(destUri);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  signal?.removeEventListener('abort', onAbort);
  if (!result || signal?.aborted) {
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
    // reject the download, never a silent fall-through to "the size check already passed". A cancel
    // via `signal` takes this same path (`verifySha256Streaming` returns `false` rather than throwing
    // when aborted, but it's handled identically either way).
    let hashOk: boolean;
    try {
      hashOk = await verifySha256Streaming(destUri, expectedSha256, sizeBytes, onHashProgress, signal);
    } catch {
      hashOk = false;
    }
    if (!hashOk) {
      await safeDelete(destUri);
      return {
        ok: false,
        error:
          signal?.aborted
            ? 'Verification was cancelled — the partial file was deleted.'
            : 'SHA-256 checksum did not match (or could not be verified) — the file was deleted.',
      };
    }
  }

  // Every check above passed — promote the verified `.partial` staging file to its final name. Only
  // from this point on does the file look like a normal registered model to `sweepOrphanedModelFiles`
  // (subject to the ordinary "unreferenced -> delete" check, same as any other final `.gguf`); that's
  // fine because `model-manager.tsx` registers it in `model-manager-store.json` immediately after this
  // returns `ok: true`.
  try {
    await FileSystem.deleteAsync(finalUri, { idempotent: true });
    await FileSystem.moveAsync({ from: destUri, to: finalUri });
  } catch (error) {
    await safeDelete(destUri);
    return {
      ok: false,
      error: `Verified download, but couldn't finalize the file (${error instanceof Error ? error.message : String(error)}).`,
    };
  }

  return { ok: true, uri: finalUri, sizeBytes };
}

/** A `.partial` staging file older than this is assumed abandoned by a killed/crashed process (P2-7
 * round 4). Nothing in a live session leaves a `.partial` sitting around this long without either
 * finishing (renamed away by `downloadModel`) or being aborted (deleted by it) — this is the
 * age/session-ownership stand-in `sweepOrphanedModelFiles` uses instead of ever treating a `.partial`
 * as "just another unreferenced file". Deliberately conservative (an hour, not a minute) so a slow
 * multi-GB download over a bad connection is never mistaken for an abandoned one. */
const STALE_PARTIAL_AGE_MS = 60 * 60 * 1000;

/**
 * Delete any unreferenced FINAL `.gguf` file inside `MODELS_DIR` (never a `.partial` staging file —
 * see below), plus any `.partial` old enough to be certainly abandoned. Cleans up an orphan left by a
 * download that finished writing bytes but was never registered in `model-manager-store.json` — most
 * notably a real process kill mid-verify, which (unlike an in-app-JS abort via `signal` in
 * `downloadModel`) has no hook this module can observe. Because registration only ever happens AFTER
 * `downloadModel` returns `ok: true` (at which point the file has already been renamed off its
 * `.partial` staging name — see there), an unreferenced FINAL file is by construction wasted storage,
 * never a "half-registered" model — this just reclaims the space.
 *
 * `.partial` files are handled separately and NEVER by the referenced-uris check (P2-7 round 4): a
 * download in progress THIS session has a destination that, by design, isn't in `referencedUris` yet
 * (it's only added to `model-manager-store.json` once the download finishes) — treating that the same
 * as an orphan is exactly the bug this split fixes (see `downloadModel`'s doc comment). Instead a
 * `.partial` is only ever reclaimed once it's old enough (`STALE_PARTIAL_AGE_MS`) that it cannot
 * possibly still be an in-flight download.
 *
 * `pendingReferencedUris` (P2-b) is a SECOND do-not-sweep set, for files a durable pending action still
 * references even though they're no longer in `referencedUris` (the `downloaded` list): most critically
 * a pending `'delete'`'s `fileUri`, whose bytes were deliberately kept because the launcher clear was
 * never confirmed. Sweeping such a file is exactly the dangling-pointer bug this guards against — the
 * launcher's config.json may STILL point at it. A pending `'setActive'`'s file is normally still in
 * `downloaded` too, but is included here for good measure. Bytes are only ever reclaimed once the
 * corresponding clear/activate is CONFIRMED (reconciliation drops the pending entry then).
 *
 * Best-effort: `model-manager.tsx` awaits this once per process lifetime, AFTER reconciling the pending
 * set and before enabling any download controls (so no `.partial` from *this* session can exist yet when
 * it runs) — see its call site. Any failure here is swallowed, since this is opportunistic cleanup, not a
 * correctness requirement.
 */
export async function sweepOrphanedModelFiles(
  referencedUris: readonly string[],
  pendingReferencedUris: readonly string[] = [],
): Promise<void> {
  try {
    const info = await FileSystem.getInfoAsync(MODELS_DIR);
    if (!info.exists) {
      return;
    }
    const referenced = new Set([...referencedUris, ...pendingReferencedUris]);
    const entries = await FileSystem.readDirectoryAsync(MODELS_DIR);
    const now = Date.now();
    await Promise.all(
      entries.map(async (name) => {
        const uri = `${MODELS_DIR}${name}`;
        if (name.endsWith(PARTIAL_SUFFIX)) {
          const fileInfo = await FileSystem.getInfoAsync(uri);
          if (fileInfo.exists && !fileInfo.isDirectory && now - fileInfo.modificationTime * 1000 > STALE_PARTIAL_AGE_MS) {
            await safeDelete(uri);
          }
          return;
        }
        if (!referenced.has(uri)) {
          await safeDelete(uri);
        }
      }),
    );
  } catch {
    // best-effort
  }
}

/**
 * CHECKED, strict deletion for an IRREVERSIBLE model-byte removal (Finding 1). Unlike `safeDelete`
 * below — which is deliberately best-effort and swallows EVERY error — this both PROPAGATES a
 * filesystem failure AND verifies the file is actually gone afterwards: a `deleteAsync` that resolves
 * while the bytes are still on disk (a driver quirk, a read-only mount, a stale handle) is treated as a
 * FAILURE and throws. Every caller that must not claim a model is "deleted" until its multi-GB GGUF is
 * genuinely reclaimed uses this — the delete transaction + reconciliation in `model-manager-actions.ts`
 * (which keep the durable delete-pending and retry on a throw) and the custom persist-failure cleanup in
 * `model-manager.tsx` (which retains the orphan URI and blocks another download until this succeeds). A
 * silent no-op delete can therefore never leave an orphan while the UI or the journal report success.
 *
 * Idempotent (`{ idempotent: true }` plus the post-delete existence check): deleting an already-absent
 * file succeeds cleanly, which is exactly what makes reconciliation safe to REPEAT after a crash that
 * lands between the byte deletion and clearing the journal — the second pass re-runs this no-op delete
 * and settles.
 */
export async function deleteModelFileChecked(uri: string): Promise<void> {
  await FileSystem.deleteAsync(uri, { idempotent: true });
  const info = await FileSystem.getInfoAsync(uri);
  if (info.exists) {
    throw new Error(`Failed to delete model file — ${uri} still exists after deletion.`);
  }
}

/** Best-effort deletion for GENUINELY discardable cleanup ONLY (Finding 1): failed/partial download
 * staging files and orphan-sweep reclaims, where a delete that can't complete is harmless (the file is
 * already unreferenced and will be retried by a later sweep). It swallows every error and never verifies
 * — so it must NEVER be used for a delete whose success anything reports or depends on. Those use the
 * CHECKED `deleteModelFileChecked` above. */
async function safeDelete(uri: string): Promise<void> {
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    // best-effort
  }
}

// ---- retained-orphan registry (Finding 2) ---------------------------------------------------------
// A download whose bytes landed on disk but then failed BOTH to register in the model list AND to be
// checked-deleted leaves a multi-GB orphan. Its URI is retained at MODULE level (survives the model-manager
// overlay unmounting/remounting — component state would lose it) so the NEXT download attempt cleans it
// FIRST and aborts if it still can't be removed, guaranteeing orphans never accumulate. This is a SET, not a
// scalar: a SECOND failed cleanup (catalog then custom, or two catalog rows before the guard is cleared)
// must not overwrite the first's URI and strand it. The per-process orphan sweep (`sweepOrphanedModelFiles`)
// only runs once at first open, so it can't catch an orphan created afterward — this registry is that
// safety net between sweeps, and the sweep remains the durable next-process backstop.

const retainedOrphanUris = new Set<string>();

/** Record a just-downloaded file whose registration AND checked cleanup both failed (Finding 2) so the next
 * download attempt re-attempts its deletion before starting. Prefer `discardUnregisteredDownload`, which
 * only retains after a cleanup actually fails; this is exposed for tests / direct callers. */
export function retainOrphanUri(uri: string): void {
  retainedOrphanUris.add(uri);
}

/** How many orphan URIs are currently retained — for tests/diagnostics only. */
export function retainedOrphanCount(): number {
  return retainedOrphanUris.size;
}

/**
 * Discard a just-downloaded file that couldn't be registered in the model list (Finding 2): CHECKED-delete
 * its bytes so no unreferenced final model accumulates. On success the file is gone and nothing is retained;
 * on a cleanup FAILURE the URI is retained in the module-level orphan set so the next download attempt
 * (`clearRetainedOrphans`) cleans it first. Never throws — returns whether the file was cleanly removed.
 */
export async function discardUnregisteredDownload(uri: string): Promise<{ removed: boolean; error?: string }> {
  try {
    await deleteModelFileChecked(uri);
    return { removed: true };
  } catch (err) {
    retainedOrphanUris.add(uri);
    return { removed: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Before ANY new download, atomically clean EVERY retained orphan (Finding 2): CHECKED-delete each, dropping
 * it from the set ONLY on confirmed deletion. Returns `{ ok: true }` once the set is empty; `{ ok: false }`
 * (with the first failure's message) if any orphan still can't be removed — the caller MUST abort the new
 * download so orphans can never accumulate. Idempotent and safe to call before every download.
 */
export async function clearRetainedOrphans(): Promise<{ ok: true } | { ok: false; error: string }> {
  let firstError: string | undefined;
  for (const uri of [...retainedOrphanUris]) {
    try {
      await deleteModelFileChecked(uri);
      retainedOrphanUris.delete(uri);
    } catch (err) {
      if (firstError === undefined) {
        firstError = err instanceof Error ? err.message : String(err);
      }
    }
  }
  return retainedOrphanUris.size === 0
    ? { ok: true }
    : { ok: false, error: firstError ?? 'a retained model file could not be removed' };
}

// ---- custom (pasted-URL) download validation & redaction (Finding 2) ------------------------------

/** The one trusted public host custom (pasted-URL) downloads are allowed to reach. The curated catalog
 * only ever uses `huggingface.co` (see model-catalog.ts), so this is the whole allowlist. */
export const CUSTOM_DOWNLOAD_ALLOWED_HOST = 'huggingface.co';

/**
 * Whether a pasted custom-URL host is on the allowlist. The previous approach — reject textual
 * loopback/link-local hosts — was NOT a real boundary: it was bypassed by the device's OWN LAN/hotspot
 * RFC1918 address (192.168.x.x, 10.x.x.x, 172.16/12), IPv6 ULA (fc00::/7), IPv4-mapped hex forms that
 * WHATWG URL normalization produces (`[::ffff:7f00:1]`), a public hostname that RESOLVES to a private
 * address (DNS rebinding), and a public URL that REDIRECTS to a local address (`createDownloadResumable`
 * follows redirects; validation only ever sees the original URL). The embedded server listens on
 * non-loopback interfaces, so any of those could aim a GET at `http://<device-lan-ip>/api/config` and
 * consume the one-time `firstUser` admin grant exactly like a loopback URL. The Expo downloader can't
 * enforce the final destination or redirect chain, so — per Sol's blessed fallback — we PIN custom
 * downloads to an explicit HTTPS allowlist of trusted model hosts instead. Redirect-to-local is then out
 * of scope because the initial host is a trusted public domain, not because we inspect the hops.
 *
 * Case-insensitive exact-or-subdomain match (`huggingface.co`, `cdn-lfs.huggingface.co`, …) using a
 * proper suffix check — never a bare `includes`, which `evil-huggingface.co` or
 * `huggingface.co.attacker.example` would slip past.
 */
export function isAllowedCustomDownloadHost(hostname: string): boolean {
  // URL.hostname keeps IPv6 in brackets (e.g. `[::1]`); strip them for a bare comparison. An IP literal
  // can never match a DNS host suffix, so this also rejects every raw-address form implicitly.
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === CUSTOM_DOWNLOAD_ALLOWED_HOST || host.endsWith(`.${CUSTOM_DOWNLOAD_ALLOWED_HOST}`);
}

/** Validated result of preparing a pasted custom-model URL (Finding 2). `downloadUrl` is the FULL
 * authorized URL to fetch with; `sourceUrl` is the REDACTED value to PERSIST (origin + pathname only —
 * never credentials or query); `displayName`/`fileName` are the sanitized on-disk name parts (`fileName`
 * has `.gguf` ensured, but NOT the per-download id prefix — the caller composes that). */
export type CustomModelUrlResult =
  | { ok: true; downloadUrl: string; sourceUrl: string; displayName: string; fileName: string }
  | { ok: false; error: string };

/**
 * Parse, authorize, and redact a user-pasted custom-model URL (Finding 2) — a PURE function extracted
 * out of `model-manager.tsx`'s async press handler so its edge cases are unit-testable (the component's
 * `.tsx` isn't mounted by the node-only vitest harness). Fixes two bugs the inline version had:
 *
 *   1. `decodeURIComponent` of the last path segment can THROW on a malformed percent-escape (a bare
 *      `%`, `%2`, …). Inline it sat OUTSIDE the URL-parse `try` inside a `try/finally`, so a
 *      syntactically valid URL like `https://huggingface.co/%` made the whole press handler reject with
 *      no useful status. Here it's wrapped and surfaces the same invalid-name message as any other bad
 *      name.
 *   2. Userinfo (`user:pass@host`) and a `?token=…` query both defeat the allowlist as a trust boundary
 *      and — worse — used to be PERSISTED verbatim as `sourceUrl` in the plain Expo JSON store, i.e.
 *      credentials/tokens at rest OUTSIDE SecureStore/SQLCipher. Userinfo is now REJECTED outright, and
 *      the persisted `sourceUrl` is reduced to `origin + pathname` (query + hash + any userinfo
 *      stripped). The FULL pasted URL is still returned as `downloadUrl` so the fetch itself is
 *      unaffected; `sourceUrl` isn't used for redownload, so redacting it is lossless.
 */
export function prepareCustomModelDownload(rawUrl: string): CustomModelUrlResult {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { ok: false, error: 'Enter a link to a .gguf model file.' };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "That doesn't look like a valid URL." };
  }
  // Require HTTPS AND an allowlisted host (see `isAllowedCustomDownloadHost`). `http:` is dropped
  // entirely for custom URLs.
  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'Only https:// links are supported for custom models.' };
  }
  // Reject userinfo BEFORE anything else trusts the host: `user:pass@huggingface.co` would otherwise
  // pass the allowlist (hostname is still `huggingface.co`) and smuggle a plaintext credential into the
  // persisted store.
  if (parsed.username || parsed.password) {
    return {
      ok: false,
      error: 'Remove the username/password from the link — credentials embedded in a URL are not allowed.',
    };
  }
  if (!isAllowedCustomDownloadHost(parsed.hostname)) {
    return {
      ok: false,
      error: `Custom downloads are limited to ${CUSTOM_DOWNLOAD_ALLOWED_HOST} (and its subdomains). Host the .gguf there, or request it be added to the catalog.`,
    };
  }

  // decodeURIComponent must run BEFORE sanitizing — an encoded `%2F`/`%2E%2E` only becomes a real
  // `/`/`..` after decoding, and a naive split-then-decode order is exactly what lets a crafted URL
  // (e.g. `.../foo%2F..%2F..%2Fbar.gguf`) smuggle a path-traversal segment past a pre-decode split. It
  // is wrapped because a malformed escape (a bare `%`) makes it THROW — surface that as an invalid name.
  let guessedName: string | null;
  try {
    const decodedName = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? 'model') || 'model';
    guessedName = sanitizeModelFileName(decodedName);
  } catch {
    return { ok: false, error: "That URL's file name isn't valid — try a direct link with a plain file name." };
  }
  if (!guessedName) {
    return { ok: false, error: "That URL's file name isn't safe to use — try a direct link with a plain file name." };
  }

  return {
    ok: true,
    downloadUrl: trimmed,
    // REDACTED persisted metadata: origin + pathname only. `URL.origin` for an https URL is
    // `https://<host>[:port]` with no trailing slash, so this is `https://huggingface.co/path/model.gguf`
    // — never a `?token=…`, `#fragment`, or `user:pass@`.
    sourceUrl: `${parsed.origin}${parsed.pathname}`,
    displayName: guessedName,
    fileName: guessedName.toLowerCase().endsWith('.gguf') ? guessedName : `${guessedName}.gguf`,
  };
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

/** Stream-hash `uri` and compare against `expectedHex`. Throws on I/O error (deliberately — see
 * `downloadModel`'s FAIL CLOSED handling above; this function does NOT swallow I/O errors into a
 * `false`/`undefined` return the way the old best-effort version did). Returns `false` (not a throw)
 * when `signal` is aborted mid-loop — cancellation isn't an error, but `downloadModel` treats the two
 * identically (fail closed either way).
 *
 * DEVICE-VERIFY GATE (Sol, round 3 — not resolved by this change, just made as cheap as reasonable
 * without a native hash): the largest catalog entry is a 4.5GB GGUF, which means ~6GB of base64 text
 * streamed through this loop across ~560 sequential 8MB reads. `base64ToBytes` below is the one part
 * of that loop worth hand-optimizing in JS (see its own comment); the fundamentally expensive part —
 * SHA-256 over multiple GB in RN's JS thread via `js-sha256`, with no native accelerator — is not
 * something this file can fix, only bound (chunking keeps peak memory to ~2 chunks' worth regardless
 * of file size, and `signal` lets the caller cut it short). This MUST be benchmarked on a
 * representative mid-range Android device before the 4.5GB entry is considered production-ready:
 * wall-clock verify duration, UI responsiveness/ANR risk while it runs, peak memory, that cancellation
 * actually stops it promptly, and that the app survives foreground the whole time. None of that has
 * been measured on real hardware — this codebase has no device to run it on. */
async function verifySha256Streaming(
  uri: string,
  expectedHex: string,
  sizeBytes: number,
  onProgress?: HashProgressCallback,
  signal?: AbortSignal,
): Promise<boolean> {
  const hasher = sha256.create();
  let position = 0;
  while (position < sizeBytes) {
    if (signal?.aborted) {
      // Cancelled mid-verify (e.g. the app was backgrounded — see model-manager.tsx): stop hashing
      // immediately rather than burning battery/CPU on a result nobody will accept, and let the
      // caller's fail-closed path delete the partial file.
      return false;
    }
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

// Precomputed char-code -> 6-bit value lookup, built once at module load. `base64ToBytes` runs over
// ~6GB of base64 text for the largest catalog entry (across ~8MB-base64-string chunks) — an
// `indexOf` scan of a 64-char string per input character, PLUS a separate `.replace(/regex/)` pass to
// strip non-alphabet characters first (the old approach), is two extra full passes over that much
// text for no algorithmic reason. A flat lookup table turns each character into an O(1) array read,
// and folding the "skip non-alphabet characters" check into the same loop removes the `.replace` pass
// entirely — one pass over the string instead of three.
const BASE64_LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < BASE64_CHARS.length; i += 1) {
  BASE64_LOOKUP[BASE64_CHARS.charCodeAt(i)] = i;
}

/** Manual base64 → bytes decoder (avoids relying on `atob`, which isn't guaranteed under Hermes).
 * Single pass over `base64` via the lookup table above rather than a `.replace()` pre-pass followed by
 * a per-character `.indexOf()` scan — see the table's comment for why that matters at this scale. */
function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  // Sized off the raw (unfiltered) length, same upper bound the old `clean.length`-based sizing used
  // (padding/skipped characters only make this a slight overestimate); trimmed to the real length
  // below via `subarray`, which is a view, not a copy.
  const bytes = new Uint8Array(Math.floor((base64.length * 6) / 8));
  let bitBuffer = 0;
  let bitCount = 0;
  let byteIndex = 0;
  for (let i = 0; i < base64.length; i += 1) {
    const code = base64.charCodeAt(i);
    const value = code < 128 ? BASE64_LOOKUP[code] : -1;
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
  return byteIndex === bytes.length ? bytes : bytes.subarray(0, byteIndex);
}
