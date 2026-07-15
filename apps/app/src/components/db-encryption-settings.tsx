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
  applyDbModeChange,
  clearStoredPassphrase,
  getDbEncryptionMode,
  hasStoredPassphrase,
  setDbEncryptionMode,
  setDbModeHint,
  setPassphraseCandidate,
  type BridgeChannel,
  type DbEncryptionMode,
  type PassphrasePresence,
} from '@/lib/db-encryption';

type DbEncryptionSettingsOverlayProps = {
  visible: boolean;
  onClose: () => void;
  // The nodejs-mobile bridge channel (from index.tsx). Used only to write the mode-NAME hint
  // transactionally with a selection (P1-b) — optional so the overlay still renders without it.
  channel?: BridgeChannel;
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
export function DbEncryptionSettingsOverlay({ visible, onClose, channel }: DbEncryptionSettingsOverlayProps) {
  const theme = useTheme();
  const [mode, setMode] = useState<DbEncryptionMode>('off');
  // P1-3 (Sol round 7): TRI-STATE presence of a committed passphrase — `'error'` (a SecureStore read
  // failure) must NEVER be shown as `'absent'`, which would expose the committed-overwrite entry path.
  const [passphrasePresence, setPassphrasePresence] = useState<PassphrasePresence>('absent');
  // Whether an unverified passphrase CANDIDATE has been entered this session (P1-3, Sol round 7). The
  // settings passphrase entry stores a candidate rather than committing, so `passphrasePresence` stays
  // `'absent'` until a boot opens the DB under it — this flag lets the UI say "pending, applies on
  // restart" instead of still showing a blank first-time-entry prompt.
  const [candidatePending, setCandidatePending] = useState(false);
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
    setCandidatePending(false);
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
        setPassphrasePresence(passphraseSet);
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
    const previous = mode;
    // P1-1 (Sol round 7, hole 3): the SecureStore mode and the mode-NAME hint must never diverge into the
    // dangerous state (SecureStore encrypted + hint 'off'/absent → a transient boot-time key-request
    // failure boots PLAINTEXT even WITH a DB). `applyDbModeChange` enforces that: for encrypted modes it
    // writes the hint FIRST and only commits the SecureStore mode if that succeeds (rolling the hint back
    // on a SecureStore failure); 'off' commits directly with a best-effort hint. An encrypted selection
    // with no bridge `channel` (so the hint can't be recorded) reports NOT applied rather than committing
    // an un-hinted encrypted mode.
    const outcome = await applyDbModeChange(previous, next, {
      writeMode: setDbEncryptionMode,
      writeHint: (m) =>
        channel
          ? setDbModeHint(channel, m)
          : Promise.resolve({
              ok: false as const,
              error: 'No connection to the host to record the encryption-state hint.',
            }),
    });
    // Display the COMMITTED SecureStore value only — never a mode that wasn't actually persisted.
    setMode(outcome.committedMode);
    if (!outcome.applied) {
      setStatusMessage(`Couldn't save — ${outcome.error ?? 'unknown error'}. The change was NOT applied; try again.`);
      return;
    }
    const base =
      next === 'off'
        ? 'Encryption off. Takes effect next time the host app is restarted.'
        : `${MODE_LABELS[next]} selected. Takes effect next time the host app is restarted.`;
    setStatusMessage(
      outcome.hintWarning
        ? `${base} (Note: the encryption-state hint could not be synced to the host; it will self-correct on the next successful start.)`
        : base,
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

  // P1-3 (Sol round 7): store the entry as an unverified CANDIDATE, never a direct committed overwrite.
  // The settings overlay is reachable from the LOCKED boot screen, so "first-time entry ⇒ no encrypted DB
  // exists" is NOT a valid invariant — a committed overwrite here could strand a DB encrypted under a
  // different passphrase while it's under the OLD key. The candidate is tried at boot (`resolveDbKey`
  // falls back to it when nothing is committed) and promoted to committed only once the server confirms
  // the DB opened under it (`markPassphraseKeyMigrated`). A committed passphrase can therefore never be
  // clobbered from here — and while one is committed, this entry isn't shown at all (see the render).
  const handleSavePassphrase = async () => {
    const trimmed = passphraseInput;
    if (!trimmed) {
      return;
    }
    try {
      await setPassphraseCandidate(trimmed);
    } catch (err) {
      setStatusMessage(`Couldn't save — ${err instanceof Error ? err.message : String(err)}. Try again.`);
      return;
    }
    setPassphraseInput('');
    setCandidatePending(true);
    setStatusMessage(
      'Passphrase saved. It is tried the next time the host app is restarted, and confirmed once the database opens under it.',
    );
  };

  // P1-3 (Sol round 7): only report "forgotten" when the delete is CONFIRMED gone. The old best-effort
  // clear always "succeeded", so a swallowed delete failure still flipped the UI to "no passphrase set" —
  // re-exposing the entry path so a NEW passphrase could overwrite the still-committed old one while the
  // DB was under the OLD key. On a failed/unverified clear, keep `passphrasePresence === 'present'` (so
  // no first-time entry is offered) and surface the failure.
  const handleForgetPassphrase = async () => {
    const result = await clearStoredPassphrase();
    if (!result.ok) {
      setStatusMessage(`Couldn't forget the passphrase — ${result.error ?? 'unknown error'}. It is still set; try again.`);
      return;
    }
    setPassphrasePresence('absent');
    setCandidatePending(false);
    setStatusMessage('Passphrase forgotten. Encrypted-passphrase mode has no key until a new one is entered.');
  };

  // P1-3 (Sol round 7): re-read passphrase presence after an `'error'` state (a transient SecureStore
  // read failure). Until this comes back non-`'error'`, the UI refuses to show any entry/overwrite path.
  const reloadPassphrasePresence = async () => {
    const presence = await hasStoredPassphrase();
    setPassphrasePresence(presence);
    if (presence === 'error') {
      setStatusMessage("Still couldn't read whether a passphrase is set (a device security-store error). Try again.");
    } else {
      setStatusMessage(undefined);
    }
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
                  {passphrasePresence === 'present' ? (
                    // P2-a (Sol round 6): a passphrase is already set — do NOT offer to REPLACE it here.
                    // There is no in-place passphrase rekey, so overwriting the stored passphrase would
                    // leave the existing database encrypted under the OLD key and unreadable. Changing a
                    // passphrase must go through the explicit destructive start-fresh flow, which discards
                    // the existing encrypted data. "Forget" disables passphrase mode (no key until a new
                    // one is entered) and is likewise destructive to access of the existing DB.
                    <>
                      <ThemedText type="small" themeColor="textSecondary">
                        A passphrase is set. It can&apos;t be changed here: there is no in-place passphrase
                        rekey, so replacing it would make the existing encrypted database permanently
                        unreadable. To change the passphrase you must start fresh (from the boot Encryption
                        recovery screen), which discards the existing encrypted data — this cannot be
                        undone. &quot;Forget&quot; disables passphrase mode and also leaves the existing
                        database inaccessible until a passphrase is re-entered.
                      </ThemedText>
                      <View style={styles.passphraseActions}>
                        <Pressable onPress={() => void handleForgetPassphrase()} accessibilityRole="button" style={styles.buttonSecondary}>
                          <ThemedText type="smallBold">Forget</ThemedText>
                        </Pressable>
                      </View>
                    </>
                  ) : passphrasePresence === 'error' ? (
                    // P1-3 (Sol round 7): a SecureStore read failure — we do NOT know whether a passphrase
                    // is committed, so we must NOT show the first-time-entry (committed-overwrite) path,
                    // which could clobber an existing passphrase and strand the DB. Offer only a retry.
                    <>
                      <ThemedText type="small" themeColor="textSecondary">
                        Couldn&apos;t read whether a passphrase is already set (a device security-store
                        error). Not showing passphrase entry, to avoid overwriting an existing passphrase and
                        making the database unreadable. Retry once the device is responsive.
                      </ThemedText>
                      <View style={styles.passphraseActions}>
                        <Pressable onPress={() => void reloadPassphrasePresence()} accessibilityRole="button" style={styles.buttonSecondary}>
                          <ThemedText type="smallBold">Retry</ThemedText>
                        </Pressable>
                      </View>
                    </>
                  ) : (
                    <>
                      <ThemedText type="small" themeColor="textSecondary">
                        {candidatePending
                          ? 'A passphrase has been entered and will be tried the next time the host app is restarted; it is confirmed once the database opens under it. Enter a different one to replace the pending passphrase.'
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
                      </View>
                    </>
                  )}
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
