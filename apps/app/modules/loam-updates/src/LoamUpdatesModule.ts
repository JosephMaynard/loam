import { NativeModule, requireOptionalNativeModule } from 'expo';

declare class LoamUpdatesModule extends NativeModule {
  /** `'play'` or `'github'`, fixed when the APK or bundle was built. */
  distribution(): string;
  /** The release tag the build was made for (`v0.6.0`, `v0.6.0-rc.1`), or `''` for a local build. */
  releaseTag(): string;
  /** Whether the store this build came from has a newer version. Never rejects. */
  checkStoreUpdate(): Promise<{ available: boolean }>;
}

// Android-only: `null` on iOS/web or when the module isn't linked, so callers degrade to "no update".
export default requireOptionalNativeModule<LoamUpdatesModule>('LoamUpdates');
