import nodejs from '@comapeo/nodejs-mobile-react-native';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';

import { HostShareOverlay } from '@/components/host-share-overlay';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';

// The embedded server (main.js → loam-server.js) always listens on this port; the host phone's
// WebView loads it over loopback. Remote joiners use the hotspot IP (below).
const LOAM_URL = 'http://localhost:3000';
// Android's WifiManager.LocalOnlyHotspot always assigns the host device this fixed gateway IP, so a
// joiner on the hotspot reaches the embedded server here (docs/04). Known before the hotspot even
// starts, which is why Step 2's URL QR can render regardless of hotspot success.
const HOTSPOT_GATEWAY_URL = 'http://192.168.49.1:3000';
// Cold start is ~80s (docs/04); give it comfortably more before declaring the runtime hung.
const STARTUP_TIMEOUT_MS = 150_000;

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
  const webViewRef = useRef<WebView>(null);

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
      } else if (payload?.status === 'error') {
        clearTimeout(startupTimeout);
        nodeStatus = 'error';
        setStatus('error');
        setErrorMessage(payload.message);
      }
    };

    nodejs.channel.addListener('loam-status', onStatus);

    if (!nodeStarted) {
      nodeStarted = true;
      // redirectOutputToLogcat: server logs land under the NODEJS-MOBILE tag (adb logcat proof).
      nodejs.start('main.js', { redirectOutputToLogcat: true });
    }

    return () => {
      clearTimeout(startupTimeout);
      nodejs.channel.removeListener('loam-status', onStatus);
    };
  }, []);

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
          serverUrl={HOTSPOT_GATEWAY_URL}
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
