# LOAM Android host (`apps/app`)

The Expo (SDK 57 / React Native 0.86) app that turns an Android phone into a LOAM host: it runs the real
LOAM server in an embedded Node 18 (`@comapeo/nodejs-mobile-react-native`), starts a local-only Wi-Fi
hotspot, shows the two-step join QR codes, and loads the LOAM web client in a WebView. The full design,
build and verification notes are in [`docs/04-android-host-app.md`](../../docs/04-android-host-app.md).

## Build an APK

From the repo root, after `pnpm install`:

```bash
pnpm --filter app keystore   # once: creates release.jks + keystore.properties (gitignored — back them up)
pnpm --filter app apk        # → apps/app/loam-host.apk
adb install -r apps/app/loam-host.apk
```

`apk` runs the workspace build, `fetch:native` (places the two vendored, sha256-pinned SQLite prebuilds),
`bundle:server`, llama.rn's native libs, `expo prebuild --clean` and `gradlew assembleRelease` (arm64-v8a).
Without a keystore it warns that the APK is debug-signed (acknowledge with `--debug-signed`), and
`pnpm --filter app aab` (the Google Play bundle, docs/30) refuses to build. Needs a real JDK and the
Android SDK + NDK r27+; see docs/04 for prerequisites and the manual steps.

## Develop

- `pnpm --filter app test` — the vitest suite (`src/**/*.test.ts`). Never put a test file under `src/app/`:
  Expo Router bundles everything in that directory into the release APK.
- `pnpm --filter app typecheck` — run by CI.
- The generated `android/` project is gitignored. If you edit `app.json` or `plugins/*.js`, re-run prebuild
  (the `apk` script does): Gradle refuses a stale `android/` (stale-prebuild guard, docs/04).
- Before writing Expo code, read the versioned docs at https://docs.expo.dev/versions/v57.0.0/ (see
  `AGENTS.md`).
