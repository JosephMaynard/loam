import Constants from 'expo-constants';
import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { readWifiStationInfo, type WifiStationInfo } from '../../modules/loam-hotspot';
import { DisplayModeScreen } from '@/components/display-mode';
import { HostPanel } from '@/components/host-panel';
import { LinkNodeScreen } from '@/components/link-node';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { setHostMode, useHostMode } from '@/hooks/use-host-mode';
import { ensureHotspot, shutdownHotspot, useHotspot } from '@/hooks/use-hotspot';
import { useAppLocale } from '@/hooks/use-app-locale';
import { useTheme } from '@/hooks/use-theme';
import type { BridgeChannel } from '@/lib/db-encryption';
import { deriveWifiJoinDisplay, toWifiPanelState, type HostMode } from '@/lib/host-mode';
import { ensureHostService, hostingNotificationDenied } from '@/lib/host-service';
import { t, type AppCatalogKey } from '@/lib/i18n';
import { deriveJoinDisplay, toHostPanelState, type HostInterface } from '@/lib/join-display';

// How often Wi-Fi mode re-reads the phone's Wi-Fi state while the share screen is open — the same cadence
// as the launcher's `loam-hostinfo` tick, so a network change shows up within a few seconds.
const WIFI_STATION_POLL_MS = 5_000;

/** The segmented control's options and the one line under it that says what each means. */
const MODE_OPTIONS: { mode: HostMode; label: AppCatalogKey; help: AppCatalogKey }[] = [
  { mode: 'hotspot', label: 'share.hotspot', help: 'share.hotspotHelp' },
  { mode: 'wifi', label: 'share.wifi', help: 'share.wifiHelp' },
];

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
  /** The launcher's (interface, address) pairs — Wi-Fi mode's fallback when the native station read is empty. */
  interfaces: HostInterface[];
  /** Peer addresses of the devices connected to LOAM from off this phone (launcher-reported). */
  connectedClients: string[];
  /**
   * Display mode: the join codes full screen, for a phone left out on display. While it's on, the caller
   * keeps the screen awake and pins the app (Android screen pinning), and this overlay shows the codes.
   */
  displayMode: boolean;
  onDisplayModeChange: (value: boolean) => void;
  /** The network's name, shown above the codes in display mode. */
  nodeName?: string;
  /** The launcher bridge, for a "Link a node" code (lib/link-code.ts). */
  channel: BridgeChannel;
};

/**
 * A full-screen modal over the host WebView that shares this node, in one of two persisted modes (docs/04
 * "Hosting modes"), picked with the segmented control at the top:
 *   - Hotspot: starts the local-only hotspot (requesting permission first) and renders the two-step join
 *     flow. If the hotspot can't start — no Wi-Fi hardware on an emulator, or a denied permission — it
 *     shows a clear message and still renders the Step-2 LOAM-URL QR, never crashing or hanging.
 *   - Wi-Fi: no hotspot and no permission prompt; reads the phone's Wi-Fi client address every few
 *     seconds and renders one URL QR for everyone on that network.
 */
