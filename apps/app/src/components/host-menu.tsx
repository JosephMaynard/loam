import { Fragment } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { SymbolView, type AndroidSymbol, type SFSymbol } from 'expo-symbols';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useAppLocale } from '@/hooks/use-app-locale';
import { useTheme } from '@/hooks/use-theme';
import { t, type AppCatalogKey } from '@/lib/i18n';

export type HostMenuAction = 'invite' | 'encryption' | 'assistant' | 'rules' | 'privacy' | 'about' | 'reset';

type Item = { action: HostMenuAction; label: AppCatalogKey; icon: { android: AndroidSymbol; ios: SFSymbol } };

/**
 * The menu, in groups: what a host does most (invite people), then this phone's settings, then reading, and
 * Emergency reset last, set apart and in red so it's easy to find in a hurry but never where a thumb lands
 * by habit (its own screen asks for a press-and-hold).
 */
const GROUPS: Item[][] = [
  [{ action: 'invite', label: 'menu.invite', icon: { android: 'qr_code_2', ios: 'qrcode' } }],
  [
    { action: 'encryption', label: 'menu.encryption', icon: { android: 'lock', ios: 'lock' } },
    { action: 'assistant', label: 'menu.assistant', icon: { android: 'auto_awesome', ios: 'sparkles' } },
  ],
  [
    { action: 'rules', label: 'menu.rules', icon: { android: 'checklist', ios: 'checklist' } },
    { action: 'privacy', label: 'menu.privacy', icon: { android: 'shield', ios: 'hand.raised' } },
    { action: 'about', label: 'menu.about', icon: { android: 'info', ios: 'info.circle' } },
  ],
  [{ action: 'reset', label: 'reset.menu', icon: { android: 'warning', ios: 'exclamationmark.triangle' } }],
];

/**
 * The host's menu: a card dropping from the top bar's menu button over a dimmed backdrop (tap outside to
 * close). It only reports which item was chosen; the screen behind it opens the matching overlay or page.
 */
export function HostMenu({
  visible,
  top,
  onClose,
  onSelect,
}: {
  visible: boolean;
  /** Where the card starts: just under the top bar. */
  top: number;
  onClose: () => void;
  onSelect: (action: HostMenuAction) => void;
}) {
  useAppLocale(); // re-render in the chosen language
  const theme = useTheme();

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityRole="button" accessibilityLabel={t('common.close')}>
        <View style={[styles.cardWrap, { paddingTop: top }]}>
          {/* A Pressable that swallows taps, so a tap on the card's padding doesn't close the menu. */}
          <Pressable>
            <ThemedView type="backgroundElement" style={[styles.card, { borderColor: theme.border }]}>
              {GROUPS.map((group, index) => (
                <Fragment key={group[0]!.action}>
                  {index > 0 ? <View style={[styles.divider, { backgroundColor: theme.border }]} /> : null}
                  {group.map((item) => {
                    const danger = item.action === 'reset';
                    const tint = danger ? theme.danger : theme.primaryInk;
                    return (
                      <Pressable
                        key={item.action}
                        onPress={() => {
                          onClose();
                          onSelect(item.action);
                        }}
                        accessibilityRole="button"
                        style={({ pressed }) => [styles.item, pressed && { backgroundColor: theme.backgroundSelected }]}>
                        <SymbolView name={item.icon} size={22} tintColor={tint} type="monochrome" />
                        <ThemedText style={[styles.label, danger && { color: theme.danger }]}>{t(item.label)}</ThemedText>
                      </Pressable>
                    );
                  })}
                </Fragment>
              ))}
            </ThemedView>
          </Pressable>
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  cardWrap: { alignItems: 'flex-end', paddingRight: Spacing.two, marginTop: Spacing.one },
  card: { minWidth: 240, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, paddingVertical: Spacing.one, overflow: 'hidden' },
  item: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 18, paddingVertical: 13 },
  label: { fontSize: 16, lineHeight: 22, fontWeight: 500 },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: Spacing.one },
});
