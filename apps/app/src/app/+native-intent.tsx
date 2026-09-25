// Incoming-URL policy for the host app (pre-release review 2026-09-25).
//
// app.json keeps `scheme: "loam"` because Expo Router needs one: on Android it resolves its root URL
// through `Linking.createURL('/')`, which THROWS in a release build when no scheme is configured. That
// scheme also makes Android export a `loam://` VIEW intent filter, so any app or web page can launch us
// with an arbitrary URL. Nothing in the host acts on deep links, and nothing should: every incoming URL
// is rewritten to the host screen on launch, and ignored (no navigation) while running.
export function redirectSystemPath({ initial }: { path: string; initial: boolean }): string | null {
  return initial ? '/' : null;
}
