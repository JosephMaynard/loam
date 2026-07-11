import nodejs from '@comapeo/nodejs-mobile-react-native';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';

import { HostShareOverlay } from '@/components/host-share-overlay';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { registerOnDeviceLlm } from '@/lib/on-device-llm';
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
type StatusPayload = { status?: HostStatus; message?: string };
type HostInfoPayload = { port?: number; addresses?: string[] };

// nodejs-mobile allows exactly one runtime per process; a screen remount must not start it twice,
// and — since the runtime can't restart and won't re-emit — the last status is kept at module scope
// so a remount reflects reality instead of resetting to "starting" forever.
let nodeStarted = false;
let nodeStatus: HostStatus = 'starting';

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
  // Whether the "Share / Host" overlay (hotspot + two-step join QRs) is open.
  const [shareOpen, setShareOpen] = useState(false);
  // The host's real network addresses, reported by the launcher (loam-hostinfo). Used to build the
  // Step-2 join QR from the actual hotspot IP instead of a hardcoded guess.
  const [hostAddresses, setHostAddresses] = useState<string[]>([]);
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
        // Keep the host alive when the screen locks (docs/04). Best-effort — a device that refuses
        // the foreground service just falls back to foreground-only hosting.
        startHostService();
      } else if (payload?.status === 'error') {
        clearTimeout(startupTimeout);
        nodeStatus = 'error';
        setStatus('error');
        setErrorMessage(payload.message);
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
    };
  }, []);

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
        <WebView
          ref={webViewRef}
          source={{ uri: LOAM_URL }}
          style={styles.flex}
          // The LOAM client relies on the loam_session cookie, localStorage/IndexedDB, and a
          // WebSocket — enable all of them, and allow the cleartext localhost origin.
          javaScriptEnabled
          domStorageEnabled
          thirdPartyCookiesEnabled
          sharedCookiesEnabled
          cacheEnabled
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
        <HostShareOverlay
          visible={shareOpen}
          onClose={() => setShareOpen(false)}
          serverUrl={hotspotJoinUrl(hostAddresses)}
          addresses={hostAddresses}
          keepAwake={keepAwake}
          onKeepAwakeChange={setKeepAwake}
          kiosk={kiosk}
          onKioskChange={setKiosk}
        />
      </SafeAreaView>
    );
  }

  return (
    <ThemedView style={styles.center}>
      <ThemedText type="title">LOAM host</ThemedText>
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
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
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
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
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
