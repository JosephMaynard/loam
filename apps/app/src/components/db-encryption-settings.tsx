import { useEffect, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  DB_ENCRYPTION_MODES,
  DB_ENCRYPTION_MODE_DESCRIPTIONS,
  DB_ENCRYPTION_MODE_READ_ERROR,
  clearStoredPassphrase,
  getDbEncryptionMode,
  hasStoredPassphrase,
  setDbEncryptionMode,
  setStoredPassphrase,
  type DbEncryptionMode,
} from '@/lib/db-encryption';

type DbEncryptionSettingsOverlayProps = {
  visible: boolean;
  onClose: () => void;
};

const MODE_LABELS: Record<DbEncryptionMode, string> = {
  off: 'Off (plaintext)',
  ephemeral: 'Ephemeral',
  persistent: 'Persistent',
  passphrase: 'Passphrase',
};

/** Modes whose selection needs an explicit confirmation before it's persisted (G4): `ephemeral` wipes
 * the on-device database on every restart by design, and `persistent`/`passphrase` can make an
 * EXISTING database (encrypted under a different key, or plaintext) permanently unreadable the next
 * time the host boots (see G2) — neither failure mode is recoverable, so the operator must opt in
 * knowingly rather than just seeing a "takes effect next restart" toast. `off` is exempt: it never
 * destroys data on its own (Encryption settings stays reachable from the boot-error screen either
 * way if a pre-existing encrypted database becomes unreadable — G2). */
const DESTRUCTIVE_MODES: ReadonlySet<DbEncryptionMode> = new Set(['ephemeral', 'persistent', 'passphrase']);

/**
 * The on-device DB-encryption mode picker (PR B — docs/01, docs/21): off / ephemeral / persistent /
 * passphrase, each with a one-line explanation. Purely a settings affordance — it only ever writes the
 * operator's choice (and, for passphrase mode, the passphrase itself) into `expo-secure-store`
 * (Keystore-backed); it never talks to the embedded server directly (same "never fetch an authenticated
 * route from this process" rule as the model manager — see model-manager-bridge.ts). The choice takes
 * effect on the NEXT app (re)start, since main.js resolves the key once at boot
 * (nodejs-project-template/main.js's request/response handoff) and nodejs-mobile can't restart its
 * runtime in-process.
 */
