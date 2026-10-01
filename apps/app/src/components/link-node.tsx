import { wifiPayload } from '@loam/qr';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import type { HostState } from '@/components/host-panel';
import { QRCode } from '@/components/qr-code';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useAppLocale } from '@/hooks/use-app-locale';
import { useTheme } from '@/hooks/use-theme';
import type { BridgeChannel } from '@/lib/db-encryption';
import { t } from '@/lib/i18n';
import { linkCodeUrl, requestLinkCode } from '@/lib/link-code';

type Shown = { kind: 'loading' } | { kind: 'code'; code: string; expiresAt: number } | { kind: 'failed'; error: string };

/**
 * "Link another LOAM node" (server `sync-links.ts`): the host phone deliberately shows a single-use,
 * 10-minute code that another LOAM phone scans from its setup screens ("Join another LOAM network"). Using
 * it links both networks' public channels both ways, with nothing to approve afterwards: showing it is the
 * approval. On a hotspot the joining phone has to be on this network first, so the Wi-Fi code comes first.
 * A fresh code is made each time the screen opens; closing it doesn't cancel one already shown (it simply
 * expires).
 */
export function LinkNodeScreen({
  channel,
  onClose,
  state,
  visible,
}: {
  channel: BridgeChannel;
  onClose: () => void;
  state: HostState;
  visible: boolean;
}) {
  useAppLocale();
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const [shown, setShown] = useState<Shown>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const size = Math.min(width - Spacing.four * 2, 280);

  useEffect(() => {
    if (!visible) {
      return;
    }
    let cancelled = false;
    setShown({ kind: 'loading' });
    void requestLinkCode(channel).then((result) => {
      if (!cancelled) {
        setShown(result.ok ? { kind: 'code', code: result.code, expiresAt: result.expiresAt } : { kind: 'failed', error: result.error });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [channel, visible, attempt]);

  const wifi = state.mode === 'hotspot' && state.hotspot ? wifiPayload(state.hotspot.ssid, state.hotspot.password) : undefined;
  const linkUrl = shown.kind === 'code' ? linkCodeUrl(state.serverUrl, shown.code) : undefined;
  const expires =
    shown.kind === 'code'
      ? new Date(shown.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : undefined;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaProvider>
        <ThemedView style={styles.container}>
          <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
            <ThemedView style={styles.header}>
              <ThemedText type="subtitle">{t('link.title')}</ThemedText>
              <Pressable onPress={onClose} accessibilityRole="button" hitSlop={Spacing.two}>
                <ThemedText type="link">{t('common.close')}</ThemedText>
              </Pressable>
            </ThemedView>
            <ScrollView contentContainerStyle={styles.body}>
              <ThemedText>{t('link.body')}</ThemedText>
              {wifi && state.hotspot ? (
                <View style={styles.code}>
                  <ThemedText type="smallBold">{t('display.step1')}</ThemedText>
                  <QRCode value={wifi} size={size} ecLevel="M" />
                  <ThemedText type="code" style={styles.caption}>
                    {`${state.hotspot.ssid} · ${state.hotspot.password}`}
                  </ThemedText>
                </View>
              ) : null}
              <View style={styles.code}>
                <ThemedText type="smallBold">{wifi ? t('link.step2') : t('link.scan')}</ThemedText>
                {shown.kind === 'loading' ? (
                  <ActivityIndicator size="large" style={{ height: size }} />
                ) : shown.kind === 'failed' ? (
                  <ThemedText type="small" style={{ color: theme.danger }}>
                    {t('link.failed', { error: shown.error })}
                  </ThemedText>
                ) : linkUrl ? (
                  <QRCode value={linkUrl} size={size} ecLevel="M" />
                ) : (
                  <ThemedText type="small" themeColor="textSecondary">
                    {t('link.noAddress')}
                  </ThemedText>
                )}
                {expires && linkUrl ? (
                  <ThemedText type="small" themeColor="textSecondary" style={styles.caption}>
                    {t('link.expires', { time: expires })}
                  </ThemedText>
                ) : null}
              </View>
              <Pressable
                accessibilityRole="button"
                disabled={shown.kind === 'loading'}
                onPress={() => setAttempt((value) => value + 1)}
                style={[styles.button, { borderColor: theme.primary, opacity: shown.kind === 'loading' ? 0.6 : 1 }]}>
                <ThemedText type="smallBold">{t('link.again')}</ThemedText>
              </Pressable>
            </ScrollView>
          </SafeAreaView>
        </ThemedView>
      </SafeAreaProvider>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safeArea: { flex: 1, width: '100%', maxWidth: MaxContentWidth, alignSelf: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two,
  },
  body: { paddingHorizontal: Spacing.four, paddingBottom: Spacing.five, gap: Spacing.four },
  code: { alignItems: 'center', gap: Spacing.two },
  caption: { textAlign: 'center' },
  button: { alignItems: 'center', paddingVertical: Spacing.three, borderRadius: Spacing.four, borderWidth: 1 },
});
