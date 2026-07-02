import nodejs from '@comapeo/nodejs-mobile-react-native';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';

// The embedded server (main.js → loam-server.js) always listens on this port; the host phone's
// WebView loads it over loopback. Remote joiners use the hotspot IP (initiative 4).
const LOAM_URL = 'http://localhost:3000';

// nodejs-mobile allows exactly one runtime per process; a screen remount must not start it twice.
let nodeStarted = false;

type HostStatus = 'starting' | 'ready' | 'error';
type StatusPayload = { status?: HostStatus; message?: string };

/**
 * The LOAM Android host screen. Boots the embedded Node server on first mount, waits for its
 * readiness signal (posted by main.js once /api/config answers), then loads the served LOAM client
 * in a WebView with cookies + WebSocket enabled. Shows a "starting host…" state until then, since
 * cold start can take ~80s (docs/04).
 */
export default function HostScreen() {
  const [status, setStatus] = useState<HostStatus>('starting');
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const webViewRef = useRef<WebView>(null);

  useEffect(() => {
    if (Platform.OS !== 'android') {
      return;
    }

    const onStatus = (payload: StatusPayload) => {
      if (payload?.status === 'ready') {
        setStatus('ready');
      } else if (payload?.status === 'error') {
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

    return () => nodejs.channel.removeListener('loam-status', onStatus);
  }, []);

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
          originWhitelist={['*']}
          mixedContentMode="always"
          onError={({ nativeEvent }) =>
            console.warn('LOAM WebView error', nativeEvent.description)
          }
          onHttpError={({ nativeEvent }) =>
            console.warn('LOAM WebView HTTP error', nativeEvent.statusCode)
          }
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
          <ThemedText type="subtitle">Host failed to start</ThemedText>
          <ThemedText type="small" themeColor="textSecondary" style={styles.centerText}>
            {errorMessage ?? 'The embedded server did not become ready.'}
          </ThemedText>
          <Pressable
            onPress={() => {
              setStatus('starting');
              setErrorMessage(undefined);
            }}>
            <ThemedView type="backgroundElement" style={styles.retry}>
              <ThemedText type="link">Retry</ThemedText>
            </ThemedView>
          </Pressable>
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
});
