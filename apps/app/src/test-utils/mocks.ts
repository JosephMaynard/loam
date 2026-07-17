// Small, typed, in-memory test doubles for the Expo native modules that apps/app's pure logic
// (src/lib/*) depends on: expo-secure-store, expo-crypto, expo-file-system(/legacy). Real native
// modules never run under Vitest's `node` environment, so a test installs one of these in place of
// the package with `vi.mock` BEFORE importing the module under test (vi.mock calls are hoisted
// above imports by Vitest, so this ordering is automatic once the mock is referenced):
//
//   import { secureStoreMock, resetSecureStoreMock, failSecureStoreItem } from '@/test-utils/mocks';
//
//   vi.mock('expo-secure-store', () => secureStoreMock);
//
//   beforeEach(() => {
//     resetSecureStoreMock();
//   });
//
//   it('surfaces a Keystore read failure', async () => {
//     failSecureStoreItem('loam-db-encryption-mode', new Error('Keystore unavailable'));
//     // ... exercise the module under test, which imports `expo-secure-store` normally ...
//   });
//
// Each mock is a plain object shaped like the real module's named exports (matching how app code
// does `import * as SecureStore from 'expo-secure-store'`), plus a handful of test-only helpers
// (`reset*`, `fail*`) that are NOT part of the real module — only ever import those from this file,
// never through the mocked specifier.

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// expo-secure-store
// ---------------------------------------------------------------------------

interface SecureStoreState {
  items: Map<string, string>;
  failures: Map<string, Error>;
}

const secureStoreState: SecureStoreState = { items: new Map(), failures: new Map() };

function checkSecureStoreFailure(key: string): void {
  const failure = secureStoreState.failures.get(key);
  if (failure) {
    throw failure;
  }
}

/** In-memory `expo-secure-store` replacement: `getItemAsync`/`setItemAsync`/`deleteItemAsync`
 * backed by a `Map`, matching the real module's null-for-missing / throw-on-error contract. */
export const secureStoreMock = {
  async getItemAsync(key: string): Promise<string | null> {
    checkSecureStoreFailure(key);
    return secureStoreState.items.get(key) ?? null;
  },
  async setItemAsync(key: string, value: string): Promise<void> {
    checkSecureStoreFailure(key);
    secureStoreState.items.set(key, value);
  },
  async deleteItemAsync(key: string): Promise<void> {
    checkSecureStoreFailure(key);
    secureStoreState.items.delete(key);
  },
};

/** Clear all stored items and failure injections. Call from `beforeEach`. */
export function resetSecureStoreMock(): void {
  secureStoreState.items.clear();
  secureStoreState.failures.clear();
}

/** Make every subsequent `getItemAsync`/`setItemAsync`/`deleteItemAsync` call for `key` reject
 * with `error`, until `clearSecureStoreFailure(key)` or `resetSecureStoreMock()`. Use this to
 * exercise a module's Keystore-failure fallback paths (e.g. `resolveDbKey`'s "never throw, resolve
 * to no key" contract). */
export function failSecureStoreItem(key: string, error: Error = new Error(`SecureStore failure: ${key}`)): void {
  secureStoreState.failures.set(key, error);
}

export function clearSecureStoreFailure(key: string): void {
  secureStoreState.failures.delete(key);
}

/** Directly seed a stored value without going through `setItemAsync` (e.g. to simulate a value
 * left over from a previous "boot"). */
export function seedSecureStoreItem(key: string, value: string): void {
  secureStoreState.items.set(key, value);
}

// ---------------------------------------------------------------------------
// expo-crypto
// ---------------------------------------------------------------------------

// Mirrors expo-crypto's Crypto.types.ts values exactly (string enums, not positional), so app code
// comparing against `CryptoDigestAlgorithm.SHA256` etc. still works against the mock.
export enum CryptoDigestAlgorithm {
  SHA1 = "SHA-1",
  SHA256 = "SHA-256",
  SHA384 = "SHA-384",
  SHA512 = "SHA-512",
  MD2 = "MD2",
  MD4 = "MD4",
  MD5 = "MD5",
}

export enum CryptoEncoding {
  HEX = "hex",
  BASE64 = "base64",
}

const NODE_HASH_ALGORITHM: Partial<Record<CryptoDigestAlgorithm, string>> = {
  [CryptoDigestAlgorithm.SHA1]: "sha1",
  [CryptoDigestAlgorithm.SHA256]: "sha256",
  [CryptoDigestAlgorithm.SHA384]: "sha384",
  [CryptoDigestAlgorithm.SHA512]: "sha512",
  [CryptoDigestAlgorithm.MD5]: "md5",
};

let randomByteCursor = 0;
let randomBytesSource: ((byteCount: number) => Uint8Array) | undefined;

/** `expo-crypto` replacement. `digestStringAsync` runs a REAL Node `crypto` digest (default HEX,
 * matching the real module's default), so key-derivation tests can assert equality against a
 * hand-computed `SHA256(...)` rather than a fake. `getRandomBytesAsync` defaults to a deterministic
 * incrementing byte sequence (reproducible across runs); override with `setRandomBytesSource` for a
 * fixed/scripted sequence. */
