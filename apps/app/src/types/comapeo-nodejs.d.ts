// The @comapeo/nodejs-mobile-react-native `Channel` type is inaccurate about listener removal. It
// declares `removeListener(event, cb)`, which DOES NOT EXIST at runtime: the channel extends React
// Native's vendored EventEmitter (react-native/Libraries/vendor/emitter/EventEmitter), which has no
// `removeListener` — you remove via `removeAllListeners(event)` or the subscription returned by
// `addListener`. Calling the phantom `removeListener` threw "undefined is not a function" inside every
// bridge `onResult` handler, which crashed the AI-Model activate flow and the DB-encryption change flow
// (and left encryption unpersisted, since the write's promise never resolved). Our code now calls the
// real `removeAllListeners`; this augmentation makes that type-check. (The bogus upstream `removeListener`
// stays in the type but is harmless as long as nothing calls it — nothing does anymore.)
declare module "@comapeo/nodejs-mobile-react-native" {
  interface Channel {
    removeAllListeners: (event: string) => void;
  }
}
