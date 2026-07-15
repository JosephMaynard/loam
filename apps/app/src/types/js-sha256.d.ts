// js-sha256 ships no types (no @types/js-sha256 package either) — minimal shim for the subset
// model-download.ts uses: an incremental hasher via `sha256.create()` (P2-4/AF7 streaming SHA-256).
declare module 'js-sha256' {
  interface Sha256Hash {
    update(message: string | number[] | Uint8Array | ArrayBuffer): Sha256Hash;
    hex(): string;
  }

  interface Sha256Method {
    (message: string | number[] | Uint8Array | ArrayBuffer): string;
    create(): Sha256Hash;
  }

  export const sha256: Sha256Method;
}
