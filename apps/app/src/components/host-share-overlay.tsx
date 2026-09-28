import Constants from 'expo-constants';
import { useEffect } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Switch } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { HostPanel } from '@/components/host-panel';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { ensureHotspot, useHotspot } from '@/hooks/use-hotspot';
import { ensureHostService, hostingNotificationDenied } from '@/lib/host-service';
import { deriveJoinDisplay, toHostPanelState } from '@/lib/join-display';

type HostShareOverlayProps = {
  visible: boolean;
  onClose: () => void;
  /**
   * The transport `#k=` key fragment to append to the join URL (empty when transport encryption is off).
   * The join URL host itself is chosen here from the live hotspot state (see `deriveJoinDisplay`): the
   * hotspot's own discovered address while it runs, so a joiner on the hotspot never gets a home-WiFi
   * address the host happens to be on under STA+AP concurrency, nor a guessed gateway.
   */
  transportKeyFragment: string;
  /** All of the host's detected IPv4 addresses, shown under Step 2 so a joiner can try alternatives. */
  addresses: string[];
  /** Peer addresses of the devices connected to LOAM from off this phone (launcher-reported). */
  connectedClients: string[];
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
  transportKeyFragment,
  addresses,
  connectedClients,
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

  // Once the hotspot is up, make sure the foreground host service is too (idempotent) — joiners are now
  // depending on this phone staying reachable with the screen off.
  useEffect(() => {
    if (hotspot.phase === 'running') {
      void ensureHostService();
    }
  }, [hotspot.phase]);

  // When the hotspot is up, joiners are on it — target its own discovered address, and drop the host's
  // other (unreachable-from-the-hotspot) LAN addresses from the "also at" list so we don't send a joiner
  // to an address on the wrong network. Off the hotspot (shared-WiFi / Pi / laptop), the real addresses
  // are correct.
  const display = deriveJoinDisplay({ hotspot, addresses, connectedClients, fragment: transportKeyFragment });
  const state = toHostPanelState(hotspot, display);

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
                    Pins LOAM to the screen so it can&apos;t be left. To exit, swipe up and hold (or
                    hold Back + Recents on 3-button nav) — the phone&apos;s own screen-lock PIN is
                    required (set one first).
                  </ThemedText>
                </ThemedView>
                <Switch value={kiosk} onValueChange={onKioskChange} />
              </ThemedView>

              {hostingNotificationDenied() ? (
                <ThemedText type="small" themeColor="textSecondary">
                  Notifications are off for LOAM, so Android hides the “LOAM is hosting” notice. Hosting
                  still works; allow notifications in the system settings to see it.
                </ThemedText>
              ) : null}

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
