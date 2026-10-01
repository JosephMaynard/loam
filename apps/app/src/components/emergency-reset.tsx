import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { HoldToConfirm } from '@/components/hold-to-confirm';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useAppLocale } from '@/hooks/use-app-locale';
import { useTheme } from '@/hooks/use-theme';
import type { BridgeChannel } from '@/lib/db-encryption';
import { requestEmergencyReset } from '@/lib/emergency-reset';
import { t } from '@/lib/i18n';

type Phase = { kind: 'idle' } | { kind: 'working' } | { kind: 'done' } | { kind: 'incomplete' } | { kind: 'failed'; error: string };

/**
 * Emergency reset, from the host menu: one screen, a plain explanation, and a press-and-hold button. The
 * wipe runs in the server through the launcher bridge (no admin session needed: whoever holds this phone
 * owns the network). Clients clear themselves through the server's `wipe` broadcast, and an encrypted
 * fixed-key node restarts with a new key through the existing launcher protocol.
 */
export function EmergencyResetOverlay({
  channel,
  onClose,
  visible,
}: {
  channel: BridgeChannel;
  onClose: () => void;
  visible: boolean;
}) {
  useAppLocale(); // re-render in the chosen language
  const theme = useTheme();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  async function erase(): Promise<void> {
    setPhase({ kind: 'working' });
    const result = await requestEmergencyReset(channel);
    setPhase(
      result.ok ? (result.complete ? { kind: 'done' } : { kind: 'incomplete' }) : { kind: 'failed', error: result.error },
    );
  }

  function close(): void {
    if (phase.kind === 'working') {
      return; // Let it finish; the screen reports the outcome.
    }
    setPhase({ kind: 'idle' });
    onClose();
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={close}>
      <SafeAreaProvider>
        <ThemedView style={styles.container}>
          <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
            <ThemedView style={styles.header}>
              <ThemedText type="subtitle">{t('reset.title')}</ThemedText>
              <Pressable onPress={close} accessibilityRole="button" hitSlop={Spacing.two} disabled={phase.kind === 'working'}>
                <ThemedText type="link">{phase.kind === 'done' ? t('common.close') : t('common.cancel')}</ThemedText>
              </Pressable>
            </ThemedView>
            <ScrollView contentContainerStyle={styles.body}>
              <ThemedText>{t('reset.body')}</ThemedText>
              {phase.kind === 'done' ? (
                <ThemedText type="smallBold">{t('reset.done')}</ThemedText>
              ) : phase.kind === 'incomplete' ? (
                <ThemedText type="smallBold" style={{ color: theme.danger }}>
                  {t('reset.incomplete')}
                </ThemedText>
              ) : (
                <>
                  {phase.kind === 'failed' ? (
                    <ThemedText type="small" style={{ color: theme.danger }}>
                      {t('reset.failed', { error: phase.error })}
                    </ThemedText>
                  ) : null}
                  <HoldToConfirm
                    disabled={phase.kind === 'working'}
                    holdingLabel={t('reset.holding')}
                    label={phase.kind === 'working' ? t('reset.working') : t('reset.hold')}
                    onConfirm={() => void erase()}
                  />
                </>
              )}
            </ScrollView>
          </SafeAreaView>
        </ThemedView>
      </SafeAreaProvider>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safeArea: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two,
  },
  body: {
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.five,
    gap: Spacing.four,
  },
});
