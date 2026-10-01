import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRef, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { t } from '@/lib/i18n';
import { parseScannedCode, parseTypedAddress } from '@/lib/join-code';
import type { SetupPeer } from '@/lib/setup';

/**
 * Scan another LOAM node's join code (setup's "Join another LOAM network"). Asks for the camera only when
 * shown, reads QR codes only, and stops at the first LOAM code. Its hotspot's Wi-Fi code gets a pointer to
 * the phone's Wi-Fi settings instead. Without a camera (or permission), the address can be typed, which
 * leaves the peer's key unpinned.
 */
export function CodeScanner({ onFound }: { onFound: (peer: SetupPeer) => void }) {
  const theme = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [hint, setHint] = useState<string>();
  const [typed, setTyped] = useState('');
  // The camera reports the same code many times a second; act on the first LOAM one only.
  const done = useRef(false);

  function onScanned(data: string): void {
    if (done.current) {
      return;
    }
    const code = parseScannedCode(data);
    if (code.kind === 'loam') {
      done.current = true;
      onFound({ url: code.url, ...(code.transportKey ? { transportKey: code.transportKey } : {}) });
    } else {
      setHint(code.kind === 'wifi' ? t('setup.scanWifi', { network: code.ssid }) : t('setup.scanOther'));
    }
  }

  function submitTyped(): void {
    const address = parseTypedAddress(typed);
    if (address) {
      onFound(address);
    } else {
      setHint(t('setup.scanOther'));
    }
  }

  return (
    <View style={styles.container}>
      {permission?.granted ? (
        <View style={styles.cameraFrame}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={(result) => onScanned(result.data)}
          />
        </View>
      ) : (
        <View style={[styles.permission, { backgroundColor: theme.backgroundElement }]}>
          <ThemedText type="small">
            {permission && !permission.canAskAgain ? t('setup.scanDenied') : t('setup.scanPermission')}
          </ThemedText>
          {permission && !permission.canAskAgain ? null : (
            <Pressable
              accessibilityRole="button"
              onPress={() => void requestPermission()}
              style={[styles.button, { backgroundColor: theme.primary }]}>
              <ThemedText type="smallBold" style={styles.buttonLabel}>
                {t('setup.scanAllow')}
              </ThemedText>
            </Pressable>
          )}
        </View>
      )}
      {hint ? (
        <ThemedText type="small" themeColor="textSecondary">
          {hint}
        </ThemedText>
      ) : null}
      <ThemedText type="smallBold">{t('setup.scanManual')}</ThemedText>
      <View style={styles.manualRow}>
        <TextInput
          value={typed}
          onChangeText={setTyped}
          placeholder="192.168.1.20:3000"
          placeholderTextColor={theme.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="done"
          onSubmitEditing={submitTyped}
          style={[styles.input, { color: theme.text, backgroundColor: theme.backgroundElement, borderColor: theme.backgroundSelected }]}
        />
        <Pressable
          accessibilityRole="button"
          onPress={submitTyped}
          style={[styles.button, styles.manualButton, { borderColor: theme.primary }]}>
          <ThemedText type="smallBold">{t('setup.next')}</ThemedText>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: Spacing.two },
  cameraFrame: { width: '100%', aspectRatio: 1, borderRadius: Spacing.three, overflow: 'hidden' },
  permission: { gap: Spacing.two, padding: Spacing.three, borderRadius: Spacing.three },
  button: { alignItems: 'center', paddingVertical: Spacing.two, paddingHorizontal: Spacing.three, borderRadius: Spacing.four },
  buttonLabel: { color: '#ffffff' },
  manualRow: { flexDirection: 'row', gap: Spacing.two, alignItems: 'center' },
  input: { flex: 1, borderWidth: 1, borderRadius: Spacing.three, paddingHorizontal: Spacing.three, paddingVertical: Spacing.two },
  manualButton: { borderWidth: 1 },
});
