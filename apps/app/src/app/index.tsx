import nodejs from '@comapeo/nodejs-mobile-react-native';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Platform, Pressable, StyleSheet, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';

import { DbEncryptionSettingsOverlay } from '@/components/db-encryption-settings';
import { HostShareOverlay } from '@/components/host-share-overlay';
import { ModelManagerOverlay } from '@/components/model-manager';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  applyDbModeChange,
  clearStoredDbKeys,
  DB_ENCRYPTION_MODE_READ_ERROR,
  DB_ENCRYPTION_PLAINTEXT_UNCONVERTED_CODE,
  dbEncryptionRecoveryForCode,
  getDbEncryptionMode,
  registerDbEncryption,
  requestDbStartFresh,
  requestDbUnlock,
  setDbEncryptionMode,
  setDbModeHint,
  setPassphraseCandidate,
  type DbEncryptionMode,
} from '@/lib/db-encryption';
import { registerOnDeviceLlm } from '@/lib/on-device-llm';
import { registerMeshCourier } from '@/mesh/mesh-courier';
import { startHostService, startKiosk, stopKiosk } from '../../modules/loam-hotspot';

// The embedded server (main.js → loam-server.js) always listens on this port; the host phone's
// WebView loads it over loopback. Remote joiners use the hotspot IP (below).
const SERVER_PORT = 3000;
const LOAM_URL = `http://localhost:${SERVER_PORT}`;
// Fallback join address: stock Android LocalOnlyHotspot puts the host at this fixed gateway IP, but
// that isn't guaranteed across devices. The launcher reports the host's real addresses over the
// `loam-hostinfo` channel and we prefer those; this is the last-resort default so a QR always renders.
const HOTSPOT_GATEWAY_FALLBACK = `http://192.168.49.1:${SERVER_PORT}`;
// Cold start is ~80s (docs/04); give it comfortably more before declaring the runtime hung.
const STARTUP_TIMEOUT_MS = 150_000;
// How long to wait for GET /api/bootstrap to resolve before mounting the WebView anyway (G7): in
// `required` transport mode the very first WebView load needs the `#k=` fragment already present, or
// the host's own WebView briefly flashes a blocked/error page before the reload carrying the key. The
// fetch is a loopback call to the just-booted server, so it normally resolves in well under this.
const BOOTSTRAP_KEY_TIMEOUT_MS = 2000;
// Boot-status error codes (from the server via embedded-main.ts's boot-error bridge, or from main.js
// itself) that point at the on-device DB-encryption feature specifically — an operator hitting one of
// these is very likely locked out because of an unopenable/undecryptable encrypted DB, so the fix is
// "open Encryption settings and switch back to Off", not "close and reopen the app" (G2). Kept as a
// defensive fallback for the terminal error screen below — in the normal case these codes now arrive
// as the non-fatal `notice` status handled by `onStatus` (see `BootNotice`/AF2), not `error`.
const DB_ENCRYPTION_ERROR_CODES = new Set([
  'db_encryption_open_failed',
  'db_encryption_unreadable',
  'db_encryption_unavailable',
  'db_encryption_no_key',
  'db_encryption_locked',
  DB_ENCRYPTION_PLAINTEXT_UNCONVERTED_CODE,
]);

// The one DB-encryption code with a dedicated recovery action (AF8/design#1, docs/01, docs/15): an
// existing encrypted database the current key can't open. Unlike the other DB-encryption codes (which
// mean the server DEGRADED but kept booting, and arrive as the dismissible `notice` status — see
// `onStatus` below), this one means boot genuinely FAILED (P1-1, Sol round 3) — it now arrives as a
// real `'error'` status (main.js no longer maps it to `notice`), and the embedded runtime deliberately
// stays alive (rather than exiting) specifically so the "Preserve old database & start fresh" action
// below can drive an in-process retry. It gets its own persistent, NON-dismissible fatal block (in the
// non-ready view only — `status` can never be `'ready'` while this is the active error) rather than the
// generic dismissible notice banner; a subsequent `'ready'` clears it (the `onStatus` 'ready' branch
// already resets `errorCode`/`status`, which this block's visibility is keyed on).
const DB_UNREADABLE_CODE = 'db_encryption_unreadable';

// The OTHER DB-encryption code with a dedicated recovery action (P1-1, Sol round 4): a `persistent`/
// `passphrase` boot found no usable key at all (typically passphrase mode before a passphrase was ever
// entered, or a Keystore/RNG failure) and REFUSED to start the server — never a silent plaintext
// fallback. Distinct from `DB_UNREADABLE_CODE`: there, a key WAS resolved but the on-disk DB couldn't be
// opened with it (recoverable via "preserve & start fresh"); here, no key exists yet at all, so the
// recovery is either entering a passphrase (passphrase mode) or a plain retry (persistent mode, e.g.
// after a transient Keystore hiccup) — see the `dbLocked` block below.
const DB_LOCKED_CODE = 'db_encryption_locked';

/** A non-fatal boot-time notice (status `'notice'`, distinct from `'error'` — see `onStatus`). Kept in
 * its own state, separate from `status`/`errorMessage`/`errorCode`, specifically so it SURVIVES the
 * `ready` transition instead of being silently cleared by it (AF2/P1-4) — a downgrade to plaintext, or
 * a fresh-started database, is exactly the kind of thing the operator must not lose sight of once the
 * WebView is up and everything otherwise looks normal. */
type BootNotice = { code: string; message?: string };

/**
 * Build the Step-2 join URL from the host's real reported addresses, in order of how likely a joiner
 * is to reach it: (1) the stock LocalOnlyHotspot AP address; (2) a regular LAN address — the common
 * case when the host is on an existing WiFi (home/office/venue), which is what actually works when
 * everyone shares that network; (3) any other private address; (4) whatever was reported. Only when
 * nothing has been reported yet do we fall back to the documented hotspot default.
 */
function hotspotJoinUrl(addresses: string[]): string {
  const isPrivate10or172 = (address: string) =>
    address.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(address);
  const preferred =
    addresses.find((address) => address.startsWith('192.168.49.')) ??
    addresses.find((address) => address.startsWith('192.168.')) ??
    addresses.find(isPrivate10or172) ??
    addresses[0];
  return preferred ? `http://${preferred}:${SERVER_PORT}` : HOTSPOT_GATEWAY_FALLBACK;
}

/** True when `url` belongs to the embedded server's origin (compares origins, not string prefixes). */
function isLoamUrl(url: string | undefined): boolean {
  if (!url) {
    return false;
  }
  try {
    return new URL(url).origin === LOAM_URL;
  } catch {
    return false;
  }
}

/**
 * Classify a message posted from the WebView's web content (the LOAM client) back to this native
 * screen, then act on the ones this screen recognises. Extracted (and exported) as a pure,
 * dependency-free function so the native side-effect policy for each message type lives in one
 * obvious, unit-testable place.
 *
 * `loam-wipe` (posted by the client's `wipe` WS-event handler when the SERVER announces a node reset)
 * is deliberately a NATIVE NO-OP here. Two reasons:
 *   1. The client-side purge (IndexedDB/localStorage/service-worker caches) happens inside the WebView
 *      itself; nothing on the native side is required for it.
 *   2. Rotating a FIXED on-device database key (persistent/passphrase modes) is driven EXCLUSIVELY by
 *      the acknowledged launcher protocol — the server posts `loam-wipe-restart` only AFTER it has
 *      deleted the orphaned ciphertext and advanced its durable `.loam-wipe-phase` marker to
 *      `key-clear-ready`, at which point `attemptWipeKeyClear` performs a verified clear and acks with
 *      `loam-wipe-complete`. Clearing the key straight from this unauthenticated WebView-origin message
 *      would bypass that phase gate and could destroy the key while a deletion survivor still exists.
 * Ephemeral/off nodes hold no stored key to rotate here either (ephemeral keys are RAM-only and rotated
 * server-side; off has no key). A malformed or foreign message is simply ignored.
 */
