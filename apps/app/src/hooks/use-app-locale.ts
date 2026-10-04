// React/SecureStore wiring for the host app's interface language (src/lib/i18n). Module-scoped, so every
// screen shares one choice and storage is read once per process.
import * as SecureStore from 'expo-secure-store';
import { useEffect, useSyncExternalStore } from 'react';

import '@/lib/i18n/catalogs';
import { getAppLocale, parseAppLocale, setAppLocale, subscribeAppLocale, type AppLocale } from '@/lib/i18n';

/** Where the language is kept (with the other small host settings, see use-host-mode.ts). */
export const APP_LOCALE_ITEM = 'loam.locale';

let loading: Promise<AppLocale | undefined> | undefined;

/**
 * Read the stored language once per process and apply it. Resolves to the stored language, or undefined
 * when none has been chosen yet (the setup flow then asks). Never rejects.
 */
export function loadAppLocale(): Promise<AppLocale | undefined> {
  loading ??= SecureStore.getItemAsync(APP_LOCALE_ITEM)
    .then((value) => {
      if (value === null) {
        return undefined;
      }
      const locale = parseAppLocale(value);
      setAppLocale(locale);
      return locale;
    })
    .catch(() => undefined);
  return loading;
}

/** Switch language now and remember it (best-effort). */
export function chooseAppLocale(locale: AppLocale): Promise<void> {
  setAppLocale(locale);
  loading = Promise.resolve(locale);
  return SecureStore.setItemAsync(APP_LOCALE_ITEM, locale).catch(() => undefined);
}

/** The active language; re-renders the caller when it changes. */
export function useAppLocale(): AppLocale {
  useEffect(() => {
    void loadAppLocale();
  }, []);
  return useSyncExternalStore(subscribeAppLocale, getAppLocale);
}
