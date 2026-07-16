// Unit tests for the WebView-message and wipe-key-clear logic in the Android host screen
// (`src/app/index.tsx`). The apps/app Vitest harness runs in a `node` environment with no React
// renderer, so the screen's native import graph (react-native, WebView, Expo native modules, the
// nodejs-mobile bridge, sibling components) is replaced with inert `vi.mock` doubles below — enough
// for the module to evaluate at import so the exported, dependency-free helpers can be exercised
// directly. Only `react` is loaded for real (it's pure JS and never rendered here).
import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Native / Expo / bridge module doubles (only what index.tsx touches at module load) -----------
vi.mock('@comapeo/nodejs-mobile-react-native', () => ({
  default: { channel: { post: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() }, start: vi.fn() },
}));
vi.mock('expo-keep-awake', () => ({ activateKeepAwakeAsync: vi.fn(), deactivateKeepAwake: vi.fn() }));
vi.mock('react-native', () => ({
  // Only StyleSheet.create runs at module scope; the rest are referenced inside the (never-rendered)
  // component body, so bare stubs suffice.
  StyleSheet: { create: (styles: unknown) => styles },
  ActivityIndicator: () => null,
  Alert: { alert: vi.fn() },
  Linking: { openURL: vi.fn() },
  Platform: { OS: 'android', select: (map: Record<string, unknown>) => map.android ?? map.default },
  Pressable: () => null,
  TextInput: () => null,
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: () => null }));
vi.mock('react-native-webview', () => ({ WebView: () => null }));
vi.mock('@/components/db-encryption-settings', () => ({ DbEncryptionSettingsOverlay: () => null }));
vi.mock('@/components/host-share-overlay', () => ({ HostShareOverlay: () => null }));
vi.mock('@/components/model-manager', () => ({ ModelManagerOverlay: () => null }));
vi.mock('@/components/themed-text', () => ({ ThemedText: () => null }));
vi.mock('@/components/themed-view', () => ({ ThemedView: () => null }));
vi.mock('@/constants/theme', () => ({
  MaxContentWidth: 800,
  Spacing: { half: 2, one: 4, two: 8, three: 16, four: 24, five: 32, six: 64 },
}));
vi.mock('@/hooks/use-theme', () => ({ useTheme: () => ({}) }));
vi.mock('@/lib/on-device-llm', () => ({ registerOnDeviceLlm: () => () => undefined }));
vi.mock('@/mesh/mesh-courier', () => ({ registerMeshCourier: () => () => undefined }));
vi.mock('../../modules/loam-hotspot', () => ({
  startHostService: vi.fn(),
  startKiosk: vi.fn(),
  stopKiosk: vi.fn(),
}));

// The one dependency this suite actually asserts against: `clearStoredDbKeys` must never be reached by
// the WebView `loam-wipe` path. Declared via `vi.hoisted` so it exists when the hoisted `vi.mock`
// factory below runs (a plain outer `const` would be referenced before initialization).
const { clearStoredDbKeys } = vi.hoisted(() => ({
  clearStoredDbKeys: vi.fn<() => Promise<{ ok: boolean; error?: string }>>(),
}));
vi.mock('@/lib/db-encryption', () => ({
  clearStoredDbKeys,
  // `DB_ENCRYPTION_PLAINTEXT_UNCONVERTED_CODE` is referenced at module scope (in a Set); the rest are
  // only used inside the component body, so inert stubs are enough for import to succeed.
  DB_ENCRYPTION_PLAINTEXT_UNCONVERTED_CODE: 'db_encryption_plaintext_unconverted',
  DB_ENCRYPTION_MODE_READ_ERROR: '__read_error__',
  applyDbModeChange: vi.fn(),
  dbEncryptionRecoveryForCode: vi.fn(),
  getDbEncryptionMode: vi.fn(),
  registerDbEncryption: () => () => undefined,
  requestDbStartFresh: vi.fn(),
  requestDbUnlock: vi.fn(),
  setDbEncryptionMode: vi.fn(),
  setDbModeHint: vi.fn(),
  setPassphraseCandidate: vi.fn(),
}));

