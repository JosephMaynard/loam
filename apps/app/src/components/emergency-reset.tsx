import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { HoldToConfirm } from '@/components/hold-to-confirm';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useAppLocale } from '@/hooks/use-app-locale';
import { useTheme } from '@/hooks/use-theme';
import type { BridgeChannel } from '@/lib/db-encryption';
import { closeAfterReset, requestEmergencyReset, resetOutcome } from '@/lib/emergency-reset';
import { closeApp } from '../../modules/loam-hotspot';
import { t } from '@/lib/i18n';
import { clearSharedFiles } from '@/lib/save-file';

type Phase =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'key-clear' }
  /** Locked and partly erased. `recorded`: the wipe journal is on disk, so reopening LOAM finishes the erase;
   *  without it, reopening doesn't, and the reset has to be run again. */
  | { kind: 'incomplete'; recorded: boolean }
  | { kind: 'failed'; error: string };

/**
 * Emergency reset, from the host menu: one screen, a plain explanation, and a press-and-hold button. The
 * wipe runs in the server through the launcher bridge (no admin session needed: whoever holds this phone
 * owns the network). Clients clear themselves through the server's `wipe` broadcast. Once the wipe has
 * run, LOAM empties the share-sheet cache (lib/save-file.ts: the last file someone saved from this phone)
 * and closes itself completely: there's no "erased" screen to give away what just happened, and the next
 * launch is a clean start on the setup screens. Only then, though (`resetOutcome`): an encrypted
 * fixed-key node still has its device key to clear, which index.tsx does and then closes LOAM itself (this
 * screen shows that clear's failure, with a retry); and an erase that couldn't be verified complete stays
 * on screen, saying so, rather than closing as if it had worked. What it says depends on whether the server
 * recorded the wipe first: if so, reopening LOAM finishes the erase; if not, it doesn't, and the screen asks
 * for the reset to be run again after reopening.
 */
export function EmergencyResetOverlay({
  channel,
  onClose,
  visible,
  keyClearError,
  keyClearBusy,
  onRetryKeyClear,
}: {
  channel: BridgeChannel;
  onClose: () => void;
  visible: boolean;
  /** Why the device-key clear after the erase failed (index.tsx `wipeClearFailure`), if it did. */
  keyClearError?: string;
  keyClearBusy: boolean;
  onRetryKeyClear: () => void;
}) {
  useAppLocale(); // re-render in the chosen language
  const theme = useTheme();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  async function erase(): Promise<void> {
    setPhase({ kind: 'working' });
    const result = await requestEmergencyReset(channel);
    switch (resetOutcome(result)) {
      case 'close':
        await closeAfterReset(clearSharedFiles, closeApp);
        return;
      case 'key-clear':
        setPhase({ kind: 'key-clear' });
        return;
      case 'incomplete':
        setPhase({ kind: 'incomplete', recorded: true });
        return;
      case 'unrecorded':
        setPhase({ kind: 'incomplete', recorded: false });
        return;
      case 'failed':
        setPhase({ kind: 'failed', error: result.ok ? '' : result.error });
        return;
    }
  }

  // Erased, or partly: the network is locked either way, so there is nothing to go back to.
  const settled = phase.kind === 'key-clear' || phase.kind === 'incomplete';
  const busy = phase.kind === 'working' || (phase.kind === 'key-clear' && !keyClearError);

  function close(): void {
    if (busy || settled) {
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
              {settled ? null : (
                <Pressable onPress={close} accessibilityRole="button" hitSlop={Spacing.two} disabled={busy}>
                  <ThemedText type="link">{t('common.cancel')}</ThemedText>
                </Pressable>
              )}
            </ThemedView>
            <ScrollView contentContainerStyle={styles.body}>
              <ThemedText>{t('reset.body')}</ThemedText>
              {phase.kind === 'failed' ? (
                <ThemedText type="small" style={{ color: theme.danger }}>
                  {t('reset.failed', { error: phase.error })}
                </ThemedText>
              ) : null}
              {phase.kind === 'incomplete' ? (
                <>
                  <ThemedText style={{ color: theme.danger }}>
                    {t(phase.recorded ? 'reset.incomplete' : 'reset.notRecorded')}
                  </ThemedText>
                  <ActionButton label={t('reset.closeApp')} onPress={() => void closeAfterReset(clearSharedFiles, closeApp)} />
                </>
              ) : phase.kind === 'key-clear' ? (
                keyClearError ? (
                  <>
                    <ThemedText style={{ color: theme.danger }}>{t('reset.keyClearFailed', { error: keyClearError })}</ThemedText>
                    <ActionButton
                      label={keyClearBusy ? t('reset.working') : t('reset.retry')}
                      onPress={onRetryKeyClear}
                      disabled={keyClearBusy}
                    />
                  </>
                ) : (
                  <ThemedText themeColor="textSecondary">{t('reset.working')}</ThemedText>
                )
              ) : (
                <HoldToConfirm
                  disabled={phase.kind === 'working'}
                  holdingLabel={t('reset.holding')}
                  label={phase.kind === 'working' ? t('reset.working') : t('reset.hold')}
                  onConfirm={() => void erase()}
                />
              )}
            </ScrollView>
          </SafeAreaView>
        </ThemedView>
      </SafeAreaProvider>
    </Modal>
  );
}

/** A plain filled button (the reset screen's only other control is the hold-to-erase one). */
function ActionButton({ disabled, label, onPress }: { disabled?: boolean; label: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, { backgroundColor: theme.primary, opacity: disabled ? 0.6 : 1 }]}>
      <ThemedText type="smallBold" style={styles.buttonLabel}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { alignItems: 'center', paddingVertical: Spacing.three, borderRadius: Spacing.four },
  buttonLabel: { color: '#ffffff' },
  container: { flex: 1 },
  safeArea: { flex: 1, width: '100%', maxWidth: MaxContentWidth, alignSelf: 'center' },
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