export function DbEncryptionSettingsOverlay({ visible, onClose }: DbEncryptionSettingsOverlayProps) {
  const theme = useTheme();
  const [mode, setMode] = useState<DbEncryptionMode>('off');
  const [hasPassphrase, setHasPassphrase] = useState(false);
  const [passphraseInput, setPassphraseInput] = useState('');
  const [statusMessage, setStatusMessage] = useState<string | undefined>();
  const [loaded, setLoaded] = useState(false);

  // Reload the persisted choice every time the overlay opens.
  useEffect(() => {
    if (!visible) {
      return;
    }
    let cancelled = false;
    setStatusMessage(undefined);
    setPassphraseInput('');
    void (async () => {
      const [currentMode, passphraseSet] = await Promise.all([getDbEncryptionMode(), hasStoredPassphrase()]);
      if (!cancelled) {
        // P1-3 (Sol round 5): a genuine SecureStore read failure (`DB_ENCRYPTION_MODE_READ_ERROR`) is
        // NOT the same as "off selected" — showing 'off' here would misrepresent the operator's actual
        // (unknown, on this read) choice. Keep the last-known/default display and surface the failure
        // instead of silently overwriting it.
        if (currentMode === DB_ENCRYPTION_MODE_READ_ERROR) {
          setStatusMessage("Couldn't read the current encryption setting (a device security-store error) — showing the last-known selection.");
        } else {
          setMode(currentMode);
        }
        setHasPassphrase(passphraseSet);
        setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible]);

  /** Actually persist the mode choice — the part `handleSelect` gates behind a destructive-action
   * confirmation for the modes that can wipe or strand existing data (G4). */
  const applyModeChange = async (next: DbEncryptionMode) => {
    setMode(next);
    const result = await setDbEncryptionMode(next);
    // P1-3 (Sol round 5): setDbEncryptionMode now reports real success/failure — a failed write must
    // never be presented as "applied" (the picker's next read would fall back to 'off', which may not
    // be what the operator just thought they set).
    setStatusMessage(
      !result.ok
        ? `Couldn't save — ${result.error ?? 'unknown error'}. The change was NOT applied; try again.`
        : next === 'off'
          ? 'Encryption off. Takes effect next time the host app is restarted.'
          : `${MODE_LABELS[next]} selected. Takes effect next time the host app is restarted.`,
    );
  };

  const handleSelect = (next: DbEncryptionMode) => {
    if (!DESTRUCTIVE_MODES.has(next)) {
      void applyModeChange(next);
      return;
    }
    Alert.alert(
      `Switch to ${MODE_LABELS[next]}?`,
      next === 'ephemeral'
        ? 'Ephemeral mode wipes the on-device message database on every app restart. The next restart ' +
            'will permanently delete any existing messages, and this cannot be undone.'
        : 'Switching encryption modes can make the existing on-device message database unreadable — a ' +
            'different (or missing) key can never decrypt data that was encrypted under another key. ' +
            'Existing messages may become permanently inaccessible, and this cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Continue', style: 'destructive', onPress: () => void applyModeChange(next) },
      ],
    );
  };

  const handleSavePassphrase = async () => {
    const trimmed = passphraseInput;
    if (!trimmed) {
      return;
    }
    await setStoredPassphrase(trimmed);
    setPassphraseInput('');
    setHasPassphrase(true);
    setStatusMessage('Passphrase saved. Takes effect next time the host app is restarted.');
  };

  const handleForgetPassphrase = async () => {
    await clearStoredPassphrase();
    setHasPassphrase(false);
    setStatusMessage('Passphrase forgotten. Encrypted-passphrase mode has no key until a new one is entered.');
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaProvider>
        <ThemedView style={styles.container}>
          <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
            <ThemedView style={styles.header}>
              <ThemedText type="subtitle">On-device encryption</ThemedText>
              <Pressable onPress={onClose} accessibilityRole="button" hitSlop={Spacing.two}>
                <ThemedText type="link">Done</ThemedText>
              </Pressable>
            </ThemedView>
            <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
              <ThemedText type="small" themeColor="textSecondary">
                Choose how the on-device message database is protected at rest. Off by default.
              </ThemedText>

              <ThemedView type="backgroundElement" style={styles.noteCard}>
                <ThemedText type="small" themeColor="textSecondary">
                  Encrypted modes (ephemeral/persistent/passphrase) need an app build that includes the
                  SQLCipher native module — not every build has it yet. If it&apos;s missing, the host
                  starts unencrypted and shows a clear warning rather than failing to boot. Any change
                  here takes effect the next time the host app is restarted.
                </ThemedText>
              </ThemedView>

              {statusMessage ? (
                <ThemedView type="backgroundSelected" style={styles.statusBanner}>
                  <ThemedText type="small">{statusMessage}</ThemedText>
                </ThemedView>
              ) : null}

              {loaded
                ? DB_ENCRYPTION_MODES.map((entry) => (
                    <Pressable
                      key={entry}
                      onPress={() => handleSelect(entry)}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: mode === entry }}
                      style={styles.row}>
                      <ThemedView type={mode === entry ? 'backgroundSelected' : 'backgroundElement'} style={styles.rowInner}>
                        <View style={styles.radioDot}>
                          <View style={[styles.radioDotInner, mode === entry && { backgroundColor: '#208AEF' }]} />
                        </View>
                        <ThemedView style={styles.rowText}>
                          <ThemedText type="smallBold">{MODE_LABELS[entry]}</ThemedText>
                          <ThemedText type="small" themeColor="textSecondary">
                            {DB_ENCRYPTION_MODE_DESCRIPTIONS[entry]}
                          </ThemedText>
                        </ThemedView>
                      </ThemedView>
                    </Pressable>
                  ))
                : null}

              {mode === 'passphrase' ? (
                <ThemedView type="backgroundElement" style={styles.passphraseCard}>
                  <ThemedText type="smallBold">Passphrase</ThemedText>
                  <ThemedText type="small" themeColor="textSecondary">
                    {hasPassphrase
                      ? 'A passphrase is set. Enter a new one below to replace it, or forget it.'
                      : 'No passphrase set yet — encryption stays off until one is entered.'}
                  </ThemedText>
                  <TextInput
                    value={passphraseInput}
                    onChangeText={setPassphraseInput}
                    placeholder="Enter a passphrase"
                    placeholderTextColor={theme.textSecondary}
                    autoCapitalize="none"
                    autoCorrect={false}
                    secureTextEntry
                    style={[styles.textInput, { color: theme.text, borderColor: theme.textSecondary }]}
                  />
                  <View style={styles.passphraseActions}>
                    <Pressable
                      onPress={() => void handleSavePassphrase()}
                      disabled={!passphraseInput}
                      accessibilityRole="button"
                      style={[styles.button, !passphraseInput && styles.buttonDisabled]}>
                      <ThemedText type="smallBold" style={styles.buttonLabel}>
                        Save passphrase
                      </ThemedText>
                    </Pressable>
                    {hasPassphrase ? (
                      <Pressable onPress={() => void handleForgetPassphrase()} accessibilityRole="button" style={styles.buttonSecondary}>
                        <ThemedText type="smallBold">Forget</ThemedText>
                      </Pressable>
                    ) : null}
                  </View>
                </ThemedView>
              ) : null}
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
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two,
  },
  scrollContent: {
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.five,
    gap: Spacing.two,
  },
  noteCard: {
    padding: Spacing.three,
    borderRadius: Spacing.three,
  },
  statusBanner: {
    padding: Spacing.three,
    borderRadius: Spacing.three,
  },
  row: {
    marginTop: Spacing.one,
  },
  rowInner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.three,
    padding: Spacing.three,
    borderRadius: Spacing.three,
  },
  radioDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#8b8f97',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  radioDotInner: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  rowText: {
    flex: 1,
    gap: 2,
    backgroundColor: 'transparent',
  },
  passphraseCard: {
    marginTop: Spacing.two,
    gap: Spacing.two,
    padding: Spacing.three,
    borderRadius: Spacing.three,
  },
  textInput: {
    borderWidth: 1,
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.two,
  },
  passphraseActions: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  button: {
    backgroundColor: '#208AEF',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
    borderRadius: Spacing.five,
  },
  buttonSecondary: {
    borderWidth: 1,
    borderColor: '#8b8f97',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
    borderRadius: Spacing.five,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonLabel: {
    color: '#ffffff',
  },
});