// Imported AFTER the mocks (vi.mock is hoisted, so ordering is safe) — index.tsx evaluates cleanly
// against the doubles above.
import { clearWipeKeyAndAck, handleClientWebViewMessage, startFreshIntentForCode } from './index';

beforeEach(() => {
  clearStoredDbKeys.mockReset();
});

describe('handleClientWebViewMessage', () => {
  it('does NOT clear the device key on a loam-wipe message from the WebView origin', () => {
    // The security fix: a `{"type":"loam-wipe"}` message posted by web content must be a native no-op.
    // Key rotation is exclusively driven by the acked `loam-wipe-restart` protocol (see below), never by
    // this unauthenticated, phase-ungated WebView message.
    handleClientWebViewMessage(JSON.stringify({ type: 'loam-wipe' }));
    expect(clearStoredDbKeys).not.toHaveBeenCalled();
  });

  it('ignores unknown message types without clearing the device key', () => {
    handleClientWebViewMessage(JSON.stringify({ type: 'something-else' }));
    expect(clearStoredDbKeys).not.toHaveBeenCalled();
  });

  it('ignores malformed (non-JSON) messages without throwing or clearing the device key', () => {
    expect(() => handleClientWebViewMessage('not-json {')).not.toThrow();
    expect(clearStoredDbKeys).not.toHaveBeenCalled();
  });
});

describe('startFreshIntentForCode (Sol P1: button copy ↔ marker intent must agree)', () => {
  it('requests DELETE for the plaintext-unconverted destructive recovery ("Delete existing data & start encrypted")', () => {
    // The `db_encryption_plaintext_unconverted` button is a DELIBERATE destructive action — the server
    // must DELETE the plaintext DB and start a fresh encrypted one, so the marker intent must be 'delete'.
    expect(startFreshIntentForCode('db_encryption_plaintext_unconverted')).toBe('delete');
  });

  it('requests PRESERVE for the unreadable accidental-lockout recovery ("Preserve old database & start fresh")', () => {
    // The `db_encryption_unreadable` button is accidental-lockout recovery — the server renames the old
    // (still key-recoverable) ciphertext aside rather than deleting it, so the intent must be 'preserve'.
    expect(startFreshIntentForCode('db_encryption_unreadable')).toBe('preserve');
  });

  it('defaults to the non-destructive PRESERVE for any other / undefined code', () => {
    // A mis-routed or codeless caller must never silently delete data — 'preserve' is the safe default.
    expect(startFreshIntentForCode(undefined)).toBe('preserve');
    expect(startFreshIntentForCode('boot_timeout')).toBe('preserve');
  });
});

describe('clearWipeKeyAndAck (the acked loam-wipe-restart path)', () => {
  it('clears the device key and acks the launcher on a verified clear', async () => {
    const clear = vi.fn(async () => ({ ok: true as const }));
    const postComplete = vi.fn();

    const outcome = await clearWipeKeyAndAck(clear, postComplete);

    expect(clear).toHaveBeenCalledTimes(1);
    expect(postComplete).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ ok: true });
  });

  it('does NOT ack the launcher when the clear fails, and surfaces the error', async () => {
    const clear = vi.fn(async () => ({ ok: false as const, error: 'device key still present' }));
    const postComplete = vi.fn();

    const outcome = await clearWipeKeyAndAck(clear, postComplete);

    expect(clear).toHaveBeenCalledTimes(1);
    expect(postComplete).not.toHaveBeenCalled();
    expect(outcome).toEqual({ ok: false, error: 'device key still present' });
  });

  it('still reports success when the clear is verified but the launcher ack throws', async () => {
    // The launcher not listening (post throws) is covered by its own boot-time resume repost, so a
    // verified clear must still count as success.
    const clear = vi.fn(async () => ({ ok: true as const }));
    const postComplete = vi.fn(() => {
      throw new Error('launcher not listening');
    });

    const outcome = await clearWipeKeyAndAck(clear, postComplete);

    expect(outcome).toEqual({ ok: true });
  });
});
