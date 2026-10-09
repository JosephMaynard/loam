// What the operator is told BEFORE a model download starts (docs/30 H4). Catalog models are 0.8 to 4.5 GB;
// a surprise download of that size over mobile data is exactly what Play's guidance (and common sense) says
// must not happen. The app has no network-type API (no expo-network / NetInfo dependency), so the Wi-Fi /
// metered-data warning is shown for EVERY download, not just metered.
import { t } from './i18n';
import type { ShowAlert } from './show-alert';

export type DownloadDisclosure = { title: string; message: string; confirmLabel: string };

/**
 * The confirmation text for downloading `name`, in the app's language. `sizeLabel` is the human-readable
 * size (e.g. "2.3 GB"), or undefined when it isn't known up front (a custom URL).
 */
export function modelDownloadDisclosure(name: string, sizeLabel: string | undefined): DownloadDisclosure {
  const sizeNote = sizeLabel ? t('model.disclosureSize', { size: sizeLabel }) : t('model.disclosureUnknownSize');
  return {
    title: sizeLabel ? t('model.disclosureTitleSized', { name, size: sizeLabel }) : t('model.disclosureTitle', { name }),
    message: t('model.disclosureBody', { sizeNote }),
    confirmLabel: t('model.download'),
  };
}

/**
 * Show the disclosure and start the download ONLY when the operator presses its confirm button — Cancel (or
 * dismissing the dialog) starts nothing. `showAlert` is `Alert.alert` in the app, a mock in the tests.
 */
export function confirmModelDownload(
  showAlert: ShowAlert,
  name: string,
  sizeLabel: string | undefined,
  start: () => void,
): void {
  const text = modelDownloadDisclosure(name, sizeLabel);
  showAlert(text.title, text.message, [
    { text: t('common.cancel'), style: 'cancel' },
    { text: text.confirmLabel, onPress: start },
  ]);
}
