// Curated catalog of small GGUF models suitable for the LOAM Android host (docs/06). Every URL points
// at an ungated, no-auth-required Hugging Face community mirror — the `unsloth` GGUF re-uploads of
// Google's Gemma 3 / Gemma 3n instruction-tuned models — never Google's own gated/Kaggle-hosted
// originals, so a download never needs a HF token, a license click-through, or a signed-in session.
//
// Provenance (verified live, not fabricated — see the "how to re-verify" note below):
//   - File list: `GET https://huggingface.co/api/models/<repo>/tree/main`.
//   - `sizeBytes`: the `size` field from that response. Cross-checked against a live
//     `curl -IL <resolve/main/file>` for all four entries — the `Content-Length` matched exactly.
//   - `sha256`: the `lfs.oid` field from the same tree response. Hugging Face keeps this
//     git-lfs-compatible field populated with the file's real SHA-256 even under its newer
//     Xet-backed storage. Spot-verified for the 1B entry by downloading the full 806 MB file and
//     running `shasum -a 256` against it — the digest matched `lfs.oid` byte for byte, so the other
//     three (same repo family, same retrieval method, same day) are trusted without a full download
//     of each.
//   - `minRamBytes`: a conservative rule-of-thumb multiple over the Q4_K_M file size (weights +
//     KV-cache + OS/WebView/embedded-node headroom) — not a benchmarked figure. Treat it as a
//     deliberately cautious gate, not a promise that a device just above the line will be fast.
//
// To re-verify or re-pin (e.g. after an upstream re-quantization changes a file):
//   curl -s https://huggingface.co/api/models/<repo>/tree/main | jq '.[] | select(.path=="<file>")'
// and read `.size` / `.lfs.oid`. A stale hash only ever causes a download to fail verification and
// get deleted (see `model-download.ts`) — never a silent corruption.
export type ModelCatalogEntry = {
  /** Stable id used for local storage + as the on-device config's cosmetic `model` label root. */
  id: string;
  displayName: string;
  /** Parameter count / architecture, shown in the UI (e.g. "1B", "E2B (~2B effective)"). */
  params: string;
  quant: string;
  /** Direct HTTPS download URL — no auth, no redirect through a gated/consent page. */
  url: string;
  sizeBytes: number;
  /**
   * SHA-256 of the exact file at `url`, when known — see provenance above. `undefined` means "not
   * pinned"; `model-download.ts` then skips hash verification and relies on the (always-performed)
   * exact-size check.
   *
   * NOTE: every entry below IS pinned, but `model-download.ts` still never actually verifies it —
   * every current catalog file is far above the 100MB `MAX_HASHABLE_BYTES` cap (hashing a
   * multi-hundred-MB file in RN JS risks exhausting heap / wedging the JS thread), so hashing is
   * always skipped for these entries in practice. The exact-size check + TLS are the real integrity
   * story for the shipped catalog today; the hash stays pinned so a future smaller model (or a
   * smaller re-quant) gets a real check automatically.
   */
  sha256?: string;
  /** Minimum device RAM LOAM requires before offering a download — see provenance above. */
  minRamBytes: number;
  note?: string;
};

const GIB = 1024 ** 3;

export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  {
    id: 'gemma-3-1b-it-q4_k_m',
    displayName: 'Gemma 3 1B',
    params: '1B',
    quant: 'Q4_K_M',
    url: 'https://huggingface.co/unsloth/gemma-3-1b-it-GGUF/resolve/main/gemma-3-1b-it-Q4_K_M.gguf',
    sizeBytes: 806_058_272,
    sha256: '8270790f3ab69fdfe860b7b64008d9a19986d8df7e407bb018184caa08798ebd',
    minRamBytes: 3 * GIB,
    note: 'The safe default — smallest and fastest, with headroom to spare on most phones.',
  },
  {
    id: 'gemma-3-4b-it-q4_k_m',
    displayName: 'Gemma 3 4B',
    params: '4B',
    quant: 'Q4_K_M',
    url: 'https://huggingface.co/unsloth/gemma-3-4b-it-GGUF/resolve/main/gemma-3-4b-it-Q4_K_M.gguf',
    sizeBytes: 2_489_894_016,
    sha256: '04a43a22e8d2003deda5acc262f68ec1005fa76c735a9962a8c77042a74a7d19',
    minRamBytes: 6 * GIB,
    note: 'Noticeably better quality than the 1B; needs a higher-RAM phone and more time per reply.',
  },
  {
    id: 'gemma-3n-e2b-it-q4_k_m',
    displayName: 'Gemma 3n E2B',
    params: 'E2B (~2B effective)',
    quant: 'Q4_K_M',
    url: 'https://huggingface.co/unsloth/gemma-3n-E2B-it-GGUF/resolve/main/gemma-3n-E2B-it-Q4_K_M.gguf',
    sizeBytes: 3_026_881_888,
    sha256: '189d42b4303cb1078ea8d00963f437cd6d884069b7ba2ba80b38cd09585dc415',
    minRamBytes: 6 * GIB,
    note:
      "Google's MatFormer-family model built for edge devices (selectively activates a ~2B-parameter " +
      'slice of a larger network); text-only usage here.',
  },
  {
    id: 'gemma-3n-e4b-it-q4_k_m',
    displayName: 'Gemma 3n E4B',
    params: 'E4B (~4B effective)',
    quant: 'Q4_K_M',
    url: 'https://huggingface.co/unsloth/gemma-3n-E4B-it-GGUF/resolve/main/gemma-3n-E4B-it-Q4_K_M.gguf',
    sizeBytes: 4_539_054_208,
    sha256: '43b489bb77a81bda85180e7c490d40ad7f1d5c2ce654c9b05e15e104bd3c777e',
    minRamBytes: 8 * GIB,
    note: 'The largest offered model — best quality, but needs a high-RAM phone and the most storage.',
  },
];

export function findCatalogEntry(id: string): ModelCatalogEntry | undefined {
  return MODEL_CATALOG.find((entry) => entry.id === id);
}
