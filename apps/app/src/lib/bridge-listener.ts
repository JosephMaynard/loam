// Per-listener removal on the nodejs-mobile RN channel (pre-release review 2026-09-25).
//
// The request/response round trips (db-encryption.ts, model-manager-bridge.ts) used to clean up with
// `channel.removeAllListeners(resultEvent)`. With two overlapping round trips on the same result event,
// the first to finish removed the SECOND one's listener too, so the second always timed out (failing
// closed, but flaky). Each round trip must remove only its own listener.
//
// The channel's `index.d.ts` types `addListener` as returning void and advertises a `removeListener` that
// does NOT exist at runtime. What it really is: `EventChannel extends ChannelSuper extends` React Native's
// `Libraries/vendor/emitter/EventEmitter`, whose `addListener` RETURNS an `EventSubscription` with
// `remove()` (read in node_modules/@comapeo/nodejs-mobile-react-native/index.js and
// react-native/Libraries/vendor/emitter/EventEmitter.js, RN 0.86). That subscription is what we use.

/** What RN's EventEmitter returns from `addListener`. */
export type BridgeSubscription = { remove(): void };

/** The part of the bridge channel this helper needs. `void` covers the package's (wrong) typing. */
export interface ListenerChannel {
  addListener(name: string, handler: (payload: unknown) => void): BridgeSubscription | void;
}

/**
 * Register `handler` for `name` and return a function that removes ONLY this listener. If the channel
 * returned no subscription (a test double, or a hypothetical runtime without one), the listener is left
 * registered but made inert — never `removeAllListeners(name)`, which would tear down a concurrent round
 * trip's listener.
 */
export function addOwnListener(
  channel: ListenerChannel,
  name: string,
  handler: (payload: unknown) => void,
): () => void {
  let active = true;
  const subscription = channel.addListener(name, (payload) => {
    if (active) {
      handler(payload);
    }
  });
  return () => {
    active = false;
    if (subscription && typeof subscription.remove === 'function') {
      subscription.remove();
    }
  };
}
