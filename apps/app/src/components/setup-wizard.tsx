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
import { Image } from 'expo-image';
import { SymbolView, type AndroidSymbol, type SFSymbol } from 'expo-symbols';

import { CodeScanner } from '@/components/code-scanner';
import { HoldToConfirm } from '@/components/hold-to-confirm';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { GitHubUpdateCheck, PlayUpdateNotice } from '@/components/update-notice';
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

  // The screen setup opens on: "Welcome back", or the first question when there's nothing to continue.
  const opening = step === 'home' || (step === 'type' && !continuable);

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
          <StepHeading title={t('setup.languageTitle')} />
          <View style={styles.languages}>
            {APP_LOCALES.map((code) => (
              <Pressable
                key={code}
                accessibilityRole="button"
                accessibilityState={{ selected: code === locale }}
                onPress={() => chooseLanguage(code)}
                style={({ pressed }) => [
                  styles.language,
                  code === locale
                    ? { backgroundColor: theme.primarySoft, borderColor: theme.primaryInk }
                    : { backgroundColor: pressed ? theme.backgroundSelected : theme.backgroundElement, borderColor: theme.border },
                ]}>
                <ThemedText style={styles.languageLabel}>{LOCALE_NAMES[code]}</ThemedText>
              </Pressable>
            ))}
          </View>
        </>
      );
      break;

    case 'home':
      content = (
        <>
          <Hero title={t('setup.backTitle')} body={t('setup.continueHelp')} />
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
            hitSlop={Spacing.two}
            style={styles.textLink}>
            <ThemedText style={[styles.linkLabel, { color: theme.primaryInk }]}>
              {t('setup.languageLink', { language: LOCALE_NAMES[locale] })}
            </ThemedText>
          </Pressable>
        </>
      );
      break;

    case 'erase':
      content = (
        <>
          <StepHeading
            title={t('setup.eraseTitle')}
            body={rememberedName ? t('setup.eraseBody', { name: rememberedName }) : t('setup.eraseBodyPlain')}
          />
          <HoldToConfirm label={t('setup.eraseHold')} holdingLabel={t('setup.eraseHolding')} onConfirm={() => setStep('type')} />
          <SecondaryButton label={t('common.cancel')} onPress={() => setStep('home')} />
        </>
      );
      break;

    case 'type':
      content = (
        <>
          <StepHeading title={t('setup.typeTitle')} body={t('setup.typeBody')} />
          {/* Each kind is a button: choosing one moves straight on. */}
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
          <StepHeading title={t('setup.nameTitle')} body={t('setup.nameBody')} />
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
            style={[styles.input, { color: theme.text, backgroundColor: theme.backgroundElement, borderColor: theme.border }]}
          />
          <PrimaryButton label={t('setup.next')} onPress={() => setStep('connect')} />
        </>
      );
      break;

    case 'connect':
      content = (
        <>
          <StepHeading title={t('setup.connectTitle')} />
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
          <StepHeading title={t('setup.scanTitle')} body={t('setup.scanBody')} />
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
            {back && !busy ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setError(undefined);
                  setStep(back);
                }}
                hitSlop={Spacing.two}
                style={styles.back}>
                <SymbolView name={{ android: 'chevron_left', ios: 'chevron.left' }} size={20} tintColor={theme.textSecondary} />
                <ThemedText themeColor="textSecondary" style={styles.backLabel}>
                  {t('setup.back')}
                </ThemedText>
              </Pressable>
            ) : null}
            {step === 'language' || (step === 'type' && !continuable) ? (
              <Hero title={t('setup.welcomeTitle')} body={t('setup.welcomeBody')} />
            ) : null}
            {/* Update news only on the screen setup opens on, where no network is running yet. */}
            {opening ? <PlayUpdateNotice /> : null}
            {content}
            {opening ? <GitHubUpdateCheck /> : null}
            {error ? (
              <ThemedText type="small" style={{ color: theme.danger }}>
                {error}
              </ThemedText>
            ) : null}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </ThemedView>
  );
}

/**
 * The top of the first screens: the LOAM mark with the screen's title beside it, and a line about it below.
 */
function Hero({ body, title }: { body?: string; title: string }) {
  return (
    <View style={styles.hero}>
      <View style={styles.heroRow}>
        <Image
          source={require('../../assets/images/loam-splash.png')}
          style={styles.logo}
          contentFit="cover"
          accessibilityLabel="LOAM"
          accessibilityRole="image"
        />
        <ThemedText style={styles.heroTitle} accessibilityRole="header">
          {title}
        </ThemedText>
      </View>
      {body ? (
        <ThemedText themeColor="textSecondary" style={styles.lead}>
          {body}
        </ThemedText>
      ) : null}
    </View>
  );
}

/** A step's question, and an optional line explaining it. */
function StepHeading({ body, title }: { body?: string; title: string }) {
  return (
    <View style={styles.stepHeading}>
      <ThemedText style={styles.stepTitle} accessibilityRole="header">
        {title}
      </ThemedText>
      {body ? (
        <ThemedText themeColor="textSecondary" style={styles.lead}>
          {body}
        </ThemedText>
      ) : null}
    </View>
  );
}

