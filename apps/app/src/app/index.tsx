import nodejs from '@comapeo/nodejs-mobile-react-native';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Platform, Pressable, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';

import { DbEncryptionSettingsOverlay } from '@/components/db-encryption-settings';
import { HostShareOverlay } from '@/components/host-share-overlay';
import { ModelManagerOverlay } from '@/components/model-manager';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { clearStoredDbKeys, registerDbEncryption, requestDbStartFresh } from '@/lib/db-encryption';
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
]);

// The one DB-encryption notice code with a dedicated recovery action (AF8/design#1, docs/01, docs/15):
// an existing encrypted database the current key can't open. Unlike the other notice codes (which are
// purely informational — boot degraded but continues), this one needs the operator to make an explicit
// choice, so it gets its own persistent block (in both the non-ready and ready views) with a "Preserve
// old database & start fresh" action, rather than just the generic dismissible notice banner.
const DB_UNREADABLE_CODE = 'db_encryption_unreadable';

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
        setErrorCode(payload.code);
      }
    };

    const onHostInfo = (payload: HostInfoPayload) => {
      if (Array.isArray(payload?.addresses)) {
        setHostAddresses(payload.addresses.filter((address): address is string => typeof address === 'string'));
      }
    };

    nodejs.channel.addListener('loam-status', onStatus);
    nodejs.channel.addListener('loam-hostinfo', onHostInfo);
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

  // "Preserve old database & start fresh" (AF8/design#1): ask the launcher to write the confirmation
  // marker, then tell the operator to restart — nodejs-mobile can't restart its runtime in-process
  // (same limitation as every other "takes effect next restart" action in this screen), so there's no
  // in-app way to re-trigger boot after the marker lands.
  const handleStartFresh = async () => {
    setStartFreshBusy(true);
    setStartFreshMessage(undefined);
    const result = await requestDbStartFresh(nodejs.channel);
    setStartFreshBusy(false);
    if (!result.ok) {
      setStartFreshMessage(`Couldn't confirm — ${result.error ?? 'unknown error'}. You can try again.`);
      return;
    }
    setStartFreshMessage('Confirmed. Close and reopen the app to start fresh — the old database is preserved on disk.');
    Alert.alert(
      'Restart LOAM',
      'The old database will be preserved on disk. Close and reopen the app now to start a fresh one.',
    );
  };

  // Bridge from the WebView's web content (the LOAM client) back to this native screen (AF1/Sol P1-1):
  // the client's `wipe` WS-event handler (apps/client/src/app.tsx) posts
  // `{"type":"loam-wipe"}` via `window.ReactNativeWebView.postMessage` whenever the SERVER announces a
  // node wipe (kill switch), so the persistent/passphrase Keystore-held key material can be rotated
  // here rather than silently surviving to "protect" the brand-new post-wipe database. Best-effort and
  // defensive — a malformed/foreign message is just ignored, never thrown.
  const handleWebViewMessage = (event: { nativeEvent: { data: string } }) => {
    try {
      const payload = JSON.parse(event.nativeEvent.data) as { type?: unknown };
      if (payload?.type === 'loam-wipe') {
        void clearStoredDbKeys();
      }
    } catch {
      // not a message this screen understands — ignore.
    }
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
            followed) and stays until the operator dismisses it. */}
        {notice && !noticeDismissed ? (
          <ThemedView type="backgroundSelected" style={styles.noticeBanner}>
            <ThemedText type="small" style={styles.noticeBannerText}>
              {notice.message ?? 'A database-encryption setting was downgraded during startup.'}
            </ThemedText>
            <ThemedView style={styles.noticeBannerActions}>
              {notice.code === DB_UNREADABLE_CODE ? (
                <Pressable
                  onPress={() => void handleStartFresh()}
                  disabled={startFreshBusy}
                  accessibilityRole="button">
                  <ThemedText type="link">
                    {startFreshBusy ? 'Confirming…' : 'Preserve old database & start fresh'}
                  </ThemedText>
                </Pressable>
              ) : null}
              <Pressable onPress={() => setDbEncryptionOpen(true)} accessibilityRole="button">
                <ThemedText type="link">Encryption settings</ThemedText>
              </Pressable>
              <Pressable onPress={() => setNoticeDismissed(true)} accessibilityRole="button" hitSlop={Spacing.two}>
                <ThemedText type="link">Dismiss</ThemedText>
              </Pressable>
            </ThemedView>
            {startFreshMessage ? (
              <ThemedText type="small" themeColor="textSecondary">
                {startFreshMessage}
              </ThemedText>
            ) : null}
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
        <DbEncryptionSettingsOverlay visible={dbEncryptionOpen} onClose={() => setDbEncryptionOpen(false)} />
      </SafeAreaView>
    );
  }

  // A boot failure that looks DB-encryption-related (G2): the operator needs a way to switch back to
  // Off and restart even though the host never became ready — surfaced below regardless of whether
  // this is the plain "starting" spinner or the error screen.
  const dbEncryptionSuspect = status === 'error' && errorCode !== undefined && DB_ENCRYPTION_ERROR_CODES.has(errorCode);

  return (
    <ThemedView style={styles.center}>
      <ThemedText type="title">LOAM host</ThemedText>
      {/* Persistent boot notice (AF2/P1-4), shown here too so it's visible even while still "starting"
          or on the generic timeout/error screen — independent of `status`, unlike `dbEncryptionSuspect`
          below. `db_encryption_unreadable` specifically (AF8/design#1) gets its own explanation + the
          "Preserve old database & start fresh" action, since the server refuses to auto-replace an
          unreadable DB and this is the only way forward short of reinstalling. */}
      {notice && !noticeDismissed ? (
        <ThemedView type="backgroundSelected" style={styles.dbEncryptionNotice}>
          <ThemedText type="smallBold">
            {notice.code === DB_UNREADABLE_CODE
              ? "The on-device database couldn't be opened with the current key."
              : 'A database-encryption setting was downgraded during startup.'}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary" style={styles.centerText}>
            {notice.message ?? 'See Encryption settings below for details.'}
          </ThemedText>
          {notice.code === DB_UNREADABLE_CODE ? (
            <ThemedText type="small" themeColor="textSecondary" style={styles.centerText}>
              The old database is never deleted automatically. Preserve it and start a fresh one below,
              or open Encryption settings to change the mode back.
            </ThemedText>
          ) : null}
          <ThemedView style={styles.noticeBannerActions}>
            {notice.code === DB_UNREADABLE_CODE ? (
              <Pressable onPress={() => void handleStartFresh()} disabled={startFreshBusy} accessibilityRole="button">
                <ThemedView type="backgroundElement" style={styles.retry}>
                  <ThemedText type="link">
                    {startFreshBusy ? 'Confirming…' : 'Preserve old database & start fresh'}
                  </ThemedText>
                </ThemedView>
              </Pressable>
            ) : null}
            <Pressable onPress={() => setNoticeDismissed(true)} accessibilityRole="button" hitSlop={Spacing.two}>
              <ThemedText type="link">Dismiss</ThemedText>
            </Pressable>
          </ThemedView>
          {startFreshMessage ? (
            <ThemedText type="small" themeColor="textSecondary" style={styles.centerText}>
              {startFreshMessage}
            </ThemedText>
          ) : null}
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
          ) : (
            // The embedded runtime can't restart in-process (nodejs-mobile is one-shot per process).
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
      <DbEncryptionSettingsOverlay visible={dbEncryptionOpen} onClose={() => setDbEncryptionOpen(false)} />
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
