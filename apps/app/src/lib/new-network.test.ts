import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cryptoMock, resetCryptoMock, resetSecureStoreMock, secureStoreMock } from '@/test-utils/mocks';

const files = new Set<string>();
vi.mock('expo-secure-store', () => secureStoreMock);
vi.mock('expo-crypto', () => cryptoMock);
vi.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///data/files/',
  getInfoAsync: async (uri: string) => ({ exists: files.has(uri) }),
}));

const { detectPreviousNetwork, loadSetupRecord, prepareNewNetwork, saveSetupRecord } = await import('./new-network');
const { getDbEncryptionMode, registerDbEncryption, resolveDbKey, setDbEncryptionMode } = await import('./db-encryption');

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
  resetSecureStoreMock();
  resetCryptoMock();
});

describe('detectPreviousNetwork', () => {
  it('offers to continue a kept database, not a dead ephemeral one', async () => {
    expect(await detectPreviousNetwork()).toBe(false);
    files.add('file:///data/files/loam/loam.db');
    expect(await detectPreviousNetwork()).toBe(true);
    files.add('file:///data/files/loam/.loam-db-ephemeral');
    expect(await detectPreviousNetwork()).toBe(false);
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
    expect(response.newNetwork).toMatchObject({ node: { name: 'Camp', locale: 'es' }, security: { profile: 'hardened' } });
  });

  it('keeps the current storage mode for Choose every setting myself', async () => {
    await setDbEncryptionMode('persistent');
    await prepareNewNetwork({ preset: 'custom', nodeName: '', connection: 'wifi' }, 'en');
    expect(await getDbEncryptionMode()).toBe('persistent');
    expect((await keyResponse()).newNetwork).toEqual({ node: { name: 'LOAM', locale: 'en' } });
  });
});