export function handleClientWebViewMessage(data: string): void {
  let type: unknown;
  try {
    ({ type } = JSON.parse(data) as { type?: unknown });
  } catch {
    // not a message this screen understands — ignore.
    return;
  }
  switch (type) {
    case 'loam-wipe':
      // Intentional native no-op — see this function's doc comment. Left as an explicit branch so the
      // reasoning is visible at the call site and future message types have an obvious home.
      break;
    default:
      break;
  }
}

/** Outcome of {@link clearWipeKeyAndAck} — the ack is sent to the launcher ONLY on a verified clear. */
export type WipeKeyClearOutcome = { ok: boolean; error?: string };

/**
 * Perform the device-key clear for the acknowledged fixed-key rotation protocol and, ONLY on a VERIFIED
 * success, notify the launcher so it can delete its durable `.loam-wipe-phase` marker. On any failure —
 * a thrown/failed clear, or a verify that still finds the key present — the marker is left in place (this
 * screen cannot touch it directly; the launcher keeps it until a verified ack arrives) so the operator
 * can retry. Dependency-injected (the clear routine and the ack post) so it's pure and unit-testable.
 */
export async function clearWipeKeyAndAck(
  clear: () => Promise<{ ok: boolean; error?: string }>,
  postComplete: () => void,
): Promise<WipeKeyClearOutcome> {
  const result = await clear();
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  try {
    // Tell the launcher it can delete its durable marker — the key clear is VERIFIED, not just attempted.
    postComplete();
  } catch {
    // The launcher isn't listening — its own boot-time resume check (re-posting `loam-wipe-restart`
    // while the marker is still present) covers this; nothing more to do here.
  }
  return { ok: true };
}

type HostStatus = 'starting' | 'ready' | 'error';
// `'notice'` is a THIRD status the bridge can send (main.js / embedded-main.ts's boot-error hook —
// see the `BootNotice` comment above) that deliberately does NOT drive `HostStatus`/the screen switch:
// it only ever updates the separate `notice` state below, so it can never regress a 'ready' host back
// to a spinner/error screen, and — unlike 'error' before this fix — is never cleared by a later 'ready'.
type StatusPayload = { status?: HostStatus | 'notice'; message?: string; code?: string };
type HostInfoPayload = { port?: number; addresses?: string[] };
// The subset of GET /api/bootstrap this screen reads (docs/20 — cookie-free, mints no session, so
// it's safe to poll from the host's own WebView client before any identity exists).
type BootstrapPayload = {
  networkConfig?: { transportEncryption?: string; transportPublicKey?: string };
};

// nodejs-mobile allows exactly one runtime per process; a screen remount must not start it twice,
// and — since the runtime can't restart and won't re-emit — the last status is kept at module scope
// so a remount reflects reality instead of resetting to "starting" forever.
let nodeStarted = false;
let nodeStatus: HostStatus = 'starting';
// Same "survive a remount" reasoning as `nodeStatus` above, but for the persistent boot notice (AF2):
// once set it's never cleared by a status change, only by the operator dismissing it in this render.
let nodeNotice: BootNotice | undefined;

/**
 * The LOAM Android host screen. Boots the embedded Node server on first mount, waits for its
 * readiness signal (posted by main.js once /api/config answers), then loads the served LOAM client
 * in a WebView with cookies + WebSocket enabled. Shows a "starting host…" state until then, since
 * cold start can take ~80s (docs/04).
 */
