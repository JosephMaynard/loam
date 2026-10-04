import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cryptoMock, resetCryptoMock, resetSecureStoreMock, secureStoreMock } from '@/test-utils/mocks';

// A tiny file system: existing paths, their text, and paths whose reads or writes fail.
const files = new Map<string, string>();
const failing = new Set<string>();
vi.mock('expo-secure-store', () => secureStoreMock);
vi.mock('expo-crypto', () => cryptoMock);
vi.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///data/files/',
  getInfoAsync: async (uri: string) => {
    if (failing.has(uri)) {
      throw new Error('I/O error');
    }
    return { exists: files.has(uri) };
  },
  makeDirectoryAsync: async () => undefined,
  writeAsStringAsync: async (uri: string, text: string) => {
    if (failing.has(uri)) {
      throw new Error('disk full');
    }
    files.set(uri, text);
  },
  readAsStringAsync: async (uri: string) => {
    if (!files.has(uri)) {
      throw new Error('ENOENT');
    }
    return files.get(uri)!;
  },
}));

const HINT = 'file:///data/files/loam/.loam-db-mode-hint';

const { detectPreviousNetwork, loadSetupRecord, prepareNewNetwork, saveSetupRecord } = await import('./new-network');
const { getDbEncryptionMode, registerDbEncryption, resolveDbKey, setDbEncryptionMode, setPassphraseCandidate, setPendingNewNetwork } =
  await import('./db-encryption');

async function keyResponse(): Promise<Record<string, unknown>> {
  const posted: unknown[] = [];
  const handlers = new Map<string, (payload: unknown) => void>();
  const cleanup = registerDbEncryption({
    addListener: (name, handler) => handlers.set(name, handler),
    removeAllListeners: (name) => handlers.delete(name),
    post: (_name, payload) => posted.push(payload),
  });
  handlers.get('loam-db-key-request')?.({ requestId: 'r' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  cleanup();
  return posted[0] as Record<string, unknown>;
}

beforeEach(() => {
  files.clear();
  failing.clear();
  setPendingNewNetwork(undefined);
  resetSecureStoreMock();
  resetCryptoMock();
});

describe('detectPreviousNetwork', () => {
  it('offers to continue a kept database, not a dead ephemeral one', async () => {
    expect(await detectPreviousNetwork()).toBe(false);
    files.set('file:///data/files/loam/loam.db', '');
    expect(await detectPreviousNetwork()).toBe(true);
    files.set('file:///data/files/loam/.loam-db-ephemeral', '');
    expect(await detectPreviousNetwork()).toBe(false);
  });
});

describe('detectPreviousNetwork when the folder is hard to read', () => {
  it('never mistakes a kept database for an erased one', async () => {
    files.set('file:///data/files/loam/loam.db', '');
    failing.add('file:///data/files/loam/.loam-db-ephemeral');
    expect(await detectPreviousNetwork()).toBe(true);
    failing.clear();
    failing.add('file:///data/files/loam/loam.db');
    expect(await detectPreviousNetwork()).toBe(true);
  });
});

describe('setup record', () => {
  it('round-trips through secure storage', async () => {
    expect(await loadSetupRecord()).toBeUndefined();
    await saveSetupRecord({ preset: 'private', nodeName: 'Camp', connection: 'wifi' });
    expect(await loadSetupRecord()).toEqual({ preset: 'private', nodeName: 'Camp', connection: 'wifi' });
  });
});

describe('prepareNewNetwork', () => {
  it('switches a Community phone to Private with fresh keys and queues the new configuration', async () => {
    await setDbEncryptionMode('persistent');
    const oldKey = (await resolveDbKey('persistent')).key;

    const result = await prepareNewNetwork({ preset: 'private', nodeName: 'Camp', connection: 'hotspot' }, 'es');

    expect(result).toEqual({ ok: true });
    expect(await getDbEncryptionMode()).toBe('ephemeral');
    expect((await resolveDbKey('persistent')).key).not.toBe(oldKey);
    const response = await keyResponse();
    expect(response.mode).toBe('ephemeral');
    expect(response.newNetwork).toMatchObject({
      config: { node: { name: 'Camp', locale: 'es' }, security: { profile: 'hardened' } },
    });
  });

  it('records the chosen mode for the launcher before it starts, and stops if it cannot', async () => {
    await prepareNewNetwork({ preset: 'community', nodeName: 'Camp', connection: 'wifi' }, 'en');
    expect(files.get(HINT)).toBe('persistent');

    setPendingNewNetwork(undefined);
    failing.add(HINT);
    const result = await prepareNewNetwork({ preset: 'private', nodeName: 'Camp', connection: 'wifi' }, 'en');
    expect(result).toMatchObject({ ok: false });
    expect((await keyResponse()).newNetwork).toBeUndefined();
  });

  it('leaves the previous network openable when preparing fails: its key and mode are untouched', async () => {
    await setDbEncryptionMode('persistent');
    const oldKey = (await resolveDbKey('persistent')).key;
    failing.add(HINT);

    const result = await prepareNewNetwork({ preset: 'private', nodeName: 'Camp', connection: 'wifi' }, 'en');

    expect(result).toMatchObject({ ok: false });
    expect(await getDbEncryptionMode()).toBe('persistent');
    expect((await resolveDbKey('persistent')).key).toBe(oldKey);
    expect((await keyResponse()).newNetwork).toBeUndefined();
  });

  it('gives a new passphrase network a new key, even with the same passphrase', async () => {
    await setPassphraseCandidate('correct horse');
    await setDbEncryptionMode('passphrase');
    const before = (await resolveDbKey('passphrase')).key;
    await prepareNewNetwork({ preset: 'custom', nodeName: 'Camp', connection: 'wifi' }, 'en');
    expect(await getDbEncryptionMode()).toBe('passphrase');
    await setPassphraseCandidate('correct horse');
    const after = (await resolveDbKey('passphrase')).key;
    expect(before).toBeTruthy();
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
  });

  it('encrypts a Choose-every-setting network unless the phone already has an encrypted mode', async () => {
    await prepareNewNetwork({ preset: 'custom', nodeName: '', connection: 'wifi' }, 'en');
    expect(await getDbEncryptionMode()).toBe('persistent');
  });

  it('keeps the current storage mode for Choose every setting myself', async () => {
    await setDbEncryptionMode('persistent');
    await prepareNewNetwork({ preset: 'custom', nodeName: '', connection: 'wifi' }, 'en');
    expect(await getDbEncryptionMode()).toBe('persistent');
    expect((await keyResponse()).newNetwork).toMatchObject({ config: { node: { name: 'LOAM', locale: 'en' } } });
  });
});
