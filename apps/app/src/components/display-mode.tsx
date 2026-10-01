import { wifiPayload } from '@loam/qr';
import { Modal, StyleSheet, useWindowDimensions, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import type { HostState } from '@/components/host-panel';
import { HoldToConfirm } from '@/components/hold-to-confirm';
import { QRCode } from '@/components/qr-code';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useAppLocale } from '@/hooks/use-app-locale';
import { displayCodeSize, EXIT_HEIGHT, HEADING_HEIGHT } from '@/lib/display-layout';
import { t } from '@/lib/i18n';

/**
 * Display mode: the join codes, as large as the screen allows, for a phone left out where people can see
 * it (in a window, on a table). One code on Wi-Fi; two on a hotspot (join the Wi-Fi, then open LOAM).
 * The screen stays on and the app is pinned while it shows (the caller does that); leaving takes a
 * press-and-hold, so a passer-by can't switch it off with a tap.
 */
export function DisplayModeScreen({
  nodeName,
  onExit,
  state,
  visible,
}: {
  nodeName?: string;
  onExit: () => void;
  state: HostState;
  visible: boolean;
}) {
  useAppLocale();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const wifi = state.mode === 'hotspot' && state.hotspot ? wifiPayload(state.hotspot.ssid, state.hotspot.password) : undefined;
  // The address people could type: the fragment (key, invite code) only works scanned, so leave it off.
  const typedUrl = state.serverUrl?.split('#')[0];
  const codes: Array<{ title: string; value: string; caption: string; ecLevel?: 'M' }> = [];
  if (state.mode === 'hotspot') {
    if (wifi && state.hotspot) {
      codes.push({ title: t('display.step1'), value: wifi, caption: `${state.hotspot.ssid} · ${state.hotspot.password}`, ecLevel: 'M' });
    }
    if (state.serverUrl) {
      codes.push({ title: t('display.step2'), value: state.serverUrl, caption: typedUrl ?? state.serverUrl });
    }
  } else if (state.serverUrl) {
    codes.push({ title: t('display.wifiTitle'), value: state.serverUrl, caption: typedUrl ?? state.serverUrl });
  }
  const { size, sideBySide } = displayCodeSize(
    codes.length === 2 ? 2 : 1,
    width - insets.left - insets.right,
    height - insets.top - insets.bottom,
  );

  return (
    <Modal visible={visible} animationType="fade" onRequestClose={() => undefined} supportedOrientations={['portrait', 'landscape']}>
      <SafeAreaProvider>
        <ThemedView style={styles.container}>
          <SafeAreaView style={styles.safeArea} edges={['top', 'bottom', 'left', 'right']}>
            <ThemedText type="subtitle" style={styles.heading} numberOfLines={1}>
              {nodeName ? t('display.heading', { name: nodeName }) : t('display.headingPlain')}
            </ThemedText>
            <View style={[styles.codes, sideBySide ? styles.row : styles.column]}>
              {codes.length ? (
                codes.map((code) => (
                  <View key={code.title} style={styles.code}>
                    <ThemedText type="smallBold">{code.title}</ThemedText>
                    <QRCode value={code.value} size={size} ecLevel={code.ecLevel} />
                    <ThemedText type="code" style={styles.caption} numberOfLines={2}>
                      {code.caption}
                    </ThemedText>
                  </View>
                ))
              ) : (
                <ThemedText themeColor="textSecondary" style={styles.caption}>
                  {t('display.waiting')}
                </ThemedText>
              )}
            </View>
            <View style={styles.exit}>
              <HoldToConfirm
                holdMs={2000}
                holdingLabel={t('display.exitHolding')}
                label={t('display.exit')}
                onConfirm={onExit}
                tone="neutral"
              />
            </View>
          </SafeAreaView>
        </ThemedView>
      </SafeAreaProvider>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safeArea: { flex: 1, paddingHorizontal: Spacing.four, paddingVertical: Spacing.two },
  heading: { textAlign: 'center', minHeight: HEADING_HEIGHT - Spacing.two, textAlignVertical: 'center' },
  codes: { flex: 1, alignItems: 'center', justifyContent: 'space-evenly' },
  row: { flexDirection: 'row' },
  column: { flexDirection: 'column' },
  code: { alignItems: 'center', gap: Spacing.one },
  caption: { textAlign: 'center' },
  exit: { minHeight: EXIT_HEIGHT - Spacing.two, justifyContent: 'center', alignSelf: 'stretch' },
});
