import { describe, expect, it, vi } from 'vitest';

import { createHostModeStore, type HostModeStorage } from './host-mode-store';

/** A storage double whose read settles only when the test says so. */
function deferredStorage(): HostModeStorage & { resolveRead: (value: string | null) => void; rejectRead: () => void; writes: string[] } {
  let resolveRead: (value: string | null) => void = () => undefined;
  let rejectRead: () => void = () => undefined;
  const read = new Promise<string | null>((resolve, reject) => {
    resolveRead = resolve;
    rejectRead = () => reject(new Error('Keystore unavailable'));
  });
  const writes: string[] = [];
  return {
    read: vi.fn(() => read),
    write: vi.fn(async (value) => {
      writes.push(value);
    }),
    resolveRead: (value) => resolveRead(value),
    rejectRead: () => rejectRead(),
    writes,
  };
}

describe('createHostModeStore', () => {
  it('starts on the default, unloaded, then publishes the stored mode once', async () => {
    const storage = deferredStorage();
    const store = createHostModeStore(storage);
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.get()).toEqual({ mode: 'hotspot', loaded: false });

    const first = store.load();
    const second = store.load();
    storage.resolveRead('wifi');
    await expect(first).resolves.toBe('wifi');
    await expect(second).resolves.toBe('wifi');
    expect(storage.read).toHaveBeenCalledTimes(1);
    expect(store.get()).toEqual({ mode: 'wifi', loaded: true });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('treats a garbled value or a failed read as the default', async () => {
    const garbled = deferredStorage();
    const store = createHostModeStore(garbled);
    const loaded = store.load();
    garbled.resolveRead('satellite');
    await expect(loaded).resolves.toBe('hotspot');

    const failing = deferredStorage();
    const other = createHostModeStore(failing);
    const failed = other.load();
    failing.rejectRead();
    await expect(failed).resolves.toBe('hotspot');
    expect(other.get()).toEqual({ mode: 'hotspot', loaded: true });
  });

  it('applies a pick at once, persists it, and a slower initial read never overwrites it', async () => {
    const storage = deferredStorage();
    const store = createHostModeStore(storage);
    const loading = store.load();

    await expect(store.set('wifi')).resolves.toBe(true);
    expect(store.get()).toEqual({ mode: 'wifi', loaded: true });
    expect(storage.writes).toEqual(['wifi']);

    storage.resolveRead('hotspot');
    await expect(loading).resolves.toBe('wifi');
    expect(store.get()).toEqual({ mode: 'wifi', loaded: true });
  });

  it('keeps the switch for this run when the write fails, and reports it', async () => {
    const store = createHostModeStore({
      read: async () => null,
      write: async () => {
        throw new Error('Keystore unavailable');
      },
    });
    await expect(store.set('wifi')).resolves.toBe(false);
    expect(store.get().mode).toBe('wifi');
  });

  it('stops notifying an unsubscribed listener', async () => {
    const store = createHostModeStore({ read: async () => null, write: async () => undefined });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    await store.set('wifi');
    unsubscribe();
    await store.set('hotspot');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