export default function HostScreen() {
  // Initialise from the module-level status so a remount after the node is already ready/errored
  // doesn't get stuck showing "starting" (the runtime won't re-emit).
  const [status, setStatus] = useState<HostStatus>(() => nodeStatus);
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  // The boot-status error `code` (if any) from the last `loam-status` payload — see
  // `DB_ENCRYPTION_ERROR_CODES` above. Used to surface the Encryption-settings action prominently when
  // the failure looks DB-encryption-related (G2), rather than making the operator guess.
  const [errorCode, setErrorCode] = useState<string | undefined>();
  // The persistent boot notice (AF2/P1-4) — see `BootNotice`. Independent of `status`: it survives a
  // later `ready`, and is only cleared by the operator dismissing it (`noticeDismissed`) below.
  const [notice, setNotice] = useState<BootNotice | undefined>(() => nodeNotice);
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  // "Preserve old database & start fresh" (AF8/design#1) in-flight state — see `handleStartFresh`.
  const [startFreshBusy, setStartFreshBusy] = useState(false);
  const [startFreshMessage, setStartFreshMessage] = useState<string | undefined>();
  // `db_encryption_locked` unlock (P1-1, Sol round 4) in-flight state — see `handleUnlockWithPassphrase`/
  // `handleRetryUnlock`. `lockedMode` is fetched once the locked state becomes active, purely to decide
  // whether to show the passphrase input (only meaningful for 'passphrase' mode) or just a plain Retry.
  const [lockedMode, setLockedMode] = useState<DbEncryptionMode | undefined>();
  const [unlockPassphraseInput, setUnlockPassphraseInput] = useState('');
  const [unlockBusy, setUnlockBusy] = useState(false);
  const [unlockMessage, setUnlockMessage] = useState<string | undefined>();
  // `db_encryption_plaintext_unconverted` recovery (P1-4-RN, Sol round 8) in-flight state — see
  // `handleRevertToOff`. The DESTRUCTIVE alternative ("delete existing data & start encrypted") reuses
  // `handleStartFresh`/`startFreshBusy`; this is the non-destructive "switch encryption back off" path.
  const [revertBusy, setRevertBusy] = useState(false);
  const [revertMessage, setRevertMessage] = useState<string | undefined>();
  // P1-2(b): the durable, acked wipe-key-clear handoff. Set only on a VERIFIED clear FAILURE (never a
  // blanket "cleared") — see `attemptWipeKeyClear`. The launcher's own durable `.loam-wipe-phase`
  // file (main.js) at `key-clear-ready` is the actual source of truth for whether the clear still needs
  // retrying across an app restart; this state is just this screen's live view of the most recent attempt.
  const [wipeClearFailure, setWipeClearFailure] = useState<string | undefined>();
  const [wipeClearBusy, setWipeClearBusy] = useState(false);
  // Whether the "Share / Host" overlay (hotspot + two-step join QRs) is open.
  const [shareOpen, setShareOpen] = useState(false);
  // Whether the on-device LLM model manager overlay (docs/06) is open.
  const [modelManagerOpen, setModelManagerOpen] = useState(false);
  // Whether the on-device DB-encryption mode picker overlay (docs/01, docs/21) is open.
  const [dbEncryptionOpen, setDbEncryptionOpen] = useState(false);
  // The host's real network addresses, reported by the launcher (loam-hostinfo). Used to build the
  // Step-2 join QR from the actual hotspot IP instead of a hardcoded guess.
  const [hostAddresses, setHostAddresses] = useState<string[]>([]);
  // The `#k=<transportPublicKey>` URL fragment, learned from GET /api/bootstrap once the host is
  // ready. Empty when transport encryption is off (or the fetch hasn't resolved yet) — plain URLs,
  // today's behaviour. Non-empty in `optional`/`required` mode, so both the host's own WebView and
  // the join QR carry the key a `required`-mode handshake needs (docs/08).
  const [transportKeyFragment, setTransportKeyFragment] = useState('');
  // Whether it's safe to mount the WebView yet (G7): held back until the bootstrap key fetch below
  // resolves (or times out) so the FIRST load already carries `#k=` when transport encryption is
  // `required` — otherwise the WebView loads a bare URL, gets blocked, then reloads with the fragment,
  // flashing a blocked page. Set once per "become ready" transition.
  const [webViewReady, setWebViewReady] = useState(false);
  // Optional "keep the screen on" — for a wall-mounted host showing the join QRs to a room.
  const [keepAwake, setKeepAwake] = useState(false);
  // Optional kiosk mode — pin the app (Android screen pinning) so a passer-by can't wander off into
  // other apps; exiting requires the device's own screen-lock PIN.
  const [kiosk, setKiosk] = useState(false);
  const webViewRef = useRef<WebView>(null);
  const theme = useTheme();

  // Derived, not stored: used both to gate a `useEffect` below (fetching `lockedMode`) and to drive the
  // fatal block's visibility in the render. Computed here (rather than after the `status === 'ready'`
  // early return) so the effect that depends on it obeys the Rules of Hooks.
  const dbLocked = status === 'error' && errorCode === DB_LOCKED_CODE;

  // Once the locked state becomes active, learn which mode is actually locked (purely to decide whether
  // to show the passphrase input, which only makes sense for 'passphrase' mode). A read-error sentinel
  // (P1-3, Sol round 5) is deliberately NOT stored here — this is cosmetic (which recovery input to
  // show), so a transient read failure just leaves the plain-Retry UI rather than a bogus mode value.
  useEffect(() => {
    if (!dbLocked) {
      return;
    }
    let cancelled = false;
    void getDbEncryptionMode().then((mode) => {
      if (!cancelled && mode !== DB_ENCRYPTION_MODE_READ_ERROR) {
        setLockedMode(mode);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [dbLocked]);

  // P1-2(b), Sol round 4: clear the device key material and, ONLY on a VERIFIED success, ack the
  // launcher (`loam-wipe-complete`) so it deletes its durable `.loam-wipe-phase` file. On ANY
  // failure — a thrown delete, a failed verify, or the item still present afterward (see
  // `clearStoredDbKeys`'s real success/failure return) — the phase file is left exactly where it is (this
  // screen has no way to touch it directly; main.js's phase file stays until a verified ack arrives) and
  // this screen shows the real failure with a Retry, never a blanket "cleared". Called from the
  // `loam-wipe-restart` bridge listener below — fired both for a LIVE kill-switch signal and for
  // main.js's own boot-time RESUME repost (a suspended/backgrounded/killed RN gets another chance).
  const attemptWipeKeyClear = async () => {
    setWipeClearBusy(true);
    // Clear the device key material and, only on a VERIFIED clear, ack the launcher — see
    // `clearWipeKeyAndAck`. This is the SOLE native path that touches the stored key on a wipe.
    const result = await clearWipeKeyAndAck(clearStoredDbKeys, () => nodejs.channel.post('loam-wipe-complete'));
    setWipeClearBusy(false);

    if (!result.ok) {
      setWipeClearFailure(result.error ?? 'Unknown error clearing the device encryption key.');
      return;
    }

    setWipeClearFailure(undefined);
    try {
      nodejs.start('main.js', { redirectOutputToLogcat: true });
    } catch {
      // Expected on today's nodejs-mobile (one runtime per process) — see the comment on the
      // `loam-wipe-restart` listener below. The restart prompt is the real recovery path either way.
    }
    Alert.alert(
      'Restart LOAM',
      'The database encryption key was cleared for the emergency reset. Close and reopen the app now to finish starting a fresh database.',
    );
  };

  useEffect(() => {
    const tag = 'loam-host';
    if (keepAwake) {
      void activateKeepAwakeAsync(tag).catch(() => undefined);
    } else {
      void deactivateKeepAwake(tag).catch(() => undefined);
    }
    return () => {
      void deactivateKeepAwake(tag).catch(() => undefined);
    };
  }, [keepAwake]);

  // Enter/leave Android screen pinning as the kiosk toggle flips. Both calls are best-effort no-ops
  // when unsupported; on unmount we unpin so the app is never left stuck in lock-task.
  useEffect(() => {
    if (kiosk) {
      startKiosk();
    } else {
      stopKiosk();
    }
    return () => {
      stopKiosk();
    };
  }, [kiosk]);

  useEffect(() => {
    if (Platform.OS !== 'android') {
      return;
    }

    // Give up waiting after a generous window (cold start is ~80s per docs/04) so a runtime that
    // never signals doesn't leave the user staring at the spinner forever. Cleared on ready/error.
    const startupTimeout = setTimeout(() => {
      if (nodeStatus === 'starting') {
        nodeStatus = 'error';
        setStatus('error');
        setErrorMessage('The embedded server is taking too long to start. Close and reopen the app.');
      }
    }, STARTUP_TIMEOUT_MS);

    const onStatus = (payload: StatusPayload) => {
      if (payload?.status === 'ready') {
        clearTimeout(startupTimeout);
        nodeStatus = 'ready';
        setStatus('ready');
        setErrorMessage(undefined);
        setErrorCode(undefined);
        // P1-1 (Sol round 3): clear any leftover start-fresh confirmation state from a PRIOR
        // `db_encryption_unreadable` recovery — that fatal block only exists in the non-ready view
        // (see DB_UNREADABLE_CODE's comment), so once `ready` fires the operator can no longer see it,
        // and a stale "Confirmed. Close and reopen…" message must not resurface later out of context.
        setStartFreshBusy(false);
        setStartFreshMessage(undefined);
        // P1-1 (Sol round 4): same reasoning, for the `db_encryption_locked` unlock state — its fatal
        // block also only exists in the non-ready view (see `dbLocked`'s definition).
        setUnlockBusy(false);
        setUnlockMessage(undefined);
        // P1-4-RN (Sol round 8): same reasoning for the `db_encryption_plaintext_unconverted` recovery.
        setRevertBusy(false);
        setRevertMessage(undefined);
        // Deliberately NOT touching `notice`/`nodeNotice` here (AF2/P1-4) — a boot notice describes a
        // degraded DB-encryption posture that's still true once the host is up; clearing it just
        // because the server also became ready is exactly the bug this fix removes.
        // Keep the host alive when the screen locks (docs/04). Best-effort — a device that refuses
        // the foreground service just falls back to foreground-only hosting.
        startHostService();
      } else if (payload?.status === 'notice') {
        // Non-fatal (main.js only ever sends this for DB-encryption boot degradations — see its
        // `DB_ENCRYPTION_NOTICE_CODES`) — never touches `status`/`nodeStatus`, so it can't regress a
        // 'ready' host back to a spinner/error screen, and it persists past a later 'ready' (see above).
        if (payload.code) {
          const next: BootNotice = { code: payload.code, message: payload.message };
          nodeNotice = next;
          setNotice(next);
          setNoticeDismissed(false);
        }
      } else if (payload?.status === 'error') {
        clearTimeout(startupTimeout);
        nodeStatus = 'error';
        setStatus('error');
        setErrorMessage(payload.message);
        setErrorCode((current) => {
          // RF3: a generic, codeless boot error — chiefly main.js's ~5-min readiness-poll give-up
          // (`waitForServer`'s `retry`, which historically posted no `code` at all) — must not clobber
          // an ACTIVE `db_encryption_unreadable` recovery state. Without this, that codeless error
          // overwrote `errorCode` to `undefined`, `dbUnreadable` went false, and the "Preserve old
          // database & start fresh" button silently vanished even though recovery was still possible
          // (the operator would have to force-quit and reopen the app to see it again). `'boot_timeout'`
          // is main.js's now-explicit code for that same give-up path — treated the same way here.
          if (
            (current === DB_UNREADABLE_CODE || current === DB_ENCRYPTION_PLAINTEXT_UNCONVERTED_CODE) &&
            (payload.code === undefined || payload.code === 'boot_timeout')
          ) {
            return current;
          }
          return payload.code;
        });
        // RF2: this is the retry's OUTCOME (see `handleStartFresh`, which now leaves `startFreshBusy`
        // true past the marker-write ack specifically so a double-tap can't trigger a second overlapping
        // in-process reboot) — release the busy state now that it's known, whether or not this error is
        // start-fresh-related. Harmless when it isn't: `startFreshBusy` is already false in that case.
        setStartFreshBusy(false);
        // Same reasoning for the `db_encryption_locked` unlock retry (P1-1, Sol round 4) — this may be
        // ITS outcome (still locked, or a different error entirely once the retry proceeds past
        // locked), or unrelated; harmless either way since `unlockBusy` is already false when it is.
        setUnlockBusy(false);
        // Same for the `db_encryption_plaintext_unconverted` "switch off" retry (P1-4-RN, Sol round 8).
        setRevertBusy(false);
      }
    };

    const onHostInfo = (payload: HostInfoPayload) => {
      if (Array.isArray(payload?.addresses)) {
        setHostAddresses(payload.addresses.filter((address): address is string => typeof address === 'string'));
      }
    };

    // P1-2 (Sol round 3/4): the server's kill switch posts this when a `persistent`/`passphrase`-
    // encrypted node is wiped — its key is FIXED (Keystore-held), so the server deleted the now-orphaned
    // ciphertext and handed off HERE to clear the key material and restart. Unlike the P1-1
    // `db_encryption_unreadable` recovery above (which retries boot in the SAME still-alive Node runtime
    // — a plain JS function call inside that process), this genuinely needs a NEW OS process: the OLD
    // embedded server is still bound to port 3000 with its store already closed, and nodejs-mobile's
    // native module only starts its runtime ONCE per process (`_startedNodeAlready` — a second
    // `nodejs.start()` call is a silent no-op, not an error, so it can never be trusted to have actually
    // restarted anything). The only reliable recovery is the operator closing and reopening the app; the
    // `nodejs.start()` call inside `attemptWipeKeyClear` is a forward-compatible best-effort attempt only.
    //
    // main.js also re-fires this SAME event at ITS OWN boot time if its durable `.loam-wipe-phase`
    // file still reads `key-clear-ready` (P1-2b) — i.e. an earlier clear attempt never got far enough to
    // ack (the server proved artifacts gone but the device key was never confirmed cleared). This
    // handler doesn't need to (and can't) distinguish that from a live signal; `attemptWipeKeyClear` is
    // idempotent either way (clearing an already-cleared key just verifies clean and acks again).
    const onWipeRestart = () => {
      void attemptWipeKeyClear();
    };

    nodejs.channel.addListener('loam-status', onStatus);
    nodejs.channel.addListener('loam-hostinfo', onHostInfo);
    nodejs.channel.addListener('loam-wipe-restart', onWipeRestart);
    // Answer optional on-device LLM requests from the embedded server (no-op unless the operator
    // enables the on-device backend and a model is wired — see docs/06).
    const cleanupLlm = registerOnDeviceLlm(nodejs.channel);
    // Bridge the opportunistic-mesh transport (BLE/Wi-Fi Aware) to the launcher's courier (docs/17).
    // Inert unless the operator enables `mesh.enabled` AND the native transport module is present —
    // on a device/build without the radios, `meshTransport` is a no-op, so this is always safe.
    const cleanupMesh = registerMeshCourier(nodejs.channel);
    // Answer main.js's DB-encryption key request at boot (docs/01, docs/21). Registered here rather
    // than gated on nodeStarted so it's always listening before/whenever main.js's own request arrives
    // — though main.js's request/response handoff is race-free regardless (it requests and waits).
    const cleanupDbEncryption = registerDbEncryption(nodejs.channel);

    if (!nodeStarted) {
      nodeStarted = true;
      // redirectOutputToLogcat: server logs land under the NODEJS-MOBILE tag (adb logcat proof).
      nodejs.start('main.js', { redirectOutputToLogcat: true });
    }

    return () => {
      clearTimeout(startupTimeout);
      nodejs.channel.removeListener('loam-status', onStatus);
      nodejs.channel.removeListener('loam-hostinfo', onHostInfo);
      nodejs.channel.removeListener('loam-wipe-restart', onWipeRestart);
      cleanupLlm();
      cleanupMesh();
      cleanupDbEncryption();
    };
  }, []);

  // Once the host is ready, learn its transport-encryption posture from the cookie-free bootstrap
  // endpoint (never /api/config — that mints a session and would steal the one-time `firstUser` admin
  // grant from the operator). The key is stable for the life of the boot, so this fires once per
  // "become ready" transition, not on a poll.
  useEffect(() => {
    if (Platform.OS !== 'android' || status !== 'ready') {
      return;
    }
    let cancelled = false;
    // Gate WebView mounting on this fetch settling (or the timeout below) — see `webViewReady`'s
    // comment (G7). `finish` fires exactly once regardless of which path (success/no-payload/error/
    // timeout) gets there first.
    let settled = false;
    const finish = () => {
      if (cancelled || settled) {
        return;
      }
      settled = true;
      setWebViewReady(true);
    };
    const timeoutId = setTimeout(finish, BOOTSTRAP_KEY_TIMEOUT_MS);
    fetch(`${LOAM_URL}/api/bootstrap`, { credentials: 'omit' })
      .then((response) => (response.ok ? (response.json() as Promise<BootstrapPayload>) : null))
      .then((payload) => {
        if (cancelled || !payload) {
          return;
        }
        const { transportEncryption, transportPublicKey } = payload.networkConfig ?? {};
        if (transportEncryption && transportEncryption !== 'off' && typeof transportPublicKey === 'string' && transportPublicKey.length > 0) {
          // Defensive: the fragment gets embedded straight into a URL string below (G10c) — encode it
          // so a key value that somehow contained a fragment-breaking character can't malform the URL.
          setTransportKeyFragment(`#k=${encodeURIComponent(transportPublicKey)}`);
        }
      })
      .catch(() => {
        // Best-effort: the host still loads over a plain URL, same as transport encryption being off.
      })
      .finally(() => {
        clearTimeout(timeoutId);
        finish();
      });
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [status]);

  // Ask the launcher for fresh addresses whenever the Share overlay opens — that's when the hotspot
  // starts and its AP interface (and address) appears.
  useEffect(() => {
    if (shareOpen) {
      try {
        nodejs.channel.post('loam-hostinfo-request');
      } catch {
        // best-effort; the launcher also re-posts on an interval
      }
    }
  }, [shareOpen]);

  // A WebView load failure after the node is ready is usually transient (page fetched mid-cold-start).
  // Surface the error UI; Retry remounts the WebView (a fresh load) as long as the node is still up.
  const failWebView = (message: string) => {
    setStatus('error');
    setErrorMessage(message);
  };

  // "Preserve old database & start fresh" (AF8/design#1, P1-1): ask the launcher to write the
  // confirmation marker. As of Sol round 3 this ALSO makes main.js retry boot immediately, in the SAME
  // still-alive Node runtime (see its `loam-db-start-fresh` listener) — no app restart needed any more.
  // `onStatus`'s `'ready'` branch clears the fatal `dbUnreadable` block automatically once that retry
  // succeeds (and resets this busy/message state); if it fails again, a fresh `db_encryption_unreadable`
  // `'error'` status simply replaces this one.
  const handleStartFresh = async () => {
    setStartFreshBusy(true);
    setStartFreshMessage(undefined);
    // Accidental-lockout recovery: PRESERVE the old (unreadable/plaintext) database on disk rather
    // than deleting it — the operator is recovering from a key/mode mismatch, not wiping the node.
    const result = await requestDbStartFresh(nodejs.channel, 'preserve');
    if (!result.ok) {
      // The marker write itself failed — main.js never got to (re)invoke boot, so there is no retry in
      // flight to wait for; safe to let the operator try again immediately.
      setStartFreshBusy(false);
      setStartFreshMessage(`Couldn't confirm — ${result.error ?? 'unknown error'}. You can try again.`);
      return;
    }
    // RF2: main.js's `loam-db-start-fresh` listener retries boot immediately after this ack. Leave
    // `startFreshBusy` true past this point — NOT just until the ack returns — until that retry's
    // OUTCOME is actually observed (`onStatus`'s `'ready'` or `'error'` branch above, both of which
    // reset it). Otherwise the button re-enables while the retry is still mid-flight and a second tap
    // could race a second in-process reboot attempt against the first — main.js and embedded-main.ts
    // both now also guard against that directly, but the UI should never even offer the chance.
    setStartFreshMessage(
      'Confirmed — the old database is preserved on disk and a fresh one is starting now…',
    );
  };

  // `db_encryption_locked` recovery (P1-1, Sol round 4): store the entered passphrase, then ask main.js
  // to retry the whole key-resolution-and-boot pipeline from scratch (`loam-db-unlock`) — there was no
  // server to "reboot" here (unlike `handleStartFresh` above, this failure never even required the
  // server bundle), just a key to try resolving again now that a passphrase exists.
  const handleUnlockWithPassphrase = async () => {
    const trimmed = unlockPassphraseInput;
    if (!trimmed) {
      return;
    }
    setUnlockBusy(true);
    setUnlockMessage(undefined);
    // P2-a (Sol round 6): store the entry as an unverified CANDIDATE, NOT as the committed passphrase.
    // resolveDbKey tries the candidate (only when nothing is committed) and it's promoted to the stored
    // passphrase only once the DB actually opens under it (markPassphraseKeyMigrated). So a wrong guess
    // here can never overwrite an intact stored passphrase and strand the database — it stays recoverable
    // for another attempt.
    await setPassphraseCandidate(trimmed);
    // P1-b (Sol round 6): transactionally record the mode-name hint so a later transient key-request
    // failure locks (rather than plaintext-boots) this passphrase-mode node. Best-effort — the mode is
    // already persisted in SecureStore regardless.
    void setDbModeHint(nodejs.channel, lockedMode ?? 'passphrase');
    setUnlockPassphraseInput('');
    const result = await requestDbUnlock(nodejs.channel);
    if (!result.ok) {
      setUnlockBusy(false);
      setUnlockMessage(`Couldn't confirm — ${result.error ?? 'unknown error'}. You can try again.`);
      return;
    }
    // The retry's OUTCOME (ready / still locked / a different boot error) arrives the normal way, via
    // `loam-status` — see `onStatus`'s `'ready'`/`'error'` branches, both of which reset `unlockBusy`.
    setUnlockMessage('Retrying with the new passphrase…');
  };

  // Persistent-mode `db_encryption_locked` recovery (e.g. after a transient Keystore hiccup) — no
  // passphrase involved, just ask main.js to retry key resolution.
  const handleRetryUnlock = async () => {
    setUnlockBusy(true);
    setUnlockMessage(undefined);
    // P1-b (Sol round 6): re-assert the mode-name hint for the known locked mode so a subsequent transient
    // key-request failure locks rather than downgrading to plaintext. Best-effort; skipped if the mode
    // couldn't be read (a transient read-error leaves `lockedMode` undefined — see the effect above).
    if (lockedMode) {
      void setDbModeHint(nodejs.channel, lockedMode);
    }
    const result = await requestDbUnlock(nodejs.channel);
    if (!result.ok) {
      setUnlockBusy(false);
      setUnlockMessage(`Couldn't confirm — ${result.error ?? 'unknown error'}. You can try again.`);
      return;
    }
    setUnlockMessage('Retrying…');
  };

  // `db_encryption_plaintext_unconverted` recovery (P1-4-RN, Sol round 8): the operator selected an
  // encrypted mode but an existing PLAINTEXT database is on disk, which can't be keyed in place — the
  // server refuses to silently serve plaintext under an encrypted selection. "Switch encryption back off"
  // persists mode 'off' (so the server can open the existing plaintext DB) via the same serialized
  // hint+mode transaction the picker uses, then asks main.js to retry key-resolution-and-boot. The
  // DESTRUCTIVE alternative — "Delete existing data & start encrypted" — reuses `handleStartFresh` (the
  // start-fresh marker, which the server consumes to delete the plaintext DB and boot a fresh keyed one).
  const handleRevertToOff = async () => {
    setRevertBusy(true);
    setRevertMessage(undefined);
    const outcome = await applyDbModeChange('off', {
      readMode: getDbEncryptionMode,
      writeMode: setDbEncryptionMode,
      writeHint: (m) => setDbModeHint(nodejs.channel, m),
    });
    if (!outcome.applied) {
      setRevertBusy(false);
      setRevertMessage(`Couldn't switch encryption off — ${outcome.error ?? 'unknown error'}. You can try again.`);
      return;
    }
    const result = await requestDbUnlock(nodejs.channel);
    if (!result.ok) {
      setRevertBusy(false);
      setRevertMessage(`Couldn't retry — ${result.error ?? 'unknown error'}. You can try again.`);
      return;
    }
    // The retry's OUTCOME (ready / a different boot error) arrives via `loam-status` — see onStatus's
    // 'ready'/'error' branches, both of which reset `revertBusy`.
    setRevertMessage('Switching encryption off and restarting…');
  };

  // Bridge from the WebView's web content (the LOAM client) back to this native screen. The client's
  // `wipe` WS-event handler (apps/client/src/app.tsx) posts `{"type":"loam-wipe"}` via
  // `window.ReactNativeWebView.postMessage` when the SERVER announces a node reset, and future message
  // types may be added. All routing/policy lives in the exported, unit-testable
  // `handleClientWebViewMessage`; crucially, `loam-wipe` is a native NO-OP there — the device key is NOT
  // cleared from this unauthenticated WebView-origin message. Fixed-key rotation happens EXCLUSIVELY via
  // the acknowledged, phase-gated `loam-wipe-restart` -> verified clear -> `loam-wipe-complete` protocol
  // (`attemptWipeKeyClear`); see `handleClientWebViewMessage`'s doc comment for the full rationale.
  const handleWebViewMessage = (event: { nativeEvent: { data: string } }) => {
    handleClientWebViewMessage(event.nativeEvent.data);
  };

  if (Platform.OS !== 'android') {
    return (
      <ThemedView style={styles.center}>
        <ThemedText type="subtitle">LOAM host</ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.centerText}>
          The embedded host runs on Android. Build and install the APK on a device to run it.
        </ThemedText>
      </ThemedView>
    );
  }

  if (status === 'ready') {
    return (
      <SafeAreaView style={styles.flex} edges={['top']}>
        {/* Compact host bar above the WebView. Kept as a sibling *above* (not overlapping) the
            WebView: an Android WebView swallows touches on any native view layered over it, so a
            floating button on top wouldn't register — a top bar reliably does. */}
        <ThemedView type="backgroundElement" style={styles.topBar}>
          <ThemedText type="smallBold">LOAM host</ThemedText>
          <ThemedView style={styles.topBarActions}>
            <Pressable
              onPress={() => setModelManagerOpen(true)}
              accessibilityRole="button"
              accessibilityLabel="Manage the on-device AI model"
              style={styles.secondaryButton}>
              <ThemedText type="smallBold">AI model</ThemedText>
            </Pressable>
            <Pressable
              onPress={() => setDbEncryptionOpen(true)}
              accessibilityRole="button"
              accessibilityLabel="On-device encryption settings"
              style={styles.secondaryButton}>
              <ThemedText type="smallBold">Encryption</ThemedText>
            </Pressable>
            <Pressable
              onPress={() => setShareOpen(true)}
              accessibilityRole="button"
              accessibilityLabel="Share or host this LOAM node"
              style={styles.shareButton}>
              <ThemedText type="smallBold" style={styles.shareButtonLabel}>
                Share · Host
              </ThemedText>
            </Pressable>
          </ThemedView>
        </ThemedView>
        {/* Persistent boot notice (AF2/P1-4): rendered as a sibling ABOVE the WebView, same reasoning
            as the top bar's comment — an overlay wouldn't receive touches. Survives 'ready' (unlike the
            old behaviour, where this arrived as a terminal 'error' and got wiped the moment 'ready'
            followed) and stays until the operator dismisses it. Never carries `DB_UNREADABLE_CODE`
            (P1-1, Sol round 3) — that code means boot genuinely failed, so `status` can't be `'ready'`
            while it's active; it gets its own FATAL block in the non-ready view below instead. */}
        {notice && !noticeDismissed ? (
          <ThemedView type="backgroundSelected" style={styles.noticeBanner}>
            <ThemedText type="small" style={styles.noticeBannerText}>
              {notice.message ?? 'A database-encryption setting was downgraded during startup.'}
            </ThemedText>
            <ThemedView style={styles.noticeBannerActions}>
              <Pressable onPress={() => setDbEncryptionOpen(true)} accessibilityRole="button">
                <ThemedText type="link">Encryption settings</ThemedText>
              </Pressable>
              <Pressable onPress={() => setNoticeDismissed(true)} accessibilityRole="button" hitSlop={Spacing.two}>
                <ThemedText type="link">Dismiss</ThemedText>
              </Pressable>
            </ThemedView>
          </ThemedView>
        ) : null}
        {/* P1-2(b): a wipe-key-clear attempt failed and was NOT acked as complete — see the matching
            block in the non-ready view below for the full explanation. Shown here too since the
            `loam-wipe-restart` signal can arrive while `status` is still `'ready'` (the WebView usually
            fails moments later once the server 503s everything, but this must not depend on that). */}
        {wipeClearFailure ? (
          <ThemedView type="backgroundSelected" style={styles.noticeBanner}>
            <ThemedText type="small" style={styles.noticeBannerText}>
              Couldn't clear the device encryption key: {wipeClearFailure}
            </ThemedText>
            <ThemedView style={styles.noticeBannerActions}>
              <Pressable onPress={() => void attemptWipeKeyClear()} disabled={wipeClearBusy} accessibilityRole="button">
                <ThemedText type="link">{wipeClearBusy ? 'Retrying…' : 'Retry'}</ThemedText>
              </Pressable>
            </ThemedView>
          </ThemedView>
        ) : null}
        {webViewReady ? (
          <WebView
            ref={webViewRef}
            source={{ uri: `${LOAM_URL}${transportKeyFragment}` }}
            style={styles.flex}
            // The LOAM client relies on the loam_session cookie, localStorage/IndexedDB, and a
            // WebSocket — enable all of them, and allow the cleartext localhost origin.
            javaScriptEnabled
            domStorageEnabled
            thirdPartyCookiesEnabled
            sharedCookiesEnabled
            cacheEnabled
            // Bridge from the LOAM web client back to this native screen (AF1/Sol P1-1) — see
            // `handleWebViewMessage`'s comment.
            onMessage={handleWebViewMessage}
            // Keep the WebView pinned to the embedded server's origin. originWhitelist is a coarse
            // prefix guard; onShouldStartLoadWithRequest is the real one — it allows only LOAM-origin
            // navigations and shunts external links (the client opens them with target=_blank) to the
            // system browser, so the host frame never leaves LOAM.
            originWhitelist={['http://localhost:3000']}
            onShouldStartLoadWithRequest={(request) => {
              if (isLoamUrl(request.url)) {
                return true;
              }
              if (/^https?:\/\//i.test(request.url)) {
                void Linking.openURL(request.url).catch(() => undefined);
              }
              return false;
            }}
            mixedContentMode="always"
            onError={({ nativeEvent }) => {
              console.warn('LOAM WebView error', nativeEvent.description);
              failWebView(nativeEvent.description || 'The LOAM page failed to load.');
            }}
            onHttpError={({ nativeEvent }) => {
              console.warn('LOAM WebView HTTP error', nativeEvent.statusCode, nativeEvent.url);
              // Any HTTP error from the LOAM origin is fatal (on Android onHttpError is the main frame);
              // compare origins so a redirect to /channels or a trailing slash still matches.
              if (isLoamUrl(nativeEvent.url)) {
                failWebView(`The LOAM server returned HTTP ${nativeEvent.statusCode}.`);
              }
            }}
          />
        ) : (
          // Held back until the bootstrap key fetch settles (G7) — see `webViewReady`'s comment. This
          // window is normally sub-second (a loopback fetch to the just-booted server).
          <ThemedView style={styles.webViewLoading}>
            <ActivityIndicator size="large" style={styles.spinner} />
          </ThemedView>
        )}
        <HostShareOverlay
          visible={shareOpen}
          onClose={() => setShareOpen(false)}
          serverUrl={`${hotspotJoinUrl(hostAddresses)}${transportKeyFragment}`}
          addresses={hostAddresses}
          keepAwake={keepAwake}
          onKeepAwakeChange={setKeepAwake}
          kiosk={kiosk}
          onKioskChange={setKiosk}
        />
        <ModelManagerOverlay
          visible={modelManagerOpen}
          onClose={() => setModelManagerOpen(false)}
          channel={nodejs.channel}
        />
        <DbEncryptionSettingsOverlay
          visible={dbEncryptionOpen}
          onClose={() => setDbEncryptionOpen(false)}
          channel={nodejs.channel}
        />
      </SafeAreaView>
    );
  }

  // A boot failure that looks DB-encryption-related (G2): the operator needs a way to switch back to
  // Off and restart even though the host never became ready — surfaced below regardless of whether
  // this is the plain "starting" spinner or the error screen. Excludes `DB_UNREADABLE_CODE`/
  // `DB_LOCKED_CODE`: both get their own dedicated, more specific fatal block (below) rather than this
  // generic fallback one.
  const dbEncryptionSuspect =
    status === 'error' &&
    errorCode !== undefined &&
    errorCode !== DB_UNREADABLE_CODE &&
    errorCode !== DB_LOCKED_CODE &&
    errorCode !== DB_ENCRYPTION_PLAINTEXT_UNCONVERTED_CODE &&
    DB_ENCRYPTION_ERROR_CODES.has(errorCode);
  // FATAL db_encryption_unreadable (P1-1, Sol round 3, AF8/design#1): boot genuinely failed and the
  // embedded runtime stayed alive specifically so this recovery can work — see DB_UNREADABLE_CODE's
  // comment. `status` can only be `'error'` while this is active (never `'ready'`), and a subsequent
  // `'ready'` clears it automatically (the `onStatus` 'ready' branch resets `errorCode`).
  const dbUnreadable = status === 'error' && errorCode === DB_UNREADABLE_CODE;
  // FATAL db_encryption_plaintext_unconverted (P1-4-RN, Sol round 8): an encrypted mode is selected but
  // the on-disk DB is still plaintext, which can't be keyed in place. Its own destructive-recovery block
  // (delete existing data & start encrypted, or switch encryption back off) — never a silent plaintext
  // downgrade under an encrypted selection. Uses the shared code→recovery classifier for the mapping.
  const dbPlaintextUnconverted = status === 'error' && dbEncryptionRecoveryForCode(errorCode) === 'plaintext-unconverted';

  return (
    <ThemedView style={styles.center}>
      <ThemedText type="title">LOAM host</ThemedText>
      {/* Persistent boot notice (AF2/P1-4), shown here too so it's visible even while still "starting"
          or on the generic timeout/error screen — independent of `status`. Never carries
          `DB_UNREADABLE_CODE` any more (P1-1) — that gets the dedicated FATAL block below instead,
          since (unlike every other notice code) it means boot did NOT keep running. */}
      {notice && !noticeDismissed ? (
        <ThemedView type="backgroundSelected" style={styles.dbEncryptionNotice}>
          <ThemedText type="smallBold">A database-encryption setting was downgraded during startup.</ThemedText>
          <ThemedText type="small" themeColor="textSecondary" style={styles.centerText}>
            {notice.message ?? 'See Encryption settings below for details.'}
          </ThemedText>
          <ThemedView style={styles.noticeBannerActions}>
            <Pressable onPress={() => setNoticeDismissed(true)} accessibilityRole="button" hitSlop={Spacing.two}>
              <ThemedText type="link">Dismiss</ThemedText>
            </Pressable>
          </ThemedView>
        </ThemedView>
      ) : null}
      {/* FATAL, NOT dismissible (P1-1, Sol round 3, AF8/design#1) — an existing encrypted database the
          current key can't open. The server refuses to auto-replace an unreadable DB, so "Preserve old
          database & start fresh" (an explicit, one-shot operator confirmation) is the only way forward
          short of reinstalling; a subsequent `ready` (the in-process retry succeeding) clears this. */}
      {dbUnreadable ? (
        <ThemedView type="backgroundSelected" style={styles.dbEncryptionNotice}>
          <ThemedText type="smallBold">The on-device database couldn't be opened with the current key.</ThemedText>
          <ThemedText type="small" themeColor="textSecondary" style={styles.centerText}>
            {errorMessage ?? 'See Encryption settings below for details.'}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary" style={styles.centerText}>
            The old database is never deleted automatically. Preserve it and start a fresh one below, or
            open Encryption settings to change the mode back.
          </ThemedText>
          <ThemedView style={styles.noticeBannerActions}>
            <Pressable onPress={() => void handleStartFresh()} disabled={startFreshBusy} accessibilityRole="button">
              <ThemedView type="backgroundElement" style={styles.retry}>
                <ThemedText type="link">
                  {startFreshBusy ? 'Confirming…' : 'Preserve old database & start fresh'}
                </ThemedText>
              </ThemedView>
            </Pressable>
          </ThemedView>
          {startFreshMessage ? (
            <ThemedText type="small" themeColor="textSecondary" style={styles.centerText}>
              {startFreshMessage}
            </ThemedText>
          ) : null}
        </ThemedView>
      ) : null}
      {/* FATAL, NOT dismissible (P1-1, Sol round 4) — a `persistent`/`passphrase` boot found no usable
          key at all and refused to start the server rather than silently fall back to plaintext.
          Passphrase mode gets an inline "enter passphrase to unlock" input; persistent mode (or
          passphrase mode too, e.g. after saving the passphrase) gets a plain Retry. A subsequent `ready`
          clears this the same way it clears `dbUnreadable` above. */}
      {dbLocked ? (
        <ThemedView type="backgroundSelected" style={styles.dbEncryptionNotice}>
          <ThemedText type="smallBold">On-device encryption is locked.</ThemedText>
          <ThemedText type="small" themeColor="textSecondary" style={styles.centerText}>
            {errorMessage ?? 'The selected encryption mode has no usable key yet.'}
          </ThemedText>
          {lockedMode === 'passphrase' ? (
            <>
              <ThemedText type="small" themeColor="textSecondary" style={styles.centerText}>
                Enter the passphrase to unlock and start the database.
              </ThemedText>
              <TextInput
                value={unlockPassphraseInput}
                onChangeText={setUnlockPassphraseInput}
                placeholder="Enter the passphrase"
                placeholderTextColor={theme.textSecondary}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                style={[styles.textInput, { color: theme.text, borderColor: theme.textSecondary }]}
              />
              <ThemedView style={styles.noticeBannerActions}>
                <Pressable
                  onPress={() => void handleUnlockWithPassphrase()}
                  disabled={unlockBusy || !unlockPassphraseInput}
                  accessibilityRole="button">
                  <ThemedView type="backgroundElement" style={styles.retry}>
                    <ThemedText type="link">{unlockBusy ? 'Unlocking…' : 'Unlock'}</ThemedText>
                  </ThemedView>
                </Pressable>
              </ThemedView>
            </>
          ) : null}
          <ThemedView style={styles.noticeBannerActions}>
            <Pressable onPress={() => void handleRetryUnlock()} disabled={unlockBusy} accessibilityRole="button">
              <ThemedView type="backgroundElement" style={styles.retry}>
                <ThemedText type="link">{unlockBusy ? 'Retrying…' : 'Retry'}</ThemedText>
              </ThemedView>
            </Pressable>
          </ThemedView>
          {unlockMessage ? (
            <ThemedText type="small" themeColor="textSecondary" style={styles.centerText}>
              {unlockMessage}
            </ThemedText>
          ) : null}
        </ThemedView>
      ) : null}
      {/* FATAL, NOT dismissible (P1-4-RN, Sol round 8) — an encrypted mode is selected but an existing
          PLAINTEXT database is on disk. There is no in-place plaintext→encrypted conversion, so the host
          must NEVER silently serve plaintext under an encrypted selection: the operator must explicitly
          choose to delete the existing data and start a fresh encrypted database, or switch encryption
          back off to keep the existing unencrypted data. A subsequent `ready` clears this (onStatus). */}
      {dbPlaintextUnconverted ? (
        <ThemedView type="backgroundSelected" style={styles.dbEncryptionNotice}>
          <ThemedText type="smallBold">Encryption is on, but the existing database is unencrypted.</ThemedText>
          <ThemedText type="small" themeColor="textSecondary" style={styles.centerText}>
            {errorMessage ??
              'The selected encrypted mode can only apply to a fresh database — an existing plaintext database cannot be converted in place.'}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary" style={styles.centerText}>
            Delete the existing data and start a fresh encrypted database, or switch encryption back off to
            keep the existing (unencrypted) data. In-place conversion is a future enhancement — not yet
            available.
          </ThemedText>
          <ThemedView style={styles.noticeBannerActions}>
            <Pressable onPress={() => void handleStartFresh()} disabled={startFreshBusy || revertBusy} accessibilityRole="button">
              <ThemedView type="backgroundElement" style={styles.retry}>
                <ThemedText type="link">
                  {startFreshBusy ? 'Starting…' : 'Delete existing data & start encrypted'}
                </ThemedText>
              </ThemedView>
            </Pressable>
            <Pressable onPress={() => void handleRevertToOff()} disabled={startFreshBusy || revertBusy} accessibilityRole="button">
              <ThemedView type="backgroundElement" style={styles.retry}>
                <ThemedText type="link">{revertBusy ? 'Switching…' : 'Switch encryption back off'}</ThemedText>
              </ThemedView>
            </Pressable>
          </ThemedView>
          {startFreshMessage ? (
            <ThemedText type="small" themeColor="textSecondary" style={styles.centerText}>
              {startFreshMessage}
            </ThemedText>
          ) : null}
          {revertMessage ? (
            <ThemedText type="small" themeColor="textSecondary" style={styles.centerText}>
              {revertMessage}
            </ThemedText>
          ) : null}
        </ThemedView>
      ) : null}
      {/* P1-2(b): a wipe-key-clear attempt failed and was NOT acked as complete — the launcher's durable
          marker is still pending, so this must never look like a benign notice; it stays until a retry
          succeeds. Shown in both the ready and non-ready views (see the matching block above) since a
          wipe-restart signal can arrive at any time. */}
      {wipeClearFailure ? (
        <ThemedView type="backgroundSelected" style={styles.dbEncryptionNotice}>
          <ThemedText type="smallBold">Couldn't clear the device encryption key.</ThemedText>
          <ThemedText type="small" themeColor="textSecondary" style={styles.centerText}>
            {wipeClearFailure}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary" style={styles.centerText}>
            The old encrypted database was already deleted, but the emergency-reset key itself is still
            on this device until this succeeds.
          </ThemedText>
          <ThemedView style={styles.noticeBannerActions}>
            <Pressable onPress={() => void attemptWipeKeyClear()} disabled={wipeClearBusy} accessibilityRole="button">
              <ThemedView type="backgroundElement" style={styles.retry}>
                <ThemedText type="link">{wipeClearBusy ? 'Retrying…' : 'Retry'}</ThemedText>
              </ThemedView>
            </Pressable>
          </ThemedView>
        </ThemedView>
      ) : null}
      {status === 'starting' ? (
        <>
          <ActivityIndicator size="large" style={styles.spinner} />
          <ThemedText type="subtitle">Starting host…</ThemedText>
          <ThemedText type="small" themeColor="textSecondary" style={styles.centerText}>
            Booting the embedded server. First launch can take up to a minute.
          </ThemedText>
        </>
      ) : (
        <>
          <ThemedText type="subtitle">
            {nodeStatus === 'ready' ? 'Couldn’t load LOAM' : 'Host failed to start'}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary" style={styles.centerText}>
            {errorMessage ?? 'The embedded server did not become ready.'}
          </ThemedText>
          {dbEncryptionSuspect ? (
            <ThemedView type="backgroundSelected" style={styles.dbEncryptionNotice}>
              <ThemedText type="smallBold">This looks like a database-encryption problem.</ThemedText>
              <ThemedText type="small" themeColor="textSecondary" style={styles.centerText}>
                Open Encryption settings below, switch the mode back to Off, then close and reopen the
                app.
              </ThemedText>
            </ThemedView>
          ) : null}
          {nodeStatus === 'ready' ? (
            // The server is up; a Retry just remounts the WebView for a fresh load.
            <Pressable
              onPress={() => {
                setErrorMessage(undefined);
                setStatus('ready');
              }}>
              <ThemedView type="backgroundElement" style={styles.retry}>
                <ThemedText type="link">Retry</ThemedText>
              </ThemedView>
            </Pressable>
          ) : dbUnreadable || dbLocked || dbPlaintextUnconverted ? null : (
            // The embedded runtime can't restart in-process (nodejs-mobile is one-shot per process) —
            // except for `dbUnreadable` (P1-1, Sol round 3), `dbLocked` (P1-1, Sol round 4), and
            // `dbPlaintextUnconverted` (P1-4-RN, Sol round 8), all of which have their own in-app recovery
            // above and deliberately do NOT show this text: closing/reopening WITHOUT using that recovery
            // first would just hit the identical failure again (nothing changed), so this generic
            // instruction would be actively misleading.
            <ThemedText type="small" themeColor="textSecondary" style={styles.centerText}>
              Close and reopen the app to try again.
            </ThemedText>
          )}
        </>
      )}
      {/* Reachable even when the host never became ready (G2) — an unopenable/undecryptable DB under
          an encrypted mode would otherwise lock the operator out with no way back to Off. */}
      <Pressable
        onPress={() => setDbEncryptionOpen(true)}
        accessibilityRole="button"
        accessibilityLabel="On-device encryption settings">
        <ThemedView type="backgroundElement" style={styles.retry}>
          <ThemedText type="link">Encryption settings</ThemedText>
        </ThemedView>
      </Pressable>
      {/* P1-1 (Sol round 7, hole 4): pass the bridge `channel` here too. Without it, a mode change made
          through this LOCKED/error-screen recovery UI couldn't write the mode-NAME hint at all — so an
          off→encrypted (or encrypted→off) change here left the hint stale and a later transient
          key-request failure would resolve it the wrong way. */}
      <DbEncryptionSettingsOverlay
        visible={dbEncryptionOpen}
        onClose={() => setDbEncryptionOpen(false)}
        channel={nodejs.channel}
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  webViewLoading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    padding: Spacing.four,
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
  },
  centerText: {
    textAlign: 'center',
  },
  spinner: {
    marginBottom: Spacing.two,
  },
  retry: {
    marginTop: Spacing.three,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two,
    borderRadius: Spacing.four,
  },
  dbEncryptionNotice: {
    marginTop: Spacing.three,
    gap: Spacing.one,
    padding: Spacing.three,
    borderRadius: Spacing.three,
  },
  textInput: {
    borderWidth: 1,
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.two,
  },
  noticeBanner: {
    gap: Spacing.one,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  noticeBannerText: {
    flexShrink: 1,
  },
  noticeBannerActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.three,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  topBarActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    backgroundColor: 'transparent',
  },
  secondaryButton: {
    borderWidth: 1,
    borderColor: '#208AEF',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
    borderRadius: Spacing.five,
  },
  shareButton: {
    backgroundColor: '#208AEF',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
    borderRadius: Spacing.five,
  },
  // Fixed white on the brand-blue pill so the label reads regardless of the active theme.
  shareButtonLabel: {
    color: '#ffffff',
  },
});
