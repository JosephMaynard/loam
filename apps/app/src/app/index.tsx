import { ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { HostPanel, type HostState } from '@/components/host-panel';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';

// Android's WifiManager.LocalOnlyHotspot always assigns the host device this fixed gateway IP, so
// the LOAM access URL is knowable before the hotspot module reports credentials (docs/04).
const LOCAL_ONLY_HOTSPOT_HOST = 'http://192.168.49.1:3000';

export default function HostScreen() {
  // Placeholder until the hotspot native module + embedded server are wired (initiative 4). The
  // panel renders whatever state it is handed; the Step 2 QR is already live and correct.
  const state: HostState = {
    status: 'starting',
    serverUrl: LOCAL_ONLY_HOTSPOT_HOST,
  };

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}>
          <HostPanel state={state} />
        </ScrollView>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'center',
  },
  safeArea: {
    flex: 1,
    maxWidth: MaxContentWidth,
  },
  scrollContent: {
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.four,
    paddingBottom: BottomTabInset + Spacing.four,
    gap: Spacing.three,
  },
});
