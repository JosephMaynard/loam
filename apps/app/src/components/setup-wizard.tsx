import { useEffect, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SymbolView, type AndroidSymbol, type SFSymbol } from 'expo-symbols';

import { CodeScanner } from '@/components/code-scanner';
import { HoldToConfirm } from '@/components/hold-to-confirm';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { chooseAppLocale, loadAppLocale, useAppLocale } from '@/hooks/use-app-locale';
import { loadHostMode, setHostMode } from '@/hooks/use-host-mode';
import { useTheme } from '@/hooks/use-theme';
import { APP_LOCALES, LOCALE_NAMES, t, type AppCatalogKey } from '@/lib/i18n';
import { detectPreviousNetwork, loadSetupRecord, prepareNewNetwork, saveSetupRecord } from '@/lib/new-network';
import {
  cleanNodeName,
  DEFAULT_NODE_NAME,
  type SetupConnection,
  type SetupPeer,
  type SetupPreset,
  type SetupRecord,
} from '@/lib/setup';

/** How setup ended: which network to run, and whether it's a new one (the caller opens the next screen). */
export type SetupOutcome = { record: SetupRecord; newNetwork: boolean };

type Step = 'loading' | 'language' | 'home' | 'erase' | 'type' | 'name' | 'connect' | 'scan';

type Icon = { android: AndroidSymbol; ios: SFSymbol };

const PRESETS: { preset: SetupPreset; icon: Icon; title: AppCatalogKey; body: AppCatalogKey; note?: AppCatalogKey }[] = [
  { preset: 'community', icon: { android: 'groups', ios: 'person.3' }, title: 'setup.communityTitle', body: 'setup.communityBody', note: 'setup.communityNote' },
  { preset: 'private', icon: { android: 'shield_lock', ios: 'lock.shield' }, title: 'setup.privateTitle', body: 'setup.privateBody', note: 'setup.privateNote' },
  { preset: 'custom', icon: { android: 'tune', ios: 'slider.horizontal.3' }, title: 'setup.customTitle', body: 'setup.customBody' },
];

const CONNECTIONS: { connection: SetupConnection; icon: Icon; title: AppCatalogKey; body: AppCatalogKey }[] = [
  { connection: 'hotspot', icon: { android: 'wifi_tethering', ios: 'personalhotspot' }, title: 'share.hotspot', body: 'share.hotspotHelp' },
  { connection: 'wifi', icon: { android: 'wifi', ios: 'wifi' }, title: 'share.wifi', body: 'share.wifiHelp' },
  { connection: 'join', icon: { android: 'hub', ios: 'point.3.connected.trianglepath.dotted' }, title: 'setup.joinTitle', body: 'setup.joinBody' },
];

/**
 * The host's opening screens, shown before the network starts. The first time: language, what kind of
 * network, its name, and how people connect. After that, one screen with the remembered network: continue
 * it in one tap, or start a new one (erasing the old one takes a press-and-hold). Nothing starts until this
 * finishes, so a new network's settings are in place before the server first reads them.
 */
