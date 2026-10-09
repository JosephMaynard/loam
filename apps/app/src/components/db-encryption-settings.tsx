import { useEffect, useRef, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { t, type AppCatalogKey } from '@/lib/i18n';
import {
  DB_ENCRYPTION_MODE_READ_ERROR,
  applyDbModeChange,
  clearStoredPassphrase,
  dbModeSelectionIsDestructive,
  getDbEncryptionMode,
  hasStoredPassphrase,
  requestDbStartFresh,
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
  // The nodejs-mobile bridge channel (from index.tsx). Used to write the mode-NAME hint transactionally
  // with a selection and to schedule the start-fresh an encrypted selection needs; optional so the
  // overlay still renders without it (an encrypted selection is then refused).
  channel?: BridgeChannel;
  /** Opens Emergency reset (the network must be running); the section is hidden without it. */
  onEmergencyReset?: () => void;
};

/** Each mode's one-line name and its explanation, as catalog keys (translated at render time). */
const MODE_TEXT: Record<DbEncryptionMode, { label: AppCatalogKey; description: AppCatalogKey }> = {
  persistent: { label: 'encryption.modePersistent', description: 'encryption.descPersistent' },
  ephemeral: { label: 'encryption.modeEphemeral', description: 'encryption.descEphemeral' },
  passphrase: { label: 'encryption.modePassphrase', description: 'encryption.descPassphrase' },
  off: { label: 'encryption.modeOff', description: 'encryption.descOff' },
};

/** A mode's name in the app's language. */
function modeLabel(mode: DbEncryptionMode): string {
  return t(MODE_TEXT[mode].label);
}

/** The order the picker lists the modes in: encrypted first, plaintext last (an opt-in for testing). */
const MODE_ORDER: readonly DbEncryptionMode[] = ['persistent', 'ephemeral', 'passphrase', 'off'];

/**
 * The on-device DB-encryption mode picker (docs/01, docs/21): off / ephemeral / persistent /
 * passphrase, each with a one-line explanation. Purely a settings affordance: it writes the operator's
 * choice (and, for passphrase mode, a one-time entry for the next start) into `expo-secure-store`
 * (Keystore-backed) and asks the launcher over the bridge to record the mode hint or schedule a fresh
 * database; it never talks to the embedded server directly (same "never fetch an authenticated
 * route from this process" rule as the model manager — see model-manager-bridge.ts). The choice takes
 * effect on the NEXT app (re)start, since main.js resolves the key once at boot
 * (nodejs-project-template/main.js's request/response handoff) and nodejs-mobile can't restart its
 * runtime in-process.
 */
export function DbEncryptionSettingsOverlay({ visible, onClose, channel, onEmergencyReset }: DbEncryptionSettingsOverlayProps) {
  const theme = useTheme();
  const [mode, setMode] = useState<DbEncryptionMode>('off');
  // TRI-STATE "does a passphrase govern this database?": `'error'` (a SecureStore read failure) must
  // NEVER be shown as `'absent'`, which would offer the first-time entry path.
  const [passphrasePresence, setPassphrasePresence] = useState<PassphrasePresence>('absent');
  // Whether an unverified passphrase CANDIDATE has been entered this session. The settings passphrase
  // entry stores a candidate rather than committing, so `passphrasePresence` stays `'absent'` until a boot
  // opens the DB under it; this flag lets the UI say "pending, applies on restart" instead of still
  // showing a blank first-time-entry prompt.
  const [candidatePending, setCandidatePending] = useState(false);
  const [passphraseInput, setPassphraseInput] = useState('');
  const [statusMessage, setStatusMessage] = useState<string | undefined>();
  const [loaded, setLoaded] = useState(false);
  // A transition is in flight: drives the DISABLED state of every mode row.
  const [transitioning, setTransitioning] = useState(false);
  // The SYNCHRONOUS in-flight guard. React `transitioning` state updates too late to
  // block a second tap fired in the SAME tick (before the re-render disables the rows), so `handleSelect`
  // reads/sets this ref synchronously to reject any concurrent selection immediately. The underlying
  // `applyDbModeChange` also serializes the actual writes under a module-level mutex — this ref is the UI
  // half (disable every control at once); the mutex is the correctness half (no interleaved writes).
  const transitionInFlight = useRef(false);

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
        // A genuine SecureStore read failure (`DB_ENCRYPTION_MODE_READ_ERROR`) is NOT the same as "off
        // selected": showing 'off' here would misrepresent the operator's actual
        // (unknown, on this read) choice. Keep the last-known/default display and surface the failure
        // instead of silently overwriting it.
        if (currentMode === DB_ENCRYPTION_MODE_READ_ERROR) {
          setStatusMessage(t('encryption.readFailed'));
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

  /** Actually persist the mode choice: the part `handleSelect` gates behind a confirmation (a
   * destructive-action one for the modes that can wipe or strand existing data). Owns the in-flight guard
   * lifecycle: sets it on entry, clears it (and the disabled UI state) in `finally`. */
  const applyModeChange = async (next: DbEncryptionMode) => {
    transitionInFlight.current = true;
    setTransitioning(true);
    try {
      // `applyDbModeChange` runs the whole hint+mode transaction under a single-flight
      // mutex and RE-READS the committed mode inside it, so the SecureStore mode and the mode-NAME hint can
      // never diverge into the dangerous state (SecureStore encrypted + hint 'off'/absent → a transient
      // boot-time key-request failure boots PLAINTEXT even WITH a DB) even under concurrent taps. For
      // encrypted modes it writes the hint FIRST and only commits SecureStore if that succeeds (rolling the
      // hint back on a SecureStore failure); 'off' commits directly with a best-effort hint. An encrypted
      // selection with no bridge `channel` (so the hint can't be recorded) reports NOT applied rather than
      // committing an un-hinted encrypted mode.
      const outcome = await applyDbModeChange(next, {
        readMode: getDbEncryptionMode,
        writeMode: setDbEncryptionMode,
        writeHint: (m) =>
          channel ? setDbModeHint(channel, m) : Promise.resolve({ ok: false as const, error: t('encryption.noHostHint') }),
      });
      // Display the COMMITTED SecureStore value only — never a mode that wasn't actually persisted. Left
      // untouched when the committed mode couldn't be re-read (`committedMode` undefined).
      if (outcome.committedMode !== undefined) {
        setMode(outcome.committedMode);
      }
      if (!outcome.applied) {
        setStatusMessage(t('encryption.saveFailed', { error: outcome.error ?? t('common.unknownError') }));
        return;
      }
      if (next === 'off') {
        setStatusMessage(outcome.hintWarning ? t('encryption.offSavedHintWarning') : t('encryption.offSaved'));
        return;
      }
      // An encrypted mode can only apply to a FRESH database: there is no in-place conversion. EVERY
      // confirmed transition to an encrypted `next`, from ANY source mode (encrypted→encrypted included),
      // must schedule the launcher's start-fresh, else the next boot surfaces a db_encryption boot error and
      // drops the operator into the recovery screen unexpectedly.
      //
      // This is a DELIBERATE destructive mode change the operator explicitly confirmed, so the start-fresh
      // request carries the `'delete'` intent: the server DELETES the existing database on the next boot
      // (proving the old data is genuinely gone) rather than renaming it aside, where an encrypted source DB
      // would stay recoverable under the retained device secret. The confirmation copy states permanent
      // deletion for both plaintext and encrypted sources, matching that. (The `'preserve'` intent, renaming
      // the old ciphertext aside, is only for accidental wrong/lost-key lockout recovery, driven from the
      // boot recovery screen.)
      let startFreshNote = '';
      if (channel) {
        const fresh = await requestDbStartFresh(channel, 'delete');
        if (!fresh.ok) {
          startFreshNote = t('encryption.scheduleFreshFailed', { error: fresh.error ?? t('common.unknownError') });
        }
      } else {
        startFreshNote = t('encryption.scheduleFreshNoHost');
      }
      const selected = t('encryption.modeSelected', { mode: modeLabel(next) });
      setStatusMessage(startFreshNote ? `${selected} ${startFreshNote}` : selected);
    } finally {
      transitionInFlight.current = false;
      setTransitioning(false);
    }
  };

  const handleSelect = (next: DbEncryptionMode) => {
    // Reject a concurrent/same-tick selection IMMEDIATELY via the synchronous ref: the disabled UI state
    // re-renders too late to stop a second tap fired before it lands.
    if (transitionInFlight.current) {
      return;
    }
    // Re-selecting the ALREADY-active mode is a no-op, never the destructive "delete & start fresh" flow:
    // tapping the current encrypted row is a common "just checking" gesture, and it would otherwise invite
    // an accidental deletion for a selection that changes nothing.
    if (next === mode) {
      setStatusMessage(t('encryption.alreadyActive', { mode: modeLabel(next) }));
      return;
    }
    if (!dbModeSelectionIsDestructive(next)) {
      // Plaintext is an opt-in for testing, never a quiet default: say what it means first.
      Alert.alert(t('encryption.offConfirmTitle'), t('encryption.offConfirmBody'), [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('encryption.offConfirm'), style: 'destructive', onPress: () => void applyModeChange(next) },
      ]);
      return;
    }
    // Hold the guard from the moment the confirmation opens so a second tap can't stack another dialog.
    // `proceeded` keeps `release` (fired by Cancel/back-dismiss) from clearing the guard out from under an
    // in-flight `applyModeChange` when the operator confirmed — `applyModeChange`'s `finally` owns it then.
    transitionInFlight.current = true;
    setTransitioning(true);
    let proceeded = false;
    const release = () => {
      if (!proceeded) {
        transitionInFlight.current = false;
        setTransitioning(false);
      }
    };
    Alert.alert(
      next === 'ephemeral' ? t('encryption.ephemeralConfirmTitle') : t('encryption.freshConfirmTitle'),
      // A confirmed destructive mode change DELETES the existing database server-side on the next restart
      // (the start-fresh marker carries the `'delete'` intent), for BOTH a plaintext ('off') source and an
      // encrypted source, so every variant of this copy states permanent deletion.
      next === 'ephemeral'
        ? t('encryption.ephemeralConfirmBody')
        : mode === 'off'
          ? t('encryption.freshConfirmBodyFromOff')
          : t('encryption.freshConfirmBodyFromEncrypted'),
      [
        { text: t('common.cancel'), style: 'cancel', onPress: release },
        {
          text: next === 'ephemeral' ? t('common.continue') : t('encryption.freshConfirm'),
          style: 'destructive',
          onPress: () => {
            proceeded = true;
            void applyModeChange(next);
          },
        },
      ],
      { onDismiss: release },
    );
  };

  // Store the entry as an unverified one-time CANDIDATE, never a committed passphrase. The settings
  // overlay is reachable from the LOCKED boot screen, so "first-time entry ⇒ no encrypted DB exists" is
  // NOT a valid invariant: committing an entry here could strand a DB still encrypted under a different
  // passphrase. The candidate is tried (and consumed) by the next boot's `resolveDbKey`; a wrong one simply
  // fails to open the intact database and the operator is asked again. The passphrase itself is never
  // committed; a confirmed open only records that one governs the DB (`markPassphraseKeyMigrated`).
  const handleSavePassphrase = async () => {
    const trimmed = passphraseInput;
    if (!trimmed) {
      return;
    }
    try {
      await setPassphraseCandidate(trimmed);
    } catch (err) {
      setStatusMessage(t('encryption.passphraseSaveFailed', { error: err instanceof Error ? err.message : String(err) }));
      return;
    }
    setPassphraseInput('');
    setCandidatePending(true);
    setStatusMessage(t('encryption.passphraseEntered'));
  };

  // Only report "forgotten" when the delete is CONFIRMED gone: a swallowed delete failure must not flip
  // the UI to "no passphrase set" while the record still exists. On a failed/unverified clear, keep
  // `passphrasePresence` as it was and surface the failure.
  const forgetPassphrase = async () => {
    const result = await clearStoredPassphrase();
    if (!result.ok) {
      setStatusMessage(t('encryption.forgetFailed', { error: result.error ?? t('common.unknownError') }));
      return;
    }
    setPassphrasePresence('absent');
    setCandidatePending(false);
    setStatusMessage(t('encryption.forgetDone'));
  };

  // Confirm before forgetting: the passphrase itself is never stored, so this only clears the "a passphrase
  // governs this DB" record and any pending entry — but it still gets the same explicit confirmation as
  // every other destructive-looking action in this screen.
  const handleForgetPassphrase = () => {
    Alert.alert(t('encryption.forgetTitle'), t('encryption.forgetBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('encryption.forgetConfirm'), style: 'destructive', onPress: () => void forgetPassphrase() },
    ]);
  };

  // Re-read passphrase presence after an `'error'` state (a transient SecureStore read failure). Until
  // this comes back non-`'error'`, the UI shows no entry path at all.
  const reloadPassphrasePresence = async () => {
    const presence = await hasStoredPassphrase();
    setPassphrasePresence(presence);
    if (presence === 'error') {
      setStatusMessage(t('encryption.presenceReadFailed'));
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
              <ThemedText type="subtitle">{t('encryption.title')}</ThemedText>
              <Pressable onPress={onClose} accessibilityRole="button" hitSlop={Spacing.two}>
                <ThemedText type="link">{t('share.done')}</ThemedText>
              </Pressable>
            </ThemedView>
            <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
              <ThemedText type="small" themeColor="textSecondary">
                {t('encryption.intro')}
              </ThemedText>

              <ThemedView type="backgroundElement" style={styles.noteCard}>
                <ThemedText type="small" themeColor="textSecondary">
                  {t('encryption.note')}
                </ThemedText>
              </ThemedView>

              {statusMessage ? (
                <ThemedView type="backgroundSelected" style={styles.statusBanner}>
                  <ThemedText type="small">{statusMessage}</ThemedText>
                </ThemedView>
              ) : null}

              {loaded
                ? MODE_ORDER.map((entry) => (
                    <Pressable
                      key={entry}
                      onPress={() => handleSelect(entry)}
                      // Disable EVERY mode row while a transition is in flight, so a
                      // second selection can't start until the first fully commits/rolls back.
                      disabled={transitioning}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: mode === entry, disabled: transitioning }}
                      style={[styles.row, transitioning && styles.rowDisabled]}>
                      <ThemedView type={mode === entry ? 'backgroundSelected' : 'backgroundElement'} style={styles.rowInner}>
                        <View style={styles.radioDot}>
                          <View style={[styles.radioDotInner, mode === entry && { backgroundColor: '#208AEF' }]} />
                        </View>
                        <ThemedView style={styles.rowText}>
                          <ThemedText type="smallBold">{modeLabel(entry)}</ThemedText>
                          <ThemedText type="small" themeColor="textSecondary">
                            {t(MODE_TEXT[entry].description)}
                          </ThemedText>
                        </ThemedView>
                      </ThemedView>
                    </Pressable>
                  ))
                : null}

              {mode === 'passphrase' ? (
                <ThemedView type="backgroundElement" style={styles.passphraseCard}>
                  <ThemedText type="smallBold">{t('encryption.passphraseHeading')}</ThemedText>
                  {passphrasePresence === 'present' ? (
                    // A passphrase already governs this database. There is no in-place passphrase rekey, so
                    // this screen can't CHANGE it: the entry here is only a one-time candidate for the next
                    // start (a wrong one just fails to open and is asked for again). Changing a passphrase
                    // goes through the explicit destructive start-fresh flow, which discards the existing
                    // encrypted data. "Forget" only clears the "set" record and any pending entry; the
                    // database still needs the same passphrase at the next start.
                    <>
                      <ThemedText type="small" themeColor="textSecondary">
                        {t('encryption.passphrasePresent')}
                      </ThemedText>
                      <ThemedText type="small" themeColor="textSecondary">
                        {candidatePending ? t('encryption.candidatePendingPresent') : t('encryption.candidateOptional')}
                      </ThemedText>
                      <TextInput
                        value={passphraseInput}
                        onChangeText={setPassphraseInput}
                        placeholder={t('encryption.nextStartPlaceholder')}
                        placeholderTextColor={theme.textSecondary}
                        autoCapitalize="none"
                        autoCorrect={false}
                        secureTextEntry
                        returnKeyType="done"
                        onSubmitEditing={() => void handleSavePassphrase()}
                        style={[styles.textInput, { color: theme.text, borderColor: theme.textSecondary }]}
                      />
                      <View style={styles.passphraseActions}>
                        <Pressable
                          onPress={() => void handleSavePassphrase()}
                          disabled={!passphraseInput}
                          accessibilityRole="button"
                          style={[styles.button, !passphraseInput && styles.buttonDisabled]}>
                          <ThemedText type="smallBold" style={styles.buttonLabel}>
                            {t('encryption.useAtNextStart')}
                          </ThemedText>
                        </Pressable>
                        <Pressable onPress={() => void handleForgetPassphrase()} accessibilityRole="button" style={styles.buttonSecondary}>
                          <ThemedText type="smallBold">{t('encryption.forget')}</ThemedText>
                        </Pressable>
                      </View>
                    </>
                  ) : passphrasePresence === 'error' ? (
                    // A SecureStore read failure: we do NOT know whether a passphrase governs this
                    // database, so show no entry path at all (the presence-error copy promises that).
                    // Offer only a retry.
                    <>
                      <ThemedText type="small" themeColor="textSecondary">
                        {t('encryption.presenceError')}
                      </ThemedText>
                      <View style={styles.passphraseActions}>
                        <Pressable onPress={() => void reloadPassphrasePresence()} accessibilityRole="button" style={styles.buttonSecondary}>
                          <ThemedText type="smallBold">{t('common.retry')}</ThemedText>
                        </Pressable>
                      </View>
                    </>
                  ) : (
                    <>
                      <ThemedText type="small" themeColor="textSecondary">
                        {candidatePending ? t('encryption.candidatePendingAbsent') : t('encryption.noPassphraseYet')}
                      </ThemedText>
                      <TextInput
                        value={passphraseInput}
                        onChangeText={setPassphraseInput}
                        placeholder={t('encryption.enterPlaceholder')}
                        placeholderTextColor={theme.textSecondary}
                        autoCapitalize="none"
                        autoCorrect={false}
                        secureTextEntry
                        returnKeyType="done"
                        onSubmitEditing={() => void handleSavePassphrase()}
                        style={[styles.textInput, { color: theme.text, borderColor: theme.textSecondary }]}
                      />
                      <View style={styles.passphraseActions}>
                        <Pressable
                          onPress={() => void handleSavePassphrase()}
                          disabled={!passphraseInput}
                          accessibilityRole="button"
                          style={[styles.button, !passphraseInput && styles.buttonDisabled]}>
                          <ThemedText type="smallBold" style={styles.buttonLabel}>
                            {t('encryption.savePassphrase')}
                          </ThemedText>
                        </Pressable>
                      </View>
                    </>
                  )}
                </ThemedView>
              ) : null}
              {/* Emergency reset lives here on every network (on a private one it's in the main menu too). */}
              {onEmergencyReset ? (
                <ThemedView type="backgroundElement" style={styles.noteCard}>
                  <ThemedText type="smallBold">{t('reset.title')}</ThemedText>
                  <ThemedText type="small" themeColor="textSecondary">
                    {t('reset.settingsBody')}
                  </ThemedText>
                  <Pressable
                    onPress={onEmergencyReset}
                    accessibilityRole="button"
                    style={[styles.resetButton, { borderColor: theme.danger }]}>
                    <ThemedText type="smallBold" style={{ color: theme.danger }}>
                      {t('reset.open')}
                    </ThemedText>
                  </Pressable>
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
  resetButton: {
    alignSelf: 'flex-start',
    marginTop: Spacing.two,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
    borderRadius: Spacing.four,
    borderWidth: 1,
  },
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
  rowDisabled: {
    opacity: 0.5,
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
