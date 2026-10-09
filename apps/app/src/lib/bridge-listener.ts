// Per-listener removal on the nodejs-mobile RN channel.
//
// The request/response round trips (db-encryption.ts, model-manager-bridge.ts) must each remove only
// their own listener: with `channel.removeAllListeners(resultEvent)`, the first of two overlapping round
// trips on the same result event to finish would remove the SECOND one's listener too, so the second
// would always time out (failing closed, but flaky).
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
