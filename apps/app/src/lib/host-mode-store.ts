// The persisted host mode (hotspot / Wi-Fi) as a small observable store. Pure: storage is injected, so the
// load-once / write-through / "a pick made before the load finishes wins" rules are unit-tested without
// SecureStore. `src/hooks/use-host-mode.ts` wires it to expo-secure-store and React.
import { DEFAULT_HOST_MODE, parseHostMode, type HostMode } from './host-mode';

/** Where the mode is kept. Both calls may reject; the store treats storage as best-effort. */
export type HostModeStorage = {
  read: () => Promise<string | null>;
  write: (value: HostMode) => Promise<void>;
};

export type HostModeSnapshot = {
  mode: HostMode;
  /** False until the stored value has been read (or the read failed). Hotspot start waits on this, so a
   * persisted `wifi` never briefly starts a hotspot (and its location prompt) on the way in. */
  loaded: boolean;
};

export type HostModeStore = {
  get: () => HostModeSnapshot;
  subscribe: (listener: () => void) => () => void;
  /** Read the stored mode once (later calls return the same promise). Never rejects. */
  load: () => Promise<HostMode>;
  /** Switch mode now (listeners see it at once) and persist it. Resolves whether the write landed; never rejects. */
  set: (mode: HostMode) => Promise<boolean>;
};

/** Build a store over `storage`. */
export function createHostModeStore(storage: HostModeStorage): HostModeStore {
  let snapshot: HostModeSnapshot = { mode: DEFAULT_HOST_MODE, loaded: false };
  let loading: Promise<HostMode> | undefined;
  // Set once the operator picks a mode; a slower initial read must not overwrite that choice.
  let chosen = false;
  const listeners = new Set<() => void>();

  function publish(next: HostModeSnapshot): void {
    snapshot = next;
    for (const listener of listeners) {
      listener();
    }
  }

  function load(): Promise<HostMode> {
    if (!loading) {
      loading = storage
        .read()
        .then(parseHostMode, () => DEFAULT_HOST_MODE)
        .then((stored) => {
          if (!chosen) {
            publish({ mode: stored, loaded: true });
          } else if (!snapshot.loaded) {
            publish({ ...snapshot, loaded: true });
          }
          return snapshot.mode;
        });
    }
    return loading;
  }

  async function set(mode: HostMode): Promise<boolean> {
    chosen = true;
    if (snapshot.mode !== mode || !snapshot.loaded) {
      publish({ mode, loaded: true });
    }
    try {
      await storage.write(mode);
      return true;
    } catch {
      // The switch still applies for this run; it just won't survive a restart.
      return false;
    }
  }

  return {
    get: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load,
    set,
  };
}