export const cryptoMock = {
  CryptoDigestAlgorithm,
  CryptoEncoding,
  async getRandomBytesAsync(byteCount: number): Promise<Uint8Array> {
    if (randomBytesSource) {
      return randomBytesSource(byteCount);
    }
    const bytes = new Uint8Array(byteCount);
    for (let i = 0; i < byteCount; i += 1) {
      bytes[i] = (randomByteCursor + i) % 256;
    }
    randomByteCursor += byteCount;
    return bytes;
  },
  async digestStringAsync(
    algorithm: CryptoDigestAlgorithm,
    data: string,
    options?: { encoding?: CryptoEncoding },
  ): Promise<string> {
    const nodeAlgorithm = NODE_HASH_ALGORITHM[algorithm] ?? "sha256";
    const encoding = options?.encoding === CryptoEncoding.BASE64 ? "base64" : "hex";
    return createHash(nodeAlgorithm).update(data, "utf8").digest(encoding);
  },
};

/** Reset the deterministic random-byte cursor and any custom source. Call from `beforeEach`. */
export function resetCryptoMock(): void {
  randomByteCursor = 0;
  randomBytesSource = undefined;
}

/** Script `getRandomBytesAsync`'s output for the rest of the test (or until the next
 * `resetCryptoMock()`), e.g. to make a "randomly generated" key assertable. */
export function setRandomBytesSource(source: (byteCount: number) => Uint8Array): void {
  randomBytesSource = source;
}

// ---------------------------------------------------------------------------
// expo-file-system (and expo-file-system/legacy, which apps/app's src/lib actually imports)
// ---------------------------------------------------------------------------

export enum EncodingType {
  UTF8 = "utf8",
  Base64 = "base64",
}

interface FileSystemState {
  files: Map<string, string>;
  failures: Map<string, Error>;
}

const fileSystemState: FileSystemState = { files: new Map(), failures: new Map() };

function checkFileSystemFailure(uri: string): void {
  const failure = fileSystemState.failures.get(uri);
  if (failure) {
    throw failure;
  }
}

function isDirectoryUri(uri: string): boolean {
  return uri.endsWith("/");
}

/** In-memory `expo-file-system`/`expo-file-system/legacy` replacement: a flat `uri -> contents`
 * map standing in for a filesystem, covering the read/write/move/delete + directory-listing subset
 * apps/app's src/lib modules actually use (model-manager-store.ts, model-download.ts,
 * device-capabilities.ts). Directories are any uri ending in `/`; `makeDirectoryAsync` just records
 * that the uri "exists" (as an empty entry) so `getInfoAsync().exists` reports true. */
export const fileSystemMock = {
  documentDirectory: "file:///mock-documents/",
  cacheDirectory: "file:///mock-cache/",
  EncodingType,

  async getInfoAsync(uri: string): Promise<{ exists: boolean; uri: string; isDirectory: boolean; size?: number }> {
    checkFileSystemFailure(uri);
    const exists = fileSystemState.files.has(uri);
    const contents = fileSystemState.files.get(uri);
    return {
      exists,
      uri,
      isDirectory: isDirectoryUri(uri),
      size: exists && !isDirectoryUri(uri) ? Buffer.byteLength(contents ?? "", "utf8") : undefined,
    };
  },

  async readAsStringAsync(uri: string): Promise<string> {
    checkFileSystemFailure(uri);
    const contents = fileSystemState.files.get(uri);
    if (contents === undefined) {
      throw new Error(`ENOENT: no such file, open '${uri}'`);
    }
    return contents;
  },

  async writeAsStringAsync(uri: string, contents: string): Promise<void> {
    checkFileSystemFailure(uri);
    fileSystemState.files.set(uri, contents);
  },

  async deleteAsync(uri: string, options?: { idempotent?: boolean }): Promise<void> {
    checkFileSystemFailure(uri);
    if (!fileSystemState.files.has(uri) && !options?.idempotent) {
      throw new Error(`ENOENT: no such file or directory, unlink '${uri}'`);
    }
    fileSystemState.files.delete(uri);
  },

  async moveAsync({ from, to }: { from: string; to: string }): Promise<void> {
    checkFileSystemFailure(from);
    checkFileSystemFailure(to);
    const contents = fileSystemState.files.get(from);
    if (contents === undefined) {
      throw new Error(`ENOENT: no such file, move '${from}'`);
    }
    fileSystemState.files.delete(from);
    fileSystemState.files.set(to, contents);
  },

  async makeDirectoryAsync(uri: string): Promise<void> {
    checkFileSystemFailure(uri);
    fileSystemState.files.set(isDirectoryUri(uri) ? uri : `${uri}/`, "");
  },

  async readDirectoryAsync(uri: string): Promise<string[]> {
    checkFileSystemFailure(uri);
    const prefix = isDirectoryUri(uri) ? uri : `${uri}/`;
    const names = new Set<string>();
    for (const key of fileSystemState.files.keys()) {
      if (key !== prefix && key.startsWith(prefix)) {
        names.add(key.slice(prefix.length).split("/")[0]!);
      }
    }
    return [...names];
  },
};

/** Clear all files/directories and failure injections. Call from `beforeEach`. */
export function resetFileSystemMock(): void {
  fileSystemState.files.clear();
  fileSystemState.failures.clear();
}

/** Make the next operation touching `uri` reject with `error` (any op — read/write/move/delete
 * each check both their `from` and `to` uris where applicable). Clears via
 * `clearFileSystemFailure(uri)` or `resetFileSystemMock()`. */
export function failFileSystemUri(uri: string, error: Error = new Error(`FileSystem failure: ${uri}`)): void {
  fileSystemState.failures.set(uri, error);
}

export function clearFileSystemFailure(uri: string): void {
  fileSystemState.failures.delete(uri);
}

/** Directly seed a file's contents without going through `writeAsStringAsync`. */
export function seedFile(uri: string, contents: string): void {
  fileSystemState.files.set(uri, contents);
}
