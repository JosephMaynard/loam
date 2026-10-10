// Byte sizes as the operator reads them. Kept apart from device-capabilities.ts (which loads expo-device)
// so pure modules such as model-download.ts can use it.
import { t } from './i18n';

/** Human-readable byte size (binary units, matching how RAM/storage are usually quoted); "unknown" for null. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) {
    return t('common.unknown');
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const decimals = unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}