/**
 * One option in a list of choices: a card with its icon in the corner, a title, a plain description and an
 * optional caveat set apart below. `advances` makes it a button that moves on (with a chevron) rather than
 * a selection to confirm (with a radio mark).
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
          backgroundColor: selected ? theme.primarySoft : pressed ? theme.backgroundSelected : theme.backgroundElement,
          borderColor: selected ? theme.primaryInk : theme.border,
        },
      ]}>
      <View style={[styles.choiceIcon, { backgroundColor: selected ? theme.backgroundElement : theme.primarySoft }]}>
        <SymbolView name={icon} size={22} tintColor={theme.primaryInk} type="monochrome" />
      </View>
      <View style={styles.choiceText}>
        <ThemedText style={styles.choiceTitle}>{title}</ThemedText>
        <ThemedText themeColor="textSecondary" style={styles.choiceBody}>
          {body}
        </ThemedText>
        {note ? (
          <View style={[styles.choiceNote, { borderTopColor: theme.border }]}>
            <SymbolView name={{ android: 'info', ios: 'info.circle' }} size={16} tintColor={theme.textSecondary} />
            <ThemedText themeColor="textSecondary" style={styles.choiceNoteText}>
              {note}
            </ThemedText>
          </View>
        ) : null}
      </View>
      {advances ? (
        <View style={styles.choiceEnd}>
          <SymbolView name={{ android: 'chevron_right', ios: 'chevron.right' }} size={22} tintColor={theme.textSecondary} />
        </View>
      ) : (
        <View style={[styles.radio, { borderColor: selected ? theme.primaryInk : theme.textSecondary }]}>
          {selected ? <View style={[styles.radioDot, { backgroundColor: theme.primaryInk }]} /> : null}
        </View>
      )}
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
      <ThemedText style={[styles.buttonLabel, styles.primaryLabel]}>{label}</ThemedText>
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
      style={[styles.button, styles.secondary, { borderColor: theme.primaryInk, opacity: disabled ? 0.6 : 1 }]}>
      <ThemedText style={[styles.buttonLabel, { color: theme.primaryInk }]}>{label}</ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safeArea: { flex: 1, width: '100%', maxWidth: MaxContentWidth, alignSelf: 'center' },
  flex: { flex: 1 },
  content: { paddingHorizontal: Spacing.four, paddingTop: Spacing.four, paddingBottom: Spacing.five, gap: Spacing.three, flexGrow: 1 },
  loading: { flex: 1 },
  back: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: Spacing.half, marginLeft: -6 },
  backLabel: { fontSize: 15, lineHeight: 20 },
  hero: { gap: Spacing.three, marginBottom: Spacing.three },
  heroRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three },
  logo: { width: 60, height: 60, borderRadius: 15 },
  heroTitle: { flex: 1, fontSize: 30, lineHeight: 36, fontWeight: 700 },
  lead: { fontSize: 16, lineHeight: 24, fontWeight: 400 },
  stepHeading: { gap: 6, marginBottom: Spacing.one },
  stepTitle: { fontSize: 24, lineHeight: 30, fontWeight: 700 },
  languages: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  language: { paddingHorizontal: Spacing.three, paddingVertical: 10, borderRadius: 999, borderWidth: 1 },
  languageLabel: { fontSize: 15, lineHeight: 20 },
  choice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 14,
    padding: Spacing.three,
    borderRadius: 18,
    borderWidth: 1.5,
  },
  choiceIcon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  choiceText: { flex: 1, gap: Spacing.one },
  choiceTitle: { fontSize: 17, lineHeight: 22, fontWeight: 700 },
  choiceBody: { fontSize: 15, lineHeight: 21, fontWeight: 400 },
  choiceNote: {
    flexDirection: 'row',
    gap: 6,
    marginTop: Spacing.two,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  choiceNoteText: { flex: 1, fontSize: 13, lineHeight: 18, fontWeight: 400 },
  choiceEnd: { alignSelf: 'center' },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, alignItems: 'center', justifyContent: 'center', marginTop: 9 },
  radioDot: { width: 10, height: 10, borderRadius: 5 },
  input: { borderWidth: 1.5, borderRadius: 14, paddingHorizontal: Spacing.three, paddingVertical: 14, fontSize: 18 },
  button: { alignItems: 'center', paddingVertical: 15, borderRadius: 14 },
  buttonLabel: { fontSize: 16, lineHeight: 22, fontWeight: 700 },
  secondary: { borderWidth: 1.5, backgroundColor: 'transparent' },
  primaryLabel: { color: '#ffffff' },
  textLink: { alignSelf: 'flex-start', paddingVertical: Spacing.one },
  linkLabel: { fontSize: 15, lineHeight: 20, fontWeight: 600 },
});
