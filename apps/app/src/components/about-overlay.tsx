import Constants from 'expo-constants';
import { Image } from 'expo-image';
import { Linking, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { SymbolView, type AndroidSymbol, type SFSymbol } from 'expo-symbols';

import { releaseTag } from '../../modules/loam-updates';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useAppLocale } from '@/hooks/use-app-locale';
import { useTheme } from '@/hooks/use-theme';
import { installedVersionText } from '@/lib/app-updates';
import { t, type AppCatalogKey } from '@/lib/i18n';

/** What the About screen links to. Each opens outside LOAM (the browser, or the mail app). */
const LINKS: { label: AppCatalogKey; value: string; url: string; icon: { android: AndroidSymbol; ios: SFSymbol } }[] = [
  { label: 'about.website', value: 'loamnet.com', url: 'https://loamnet.com', icon: { android: 'language', ios: 'globe' } },
  {
    label: 'about.email',
    value: 'opensource@magiczebra.co.uk',
    url: 'mailto:opensource@magiczebra.co.uk',
    icon: { android: 'mail', ios: 'envelope' },
  },
  {
    label: 'about.source',
    value: 'github.com/MagicZebraLtd/loam',
    url: 'https://github.com/MagicZebraLtd/loam',
    icon: { android: 'code', ios: 'chevron.left.forwardslash.chevron.right' },
  },
];

/**
 * About LOAM: the version, who makes it, and how to reach us. LOAM has no analytics or crash reporting, so
 * this is where a host finds out how to tell us about a problem. Deliberately no payment or "support" link
 * (Google Play's rules on pointing to outside payments); the website covers that.
 */
export function AboutOverlay({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  useAppLocale(); // re-render in the chosen language
  const theme = useTheme();
  const version = installedVersionText(releaseTag(), Constants.expoConfig?.version ?? '');

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaProvider>
        <ThemedView style={styles.container}>
          <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
            <View style={styles.header}>
              <ThemedText type="subtitle">{t('about.title')}</ThemedText>
              <Pressable onPress={onClose} accessibilityRole="button" hitSlop={Spacing.two}>
                <ThemedText type="link">{t('common.close')}</ThemedText>
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={styles.body}>
              <View style={styles.identity}>
                <Image
                  source={require('../../assets/images/loam-splash.png')}
                  style={styles.logo}
                  contentFit="cover"
                  accessibilityLabel="LOAM"
                  accessibilityRole="image"
                />
                <View style={styles.identityText}>
                  <ThemedText style={styles.name}>LOAM</ThemedText>
                  <ThemedText themeColor="textSecondary">{t('about.version', { version })}</ThemedText>
                </View>
              </View>
              <ThemedText style={styles.lead}>{t('about.body')}</ThemedText>
              <ThemedView type="backgroundElement" style={[styles.links, { borderColor: theme.border }]}>
                {LINKS.map((link, index) => (
                  <Pressable
                    key={link.url}
                    onPress={() => void Linking.openURL(link.url).catch(() => undefined)}
                    accessibilityRole="link"
                    style={({ pressed }) => [
                      styles.link,
                      index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border },
                      pressed && { backgroundColor: theme.backgroundSelected },
                    ]}>
                    <SymbolView name={link.icon} size={22} tintColor={theme.primaryInk} type="monochrome" />
                    <View style={styles.linkText}>
                      <ThemedText style={styles.linkLabel}>{t(link.label)}</ThemedText>
                      <ThemedText themeColor="textSecondary" style={styles.linkValue}>
                        {link.value}
                      </ThemedText>
                    </View>
                    <SymbolView name={{ android: 'open_in_new', ios: 'arrow.up.right' }} size={18} tintColor={theme.textSecondary} />
                  </Pressable>
                ))}
              </ThemedView>
              <ThemedText type="small" themeColor="textSecondary">
                {t('about.madeBy')}
              </ThemedText>
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
    paddingVertical: Spacing.three,
  },
  body: { paddingHorizontal: Spacing.four, paddingBottom: Spacing.five, gap: Spacing.four },
  identity: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three },
  logo: { width: 60, height: 60, borderRadius: 15 },
  identityText: { gap: 2 },
  name: { fontSize: 24, lineHeight: 30, fontWeight: 700 },
  lead: { fontSize: 16, lineHeight: 24 },
  links: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  link: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 14 },
  linkText: { flex: 1, gap: 2 },
  linkLabel: { fontSize: 16, lineHeight: 22, fontWeight: 600 },
  linkValue: { fontSize: 14, lineHeight: 20 },
});