export function SetupWizard({ onDone }: { onDone: (outcome: SetupOutcome) => void }) {
  const locale = useAppLocale();
  const theme = useTheme();
  const [step, setStep] = useState<Step>('loading');
  const [continuable, setContinuable] = useState(false);
  const [remembered, setRemembered] = useState<SetupRecord>();
  const [preset, setPreset] = useState<SetupPreset>('community');
  const [nodeName, setNodeName] = useState('');
  const [connection, setConnection] = useState<SetupConnection>('hotspot');
  // The node scanned when joining another network, and a counter that restarts the scanner.
  const [peer, setPeer] = useState<SetupPeer>();
  const [scanKey, setScanKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // Where the language screen returns to (it's also reachable later from the home screen).
  const [afterLanguage, setAfterLanguage] = useState<Step>('type');

  useEffect(() => {
    let cancelled = false;
    void Promise.all([loadAppLocale(), detectPreviousNetwork(), loadSetupRecord(), loadHostMode()]).then(
      ([storedLocale, previous, record, hostMode]) => {
        if (cancelled) {
          return;
        }
        setContinuable(previous);
        setRemembered(record);
        setPreset(record?.preset ?? 'community');
        setNodeName(record && record.nodeName !== DEFAULT_NODE_NAME ? record.nodeName : '');
        setConnection(record?.connection ?? hostMode);
        // Only a network that can be continued gets the "Welcome back" screen. A private network that was
        // erased isn't mentioned at all: setup just starts again, with the last answers filled in.
        const home: Step = previous ? 'home' : 'type';
        setAfterLanguage(home);
        setStep(storedLocale ? home : 'language');
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const previousStep: Partial<Record<Step, Step>> = {
    erase: 'home',
    type: continuable ? 'home' : 'language',
    name: 'type',
    connect: 'name',
    scan: 'connect',
  };

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      const back = busy ? undefined : previousStep[step];
      if (back) {
        setError(undefined);
        setStep(back);
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  });

  async function startNew(record: SetupRecord): Promise<void> {
    setBusy(true);
    setError(undefined);
    const prepared = await prepareNewNetwork(record, locale);
    if (!prepared.ok) {
      setBusy(false);
      setError(t('setup.failed', { error: prepared.error }));
      return;
    }
    // A joining node serves people on the network it joined, so it hosts on that Wi-Fi. The remembered
    // answers leave the peer out: its link code is spent once used, so joining again means a fresh scan.
    const { peer: _spent, ...remembered } = record;
    await Promise.all([saveSetupRecord(remembered), setHostMode(record.connection === 'join' ? 'wifi' : record.connection)]);
    onDone({ record, newNetwork: true });
  }

  function continuePrevious(): void {
    onDone({
      record: remembered ?? { preset: 'custom', nodeName: DEFAULT_NODE_NAME, connection },
      newNetwork: false,
    });
  }

  const rememberedName = remembered && remembered.nodeName !== DEFAULT_NODE_NAME ? remembered.nodeName : undefined;

  function chooseLanguage(next: (typeof APP_LOCALES)[number]): void {
    void chooseAppLocale(next);
    setStep(afterLanguage);
  }

  let content: ReactNode;
  switch (step) {
    case 'loading':
      content = <ActivityIndicator size="large" style={styles.loading} />;
      break;

    case 'language':
      content = (
        <>
          <ThemedText type="subtitle">{t('setup.languageTitle')}</ThemedText>
          <View style={styles.languages}>
            {APP_LOCALES.map((code) => (
              <Pressable
                key={code}
                accessibilityRole="button"
                accessibilityState={{ selected: code === locale }}
                onPress={() => chooseLanguage(code)}
                style={[
                  styles.language,
                  { backgroundColor: code === locale ? theme.backgroundSelected : theme.backgroundElement },
                ]}>
                <ThemedText>{LOCALE_NAMES[code]}</ThemedText>
              </Pressable>
            ))}
          </View>
        </>
      );
      break;

    case 'home':
      content = (
        <>
          <ThemedText type="subtitle">{t('setup.backTitle')}</ThemedText>
          <ThemedText themeColor="textSecondary">{t('setup.continueHelp')}</ThemedText>
          <PrimaryButton
            label={rememberedName ? t('setup.continue', { name: rememberedName }) : t('setup.continuePlain')}
            onPress={continuePrevious}
          />
          <SecondaryButton label={t('setup.startNew')} onPress={() => setStep('erase')} />
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setAfterLanguage('home');
              setStep('language');
            }}
            hitSlop={Spacing.two}>
            <ThemedText type="link">{t('setup.languageLink', { language: LOCALE_NAMES[locale] })}</ThemedText>
          </Pressable>
        </>
      );
      break;

    case 'erase':
      content = (
        <>
          <ThemedText type="subtitle">{t('setup.eraseTitle')}</ThemedText>
          <ThemedText>
            {rememberedName ? t('setup.eraseBody', { name: rememberedName }) : t('setup.eraseBodyPlain')}
          </ThemedText>
          <HoldToConfirm label={t('setup.eraseHold')} holdingLabel={t('setup.eraseHolding')} onConfirm={() => setStep('type')} />
          <SecondaryButton label={t('common.cancel')} onPress={() => setStep('home')} />
        </>
      );
      break;

    case 'type':
      content = (
        <>
          <ThemedText type="subtitle">{t('setup.typeTitle')}</ThemedText>
          <ThemedText themeColor="textSecondary">{t('setup.typeBody')}</ThemedText>
          {/* Each kind is a button: choosing one moves straight on (the last choice is highlighted). */}
          {PRESETS.map((option) => (
            <Choice
              key={option.preset}
              icon={option.icon}
              // No "last time" highlight: each option is a button, and marking the previous choice would
              // tell anyone holding the phone what kind of network it ran before.
              selected={false}
              advances
              onPress={() => {
                setPreset(option.preset);
                setStep('name');
              }}
              title={t(option.title)}
              body={t(option.body)}
              note={option.note ? t(option.note) : undefined}
            />
          ))}
        </>
      );
      break;

    case 'name':
      content = (
        <>
          <ThemedText type="subtitle">{t('setup.nameTitle')}</ThemedText>
          <ThemedText themeColor="textSecondary">{t('setup.nameBody')}</ThemedText>
          <TextInput
            value={nodeName}
            onChangeText={setNodeName}
            placeholder={DEFAULT_NODE_NAME}
            placeholderTextColor={theme.textSecondary}
            maxLength={80}
            autoCapitalize="words"
            autoCorrect={false}
            returnKeyType="next"
            onSubmitEditing={() => setStep('connect')}
            style={[styles.input, { color: theme.text, backgroundColor: theme.backgroundElement, borderColor: theme.backgroundSelected }]}
          />
          <PrimaryButton label={t('setup.next')} onPress={() => setStep('connect')} />
        </>
      );
      break;

    case 'connect':
      content = (
        <>
          <ThemedText type="subtitle">{t('setup.connectTitle')}</ThemedText>
          {CONNECTIONS.map((option) => (
            <Choice
              key={option.connection}
              icon={option.icon}
              selected={connection === option.connection}
              onPress={() => setConnection(option.connection)}
              title={t(option.title)}
              body={t(option.body)}
            />
          ))}
          {connection === 'join' ? (
            <PrimaryButton label={t('setup.next')} onPress={() => setStep('scan')} />
          ) : (
            <PrimaryButton
              label={busy ? t('setup.starting') : t('setup.start')}
              disabled={busy}
              onPress={() => void startNew({ preset, nodeName: cleanNodeName(nodeName), connection })}
            />
          )}
        </>
      );
      break;

    case 'scan':
      content = (
        <>
          <ThemedText type="subtitle">{t('setup.scanTitle')}</ThemedText>
          <ThemedText themeColor="textSecondary">{t('setup.scanBody')}</ThemedText>
          {peer ? (
            <>
              <ThemedText type="smallBold">{t('setup.scanFound', { url: peer.url })}</ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                {t('setup.joinNote')}
              </ThemedText>
              <PrimaryButton
                label={busy ? t('setup.starting') : t('setup.start')}
                disabled={busy}
                onPress={() => void startNew({ preset, nodeName: cleanNodeName(nodeName), connection: 'join', peer })}
              />
              <SecondaryButton
                label={t('setup.scanAgain')}
                disabled={busy}
                onPress={() => {
                  setPeer(undefined);
                  setScanKey((key) => key + 1);
                }}
              />
            </>
          ) : (
            <CodeScanner key={scanKey} onFound={setPeer} />
          )}
        </>
      );
      break;
  }

  const back = previousStep[step];
  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            {step === 'language' || (step === 'type' && !continuable) ? (
              <View style={styles.welcome}>
                <ThemedText type="title">{t('setup.welcomeTitle')}</ThemedText>
                <ThemedText themeColor="textSecondary">{t('setup.welcomeBody')}</ThemedText>
              </View>
            ) : null}
            {content}
            {error ? (
              <ThemedText type="small" style={{ color: theme.danger }}>
                {error}
              </ThemedText>
            ) : null}
            {back && !busy ? (
              <Pressable accessibilityRole="button" onPress={() => setStep(back)} hitSlop={Spacing.two} style={styles.back}>
                <ThemedText type="link">{t('setup.back')}</ThemedText>
              </Pressable>
            ) : null}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </ThemedView>
  );
}

/**
 * One option in a list of choices: a card with an icon, a title, a plain description and an optional
 * caveat. `advances` makes it a button that moves on (with a chevron) rather than a selection to confirm.
 */
function Choice({
  advances = false,
  body,
  icon,
  note,
  onPress,
  selected,
  title,
}: {
  advances?: boolean;
  body: string;
  icon: Icon;
  note?: string;
  onPress: () => void;
  selected: boolean;
  title: string;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole={advances ? 'button' : 'radio'}
      accessibilityState={advances ? undefined : { selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.choice,
        {
          backgroundColor: selected || pressed ? theme.backgroundSelected : theme.backgroundElement,
          borderColor: selected ? theme.primary : theme.backgroundSelected,
        },
      ]}>
      <View style={[styles.choiceIcon, { backgroundColor: theme.background }]}>
        <SymbolView name={icon} size={26} tintColor={theme.primary} type="monochrome" />
      </View>
      <View style={styles.choiceText}>
        <ThemedText type="smallBold">{title}</ThemedText>
        <ThemedText type="small">{body}</ThemedText>
        {note ? (
          <ThemedText type="small" themeColor="textSecondary">
            {note}
          </ThemedText>
        ) : null}
      </View>
      {advances ? <SymbolView name={{ android: 'chevron_right', ios: 'chevron.right' }} size={22} tintColor={theme.textSecondary} /> : null}
    </Pressable>
  );
}

function PrimaryButton({ disabled, label, onPress }: { disabled?: boolean; label: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, { backgroundColor: theme.primary, opacity: disabled ? 0.6 : 1 }]}>
      <ThemedText type="smallBold" style={styles.primaryLabel}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

function SecondaryButton({ disabled, label, onPress }: { disabled?: boolean; label: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, styles.secondary, { borderColor: theme.primary, opacity: disabled ? 0.6 : 1 }]}>
      <ThemedText type="smallBold">{label}</ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safeArea: { flex: 1, width: '100%', maxWidth: MaxContentWidth, alignSelf: 'center' },
  flex: { flex: 1 },
  content: { padding: Spacing.four, gap: Spacing.three, flexGrow: 1 },
  loading: { flex: 1 },
  welcome: { gap: Spacing.two, paddingBottom: Spacing.two },
  languages: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
  language: { paddingHorizontal: Spacing.three, paddingVertical: Spacing.two, borderRadius: Spacing.four },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    padding: Spacing.three,
    borderRadius: Spacing.three,
    borderWidth: 2,
  },
  choiceIcon: { width: 48, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  choiceText: { flex: 1, gap: Spacing.one },
  input: { borderWidth: 1, borderRadius: Spacing.three, paddingHorizontal: Spacing.three, paddingVertical: Spacing.two, fontSize: 18 },
  button: { alignItems: 'center', paddingVertical: Spacing.three, borderRadius: Spacing.four },
  secondary: { borderWidth: 1, backgroundColor: 'transparent' },
  primaryLabel: { color: '#ffffff' },
  back: { alignSelf: 'flex-start' },
});
