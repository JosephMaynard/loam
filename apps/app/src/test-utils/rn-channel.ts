// A test double that behaves like the REAL nodejs-mobile RN channel: React Native's EventEmitter, whose
// `addListener` returns a subscription with `remove()` (see src/lib/bridge-listener.ts).
export type RnLikeChannel = {
  addListener(name: string, handler: (payload: unknown) => void): { remove(): void };
  removeAllListeners(name: string): void;
  post(name: string, payload: unknown): void;
  emit(name: string, payload?: unknown): void;
  listenerCount(name: string): number;
  posted: { name: string; payload: unknown }[];
};

export function makeRnLikeChannel(): RnLikeChannel {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  const posted: { name: string; payload: unknown }[] = [];
  return {
    posted,
    addListener(name, handler) {
      if (!handlers.has(name)) {
        handlers.set(name, new Set());
      }
      const set = handlers.get(name)!;
      // Wrap so the same function registered twice is two registrations, like RN's EventEmitter.
      const registration = (payload: unknown) => handler(payload);
      set.add(registration);
      return { remove: () => set.delete(registration) };
    },
    removeAllListeners(name) {
      handlers.delete(name);
    },
    post(name, payload) {
      posted.push({ name, payload });
    },
    emit(name, payload) {
      for (const handler of [...(handlers.get(name) ?? [])]) {
        handler(payload);
      }
    },
    listenerCount(name) {
      return handlers.get(name)?.size ?? 0;
    },
  };
}
