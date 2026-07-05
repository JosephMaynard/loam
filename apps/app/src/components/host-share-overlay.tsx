import Constants from 'expo-constants';
import { useEffect } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Switch } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { HostPanel, type HostState } from '@/components/host-panel';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { ensureHotspot, useHotspot, type HotspotState } from '@/hooks/use-hotspot';

/** Project the hotspot lifecycle onto the presentational HostPanel state (docs/04 two-step flow). */
function toHostState(hotspot: HotspotState, serverUrl: string, addresses: string[]): HostState {
  if (hotspot.phase === 'running' && hotspot.credentials) {
    return { status: 'running', hotspot: hotspot.credentials, serverUrl, addresses };
  }
  if (hotspot.phase === 'error') {
    // Hotspot couldn't start — surface the reason in Step 1 but keep Step 2's URL QR so LOAM stays
    // reachable to anyone already on this network (the graceful-degradation path the emulator hits).
    return { status: 'stopped', hotspotError: hotspot.error, serverUrl, addresses };
  }
  return { status: 'starting', serverUrl, addresses };
}

type HostShareOverlayProps = {
  visible: boolean;
  onClose: () => void;
  /**
   * The LAN URL joiners open once connected — built from the host's real hotspot address when the
   * launcher has reported it, else the documented LocalOnlyHotspot fallback. Renders even before the
   * hotspot is up so Step 2's QR always shows.
   */
  serverUrl: string;
  /** All of the host's detected IPv4 addresses, shown under Step 2 so a joiner can try alternatives. */
  addresses: string[];
  /** Whether to keep the screen on while hosting (for a host left on display). */
  keepAwake: boolean;
  onKeepAwakeChange: (value: boolean) => void;
  /** Whether to pin the app (Android screen pinning) so it can't be left without the device PIN. */
  kiosk: boolean;
  onKioskChange: (value: boolean) => void;
};

/**
 * A full-screen modal over the host WebView that shares this node: it starts the local-only hotspot
 * (requesting permission first) and renders the two-step join flow via `HostPanel`. If the hotspot
 * can't start — no WiFi hardware on an emulator, or a denied permission — it shows a clear message
 * and still renders the Step-2 LOAM-URL QR, never crashing or hanging (docs/04).
 */
export function HostShareOverlay({
  visible,
  onClose,
  serverUrl,
  addresses,
  keepAwake,
  onKeepAwakeChange,
  kiosk,
  onKioskChange,
}: HostShareOverlayProps) {
  const hotspot = useHotspot();
  const version = Constants.expoConfig?.version ?? '?';

  // Start the hotspot the first time the overlay opens. `ensureHotspot` is idempotent (no-ops while
  // in flight or already running), and we intentionally leave the hotspot up after close so joiners
  // stay connected while the host app runs.
  useEffect(() => {
    if (visible) {
      void ensureHotspot();
    }
  }, [visible]);

  const state = toHostState(hotspot, serverUrl, addresses);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaProvider>
        <ThemedView style={styles.container}>
          <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
            <ThemedView style={styles.header}>
              <Pressable onPress={onClose} accessibilityRole="button" hitSlop={Spacing.two}>
                <ThemedText type="link">Done</ThemedText>
              </Pressable>
            </ThemedView>
            <ScrollView
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator={false}>
              <HostPanel state={state} />

              <ThemedView type="backgroundElement" style={styles.settingRow}>
                <ThemedView style={styles.settingText}>
                  <ThemedText type="smallBold">Keep screen on</ThemedText>
                  <ThemedText type="small" themeColor="textSecondary">
                    For a host left on display (e.g. taped to a wall). Uses more battery.
                  </ThemedText>
                </ThemedView>
                <Switch value={keepAwake} onValueChange={onKeepAwakeChange} />
              </ThemedView>

              <ThemedView type="backgroundElement" style={styles.settingRow}>
                <ThemedView style={styles.settingText}>
                  <ThemedText type="smallBold">Kiosk mode</ThemedText>
                  <ThemedText type="small" themeColor="textSecondary">
                    Pins LOAM to the screen so it can&apos;t be left. To exit, hold Back + Recents —
                    the phone&apos;s own screen-lock PIN is required (set one first).
                  </ThemedText>
                </ThemedView>
                <Switch value={kiosk} onValueChange={onKioskChange} />
              </ThemedView>

              <ThemedText type="small" themeColor="textSecondary" style={styles.version}>
                LOAM v{version}
              </ThemedText>
            </ScrollView>
          </SafeAreaView>
        </ThemedView>
      </SafeAreaProvider>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two,
  },
  scrollContent: {
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.five,
    gap: Spacing.three,
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
    padding: Spacing.four,
    borderRadius: Spacing.four,
  },
  settingText: {
    flex: 1,
    gap: Spacing.one,
    backgroundColor: 'transparent',
  },
  version: {
    textAlign: 'center',
    paddingTop: Spacing.two,
  },
});
