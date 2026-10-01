import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { t } from '@/lib/i18n';
import { parseScannedCode } from '@/lib/join-code';
import type { SetupPeer } from '@/lib/setup';

/**
 * Scan another LOAM network's "Link a node" code (setup's "Join another LOAM network"). Asks for the camera
 * only when shown, reads QR codes only, and stops at the first link code. Anything else gets a pointer to
 * what to do: an ordinary join code (that's for people; ask for the link code), or the hotspot's Wi-Fi
 * code (join that Wi-Fi in the phone's settings first). There is deliberately no typed alternative: the
 * link code has to come from the other network's screen.
 */
export function CodeScanner({ onFound }: { onFound: (peer: SetupPeer) => void }) {
  const theme = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [hint, setHint] = useState<string>();
  // The camera reports the same code many times a second; act on the first LOAM one only.
  const done = useRef(false);

  function onScanned(data: string): void {
    if (done.current) {
      return;
    }
    const code = parseScannedCode(data);
    if (code.kind === 'link') {
      done.current = true;
      onFound({ url: code.url, transportKey: code.transportKey, linkCode: code.linkCode });
    } else {
      setHint(
        code.kind === 'wifi'
          ? t('setup.scanWifi', { network: code.ssid })
          : code.kind === 'join'
            ? t('setup.scanJoinCode')
            : t('setup.scanOther'),
      );
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: Spacing.two },
  cameraFrame: { width: '100%', aspectRatio: 1, borderRadius: Spacing.three, overflow: 'hidden' },
  permission: { gap: Spacing.two, padding: Spacing.three, borderRadius: Spacing.three },
  button: { alignItems: 'center', paddingVertical: Spacing.two, paddingHorizontal: Spacing.three, borderRadius: Spacing.four },
  buttonLabel: { color: '#ffffff' },
});
