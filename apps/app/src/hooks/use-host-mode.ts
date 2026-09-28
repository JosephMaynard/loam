// React/SecureStore wiring for the persisted host mode (see src/lib/host-mode-store.ts). Module-scoped like
// use-hotspot.ts, so the share overlay mounting and unmounting never re-reads storage or loses the choice.
import * as SecureStore from 'expo-secure-store';
import { useEffect, useSyncExternalStore } from 'react';

import { HOST_MODE_ITEM, type HostMode } from '@/lib/host-mode';
import { createHostModeStore, type HostModeSnapshot } from '@/lib/host-mode-store';

// Stored with expo-secure-store like the DB-encryption mode selection (db-encryption.ts): not secret, but
// one storage primitive for the host app's small settings.
const store = createHostModeStore({
  read: () => SecureStore.getItemAsync(HOST_MODE_ITEM),
  write: (value) => SecureStore.setItemAsync(HOST_MODE_ITEM, value),
});

/** Read the persisted mode once per process (idempotent, never rejects). */
export function loadHostMode(): Promise<HostMode> {
  return store.load();
}

/** Switch the host mode and persist it (best-effort; resolves whether the write landed). */
export function setHostMode(mode: HostMode): Promise<boolean> {
  return store.set(mode);
}

/** The current host mode, loading the stored value on first use. */
export function useHostMode(): HostModeSnapshot {
  useEffect(() => {
    void loadHostMode();
  }, []);
  return useSyncExternalStore(store.subscribe, store.get);
}
