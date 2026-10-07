import Constants from 'expo-constants';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, View } from 'react-native';

import { checkStoreUpdate, distribution, releaseTag } from '../../modules/loam-updates';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  checkGitHubRelease,
  GITHUB_RELEASES_PAGE,
  installedVersionText,
  PLAY_STORE_URL,
  PLAY_STORE_WEB_URL,
  type GitHubCheckResult,
} from '@/lib/app-updates';
import { t } from '@/lib/i18n';

// The Play check runs once per launch, however often the opening screen is shown.
let playCheck: Promise<boolean> | undefined;

/*
 * News of a newer LOAM, on the opening screens only, before any network starts: installing an update
 * restarts LOAM, which would end a running network (and erase a short-lived one). The Google Play build
 * asks the Play Store app by itself; the GitHub build asks GitHub only when "Check for updates" is tapped.
 * Each component renders nothing in the other build. See lib/app-updates.ts.
 */

/** Play build: a card at the top of the opening screen, shown only when Google Play has a newer version. */
export function PlayUpdateNotice() {
  return distribution() === 'play' ? <PlayUpdateCard /> : null;
}

/** GitHub build: a "Check for updates" link at the bottom of the opening screen. */
export function GitHubUpdateCheck() {
  return distribution() === 'github' ? <GitHubCheck /> : null;
}

function PlayUpdateCard() {
  const theme = useTheme();
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    playCheck ??= checkStoreUpdate();
    void playCheck.then((result) => {
      if (!cancelled) setAvailable(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!available) {
    return null;
  }
  return (
    <View style={[styles.card, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}>
      <ThemedText style={styles.cardText}>{t('update.available')}</ThemedText>
      <Pressable
        accessibilityRole="button"
        onPress={() => void Linking.openURL(PLAY_STORE_URL).catch(() => Linking.openURL(PLAY_STORE_WEB_URL).catch(() => undefined))}
        style={[styles.cardButton, { backgroundColor: theme.primary }]}>
        <ThemedText style={styles.cardButtonLabel}>{t('update.update')}</ThemedText>
      </Pressable>
    </View>
  );
}

/** Asks GitHub when tapped, never on its own. */
function GitHubCheck() {
  const theme = useTheme();
  // The build's release tag when it has one, so a release candidate shows (and compares) as 0.6.0-rc.1.
  const current = installedVersionText(releaseTag(), Constants.expoConfig?.version ?? '');
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<GitHubCheckResult>();

  async function check(): Promise<void> {
    setChecking(true);
    setResult(undefined);
    setResult(await checkGitHubRelease(current));
    setChecking(false);
  }

  return (
    <View style={styles.github}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: checking }}
        disabled={checking}
        onPress={() => void check()}
        hitSlop={Spacing.two}
        style={styles.link}>
        {checking ? <ActivityIndicator size="small" color={theme.primaryInk} /> : null}
        <ThemedText style={[styles.linkLabel, { color: theme.primaryInk }]}>
          {checking ? t('update.checking') : t('update.check')}
        </ThemedText>
      </Pressable>
      {result?.kind === 'available' ? (
        <View style={[styles.card, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}>
          <ThemedText style={styles.cardText}>{t('update.newer', { version: result.version, current })}</ThemedText>
          <Pressable
            accessibilityRole="button"
            onPress={() => void Linking.openURL(GITHUB_RELEASES_PAGE).catch(() => undefined)}
            style={[styles.cardButton, { backgroundColor: theme.primary }]}>
            <ThemedText style={styles.cardButtonLabel}>{t('update.download')}</ThemedText>
          </Pressable>
        </View>
      ) : null}
      {result?.kind === 'current' ? (
        <ThemedText type="small" themeColor="textSecondary">
          {t('update.current', { version: current })}
        </ThemedText>
      ) : null}
      {result?.kind === 'failed' ? (
        <ThemedText type="small" style={{ color: theme.danger }}>
          {t('update.failed')}
        </ThemedText>
      ) : null}
      <ThemedText type="small" themeColor="textSecondary">
        {t('update.githubNote')}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: Spacing.two, padding: Spacing.three, borderRadius: 14, borderWidth: 1 },
  cardText: { fontSize: 15, lineHeight: 21 },
  cardButton: { alignItems: 'center', paddingVertical: 12, borderRadius: 12 },
  cardButtonLabel: { color: '#ffffff', fontSize: 15, lineHeight: 20, fontWeight: 700 },
  github: { gap: Spacing.two, marginTop: Spacing.two },
  link: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: Spacing.two, paddingVertical: Spacing.one },
  linkLabel: { fontSize: 15, lineHeight: 20, fontWeight: 600 },
});