export function HostShareOverlay({
  visible,
  onClose,
  transportKeyFragment,
  addresses,
  interfaces,
  connectedClients,
  displayMode,
  onDisplayModeChange,
  nodeName,
  channel,
}: HostShareOverlayProps) {
  useAppLocale();
  const hotspot = useHotspot();
  const { mode, loaded } = useHostMode();
  const theme = useTheme();
  const [linkOpen, setLinkOpen] = useState(false);
  const version = Constants.expoConfig?.version ?? '?';
  // The last Wi-Fi station read (Wi-Fi mode only); `undefined` until the first read after opening.
  const [station, setStation] = useState<WifiStationInfo | undefined>();

  // Start the hotspot when the overlay opens in Hotspot mode — and only then: a persisted Wi-Fi mode must
  // never bring one up (or its location prompt), so this waits for the stored mode to load. `ensureHotspot`
  // is idempotent (no-ops while in flight or already running), and we intentionally leave the hotspot up
  // after close so joiners stay connected while the host app runs.
  useEffect(() => {
    if (visible && loaded && mode === 'hotspot') {
      void ensureHotspot();
    }
  }, [visible, loaded, mode]);

  // Wi-Fi mode: joiners depend on this phone staying reachable with the screen off from the moment the
  // screen opens (there is no hotspot start to wait for), so re-assert the foreground service now. No other
  // permission dialog is coming in this mode, so the one-time notification prompt may show.
  useEffect(() => {
    if (visible && loaded && mode === 'wifi') {
      void ensureHostService();
    }
  }, [visible, loaded, mode]);

  // Once the hotspot is up, make sure the foreground host service is too (idempotent) — joiners are now
  // depending on this phone staying reachable with the screen off.
  useEffect(() => {
    if (hotspot.phase === 'running') {
      void ensureHostService();
    }
  }, [hotspot.phase]);

  // Wi-Fi mode: read the phone's Wi-Fi state on open and every few seconds while the screen is showing, so
  // joining or leaving a network updates the QR. Stops (and forgets the reading) when hidden, so a reopen
  // never shows a stale address.
  useEffect(() => {
    if (!visible || mode !== 'wifi') {
      return;
    }
    let cancelled = false;
    const read = () => {
      void readWifiStationInfo().then((info) => {
        if (!cancelled) {
          setStation(info);
        }
      });
    };
    read();
    const timer = setInterval(read, WIFI_STATION_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      setStation(undefined);
    };
  }, [visible, mode]);

  // Switching is live and sticks across launches. To Wi-Fi: release the hotspot (joiners on it lose the
  // host, which is what the operator asked for). To Hotspot: the start effect above picks it up.
  const selectMode = (next: HostMode) => {
    if (next === mode) {
      return;
    }
    void setHostMode(next);
    if (next === 'wifi' && hotspot.phase !== 'idle') {
      shutdownHotspot();
    }
  };

  // Hotspot mode: when the hotspot is up, joiners are on it — target its own discovered address, and drop
  // the host's other (unreachable-from-the-hotspot) LAN addresses from the "also at" list so we don't send
  // a joiner to an address on the wrong network. Wi-Fi mode: the phone's Wi-Fi client address.
  const state =
    mode === 'wifi'
      ? toWifiPanelState(
          deriveWifiJoinDisplay({ station, interfaces, addresses, connectedClients, fragment: transportKeyFragment }),
        )
      : toHostPanelState(
          hotspot,
          deriveJoinDisplay({ hotspot, addresses, connectedClients, fragment: transportKeyFragment }),
        );
  const help = MODE_OPTIONS.find((option) => option.mode === mode)?.help;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaProvider>
        <ThemedView style={styles.container}>
          <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
            <ThemedView style={styles.header}>
              <Pressable onPress={onClose} accessibilityRole="button" hitSlop={Spacing.two}>
                <ThemedText type="link">{t('share.done')}</ThemedText>
              </Pressable>
            </ThemedView>
            <ScrollView
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator={false}>
              <View style={styles.modeBlock}>
                <View
                  accessibilityRole="radiogroup"
                  accessibilityLabel={t('share.howPeopleJoin')}
                  style={[styles.segmented, { backgroundColor: theme.backgroundElement, borderColor: theme.backgroundSelected }]}>
                  {MODE_OPTIONS.map((option) => {
                    const selected = option.mode === mode;
                    return (
                      <Pressable
                        key={option.mode}
                        onPress={() => selectMode(option.mode)}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: selected }}
                        style={[styles.segment, selected && { backgroundColor: theme.accent }]}>
                        <ThemedText type="smallBold" style={selected ? { color: theme.onAccent } : undefined}>
                          {t(option.label)}
                        </ThemedText>
                      </Pressable>
                    );
                  })}
                </View>
                <ThemedText type="small" themeColor="textSecondary" style={styles.modeHelp}>
                  {help ? t(help) : null}
                </ThemedText>
              </View>

              {/* Held until the stored mode is known, so a Wi-Fi host doesn't flash the hotspot steps. */}
              {loaded ? <HostPanel state={state} /> : null}

              {/* Display mode: "kiosk" and "keep screen on" as one plainly named choice. The screen staying
                  on only matters for showing the codes; the network itself keeps running with the screen
                  off (the foreground service and its wake lock), so there's no separate switch for it. */}
              <ThemedView type="backgroundElement" style={styles.settingRow}>
                <ThemedView style={styles.settingText}>
                  <ThemedText type="smallBold">{t('share.displayTitle')}</ThemedText>
                  <ThemedText type="small" themeColor="textSecondary">
                    {t('share.displayBody')}
                  </ThemedText>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => onDisplayModeChange(true)}
                    style={[styles.displayButton, { backgroundColor: theme.primary }]}>
                    <ThemedText type="smallBold" style={{ color: '#ffffff' }}>
                      {t('share.displayStart')}
                    </ThemedText>
                  </Pressable>
                </ThemedView>
              </ThemedView>

              {/* Linking another LOAM node: only ever through a code shown here on purpose (or from the admin
                  sync settings), never from the ordinary join code above. */}
              <ThemedView type="backgroundElement" style={styles.settingRow}>
                <ThemedView style={styles.settingText}>
                  <ThemedText type="smallBold">{t('link.title')}</ThemedText>
                  <ThemedText type="small" themeColor="textSecondary">
                    {t('link.summary')}
                  </ThemedText>
                  <Pressable
                    accessibilityRole="button"
                    disabled={!loaded}
                    onPress={() => setLinkOpen(true)}
                    style={[styles.displayButton, styles.linkButton, { borderColor: theme.primary }]}>
                    <ThemedText type="smallBold">{t('link.show')}</ThemedText>
                  </Pressable>
                </ThemedView>
              </ThemedView>

              {hostingNotificationDenied() ? (
                <ThemedText type="small" themeColor="textSecondary">
                  {t('share.notificationsOff')}
                </ThemedText>
              ) : null}

              <ThemedText type="small" themeColor="textSecondary" style={styles.version}>
                LOAM v{version}
              </ThemedText>
            </ScrollView>
          </SafeAreaView>
        </ThemedView>
        {loaded ? (
          <DisplayModeScreen
            nodeName={nodeName}
            onExit={() => onDisplayModeChange(false)}
            state={state}
            visible={visible && displayMode}
          />
        ) : null}
        {loaded ? (
          <LinkNodeScreen channel={channel} onClose={() => setLinkOpen(false)} state={state} visible={visible && linkOpen} />
        ) : null}
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
  modeBlock: {
    gap: Spacing.two,
  },
  // The Hotspot / Wi-Fi control: a pill row of two equal segments, the selected one filled with the accent.
  segmented: {
    flexDirection: 'row',
    borderWidth: 1,
    borderRadius: Spacing.four,
    padding: Spacing.half,
  },
  segment: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: Spacing.two,
    borderRadius: Spacing.four,
  },
  modeHelp: {
    textAlign: 'center',
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
  linkButton: {
    borderWidth: 1,
  },
  displayButton: {
    alignSelf: 'flex-start',
    marginTop: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Spacing.three,
  },
});
